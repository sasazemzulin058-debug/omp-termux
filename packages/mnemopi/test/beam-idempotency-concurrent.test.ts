import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import { remember } from "@oh-my-pi/pi-mnemopi/core/beam/store";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";
import { openDatabase } from "@oh-my-pi/pi-mnemopi/db";

const states: BeamMemoryState[] = [];
const files: string[] = [];

function makeState(file: string, sessionId = "sess-conc"): BeamMemoryState {
	const db = openDatabase(file);
	initBeam(db);
	const state: BeamMemoryState = {
		db: db as unknown as BeamMemoryState["db"],
		sessionId,
		authorId: null,
		authorType: null,
		channelId: null,
		scoped: {} as never,
		caches: {},
		pluginManager: undefined as never,
		config: {
			sessionId,
			embeddingModel: "none",
			embeddingBatch: 0,
		} as unknown as BeamMemoryState["config"],
	} as BeamMemoryState;
	states.push(state);
	return state;
}

afterEach(() => {
	while (states.length > 0) states.pop()?.db.close();
	for (const f of files.splice(0)) {
		try {
			fs.unlinkSync(f);
		} catch {}
		try {
			fs.unlinkSync(`${f}-wal`);
		} catch {}
		try {
			fs.unlinkSync(`${f}-shm`);
		} catch {}
	}
});

describe("beam idempotency concurrent and unique constraint", () => {
	it("concurrent duplicate source+key via shared file returns same id and single row (race-safe via unique partial index)", () => {
		const tmp = path.join(os.tmpdir(), `beam-idem-conc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
		files.push(tmp);
		const stateA = makeState(tmp, "sess-a");
		const stateB = makeState(tmp, "sess-b");
		const key = `idem-concurrent-${Date.now()}`;
		const content = "concurrent content for idempotency test";
		const source = "custom-autolearn";

		// Verify unique partial index exists
		const idxWm = stateA.db
			.query("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_wm_source_idempotency_unique'")
			.get() as { name: string; sql: string } | null;
		expect(idxWm).not.toBeNull();
		expect(idxWm?.sql).toContain("UNIQUE");
		expect(idxWm?.sql).toContain("WHERE");
		const idxEm = stateA.db
			.query("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_em_source_idempotency_unique'")
			.get() as { name: string; sql: string } | null;
		expect(idxEm).not.toBeNull();

		// First write
		const idA = remember(stateA, content, { source, idempotencyKey: key });
		expect(typeof idA).toBe("string");
		expect(idA.length).toBeGreaterThan(0);

		// Second write from different connection + same source+key + different content should return same id (idempotency, not new row)
		const idB = remember(stateB, `${content} different payload but same key should still dedup`, {
			source,
			idempotencyKey: key,
		});
		expect(idB).toBe(idA);

		// Different source with same key should create distinct row (source is part of unique key)
		const idC = remember(stateB, content, { source: `${source}-other`, idempotencyKey: key });
		expect(idC).not.toBe(idA);

		// Count rows with original source+key = 1
		const rowCount = stateA.db
			.query("SELECT COUNT(*) as c FROM working_memory WHERE source = ? AND idempotency_key = ?")
			.get(source, key) as { c: number };
		expect(rowCount.c).toBe(1);

		// Raw duplicate insert should fail with UNIQUE constraint and be handled by re-reading
		// Attempt direct SQL duplicate should throw
		let threw = false;
		try {
			stateA.db.run(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, metadata_json, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				["raw-dup-id", content, source, new Date().toISOString(), "sess-a", 0.5, null, key],
			);
		} catch (e) {
			threw = true;
			expect(String(e)).toContain("UNIQUE");
		}
		expect(threw).toBe(true);

		// Empty key should not be constrained (partial index excludes empty)
		const emptyKey = "";
		const idEmpty1 = remember(stateA, "empty key content 1", { source, idempotencyKey: emptyKey });
		const idEmpty2 = remember(stateA, "empty key content 2", { source, idempotencyKey: emptyKey });
		// Empty keys are treated as null internally, so they don't dedup via idempotency; they may dedup via content? Use distinct content
		expect(idEmpty1).not.toBe(idEmpty2);

		// Null/undefined key also not constrained - content dedup still applies
		const idNoKey1 = remember(stateA, "no key content", { source });
		const idNoKey2 = remember(stateA, "no key content", { source });
		expect(idNoKey2).toBe(idNoKey1); // content dedup, not idempotency
	});

	it("migration reconciles legacy duplicates deterministically and reports", () => {
		const tmp = path.join(os.tmpdir(), `beam-dedupe-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
		files.push(tmp);
		// Create DB without initBeam, manually create table and insert duplicates before unique index
		const raw = new Database(tmp);
		raw.run(
			"CREATE TABLE IF NOT EXISTS working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT, timestamp TEXT, session_id TEXT DEFAULT 'default', importance REAL DEFAULT 0.5, metadata_json TEXT, idempotency_key TEXT DEFAULT NULL)",
		);
		// Insert two rows with same source+key (allowed before unique constraint)
		raw.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)",
			["dup-1", "content dup", "custom-autolearn", new Date().toISOString(), "sess-dup", "legacy-dup-key"],
		);
		raw.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)",
			["dup-2", "content dup 2", "custom-autolearn", new Date().toISOString(), "sess-dup", "legacy-dup-key"],
		);
		raw.close();

		// Now initBeam should reconcile (keep earliest rowid) and create unique index
		const db2 = openDatabase(tmp);
		let warned = false;
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			if (String(args[0]).includes("idempotency duplicates")) warned = true;
			origWarn(...(args as never[]));
		};
		try {
			initBeam(db2);
		} finally {
			console.warn = origWarn;
		}
		// Should have warned/logged and kept one row
		expect(warned).toBe(true);
		const count = db2
			.query("SELECT COUNT(*) as c FROM working_memory WHERE source = ? AND idempotency_key = ?")
			.get("custom-autolearn", "legacy-dup-key") as { c: number };
		expect(count.c).toBe(1);
		const remaining = db2
			.query("SELECT id FROM working_memory WHERE source = ? AND idempotency_key = ?")
			.get("custom-autolearn", "legacy-dup-key") as { id: string };
		expect(remaining.id).toBe("dup-1"); // earliest rowid kept
		// Unique index now exists
		const idx = db2
			.query("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_wm_source_idempotency_unique'")
			.get() as { sql: string } | null;
		expect(idx?.sql).toContain("UNIQUE");
		db2.close();

		// Re-open and verify concurrent remember still returns kept id
		const state = makeState(tmp, "sess-check");
		const id = remember(state, "any content", { source: "custom-autolearn", idempotencyKey: "legacy-dup-key" });
		expect(id).toBe("dup-1");
	});
});
