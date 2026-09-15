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

function makeState(file: string, sessionId = "sess-p1"): BeamMemoryState {
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
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 1000,
			proactiveLinking: false,
		} as unknown as BeamMemoryState["config"],
	} as unknown as BeamMemoryState;
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

describe("P1 finding 1: keyed content reuse persists key atomically across restart", () => {
	it("persists idempotency_key on content-duplicate reuse and dedupes across restart", () => {
		const tmp = path.join(os.tmpdir(), `beam-p1-reuse-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
		files.push(tmp);
		const state = makeState(tmp, "sess-a");
		const content = "p1 restart content same string";
		const source = "custom-autolearn";
		const key = `p1-key-${Date.now()}`;

		// First write without key (legacy content)
		const idNoKey = remember(state, content, { source: "conversation" });
		expect(typeof idNoKey).toBe("string");

		// Verify no key yet
		const rowBefore = state.db
			.query("SELECT idempotency_key as k, metadata_json as m FROM working_memory WHERE id = ?")
			.get(idNoKey) as { k: string | null; m: string | null };
		expect(rowBefore.k).toBeNull();

		// Second write same content with key should reuse same row and persist key/source/metadata atomically
		const idKeyed = remember(state, content, { source, idempotencyKey: key });
		expect(idKeyed).toBe(idNoKey);

		const rowAfter = state.db
			.query("SELECT id, idempotency_key as k, metadata_json as m, source as s FROM working_memory WHERE id = ?")
			.get(idNoKey) as { k: string | null; m: string | null; s: string };
		expect(rowAfter.k).toBe(key);
		expect(rowAfter.s).toBe(source);
		expect(rowAfter.m).toContain(key);

		// Simulate restart: close and reopen via openDatabase+initBeam
		state.db.close();
		// Remove from tracking so afterEach doesn't double close
		states.pop();
		const db2 = openDatabase(tmp);
		// initBeam should preserve the persisted key (no duplicate reconciliation needed)
		initBeam(db2);
		const state2: BeamMemoryState = {
			db: db2 as unknown as BeamMemoryState["db"],
			sessionId: "sess-a",
			authorId: null,
			authorType: null,
			channelId: null,
			scoped: {} as never,
			caches: {},
			pluginManager: undefined as never,
			config: {
				workingMemoryLimit: 1000,
				workingMemoryTtlHours: 1000,
				proactiveLinking: false,
			} as unknown as BeamMemoryState["config"],
		} as unknown as BeamMemoryState;
		states.push(state2);

		// Deterministic keyed write after restart should return same id without inserting duplicate
		const idAfterRestart = remember(state2, `${content} different payload but same key should still dedup by key`, {
			source,
			idempotencyKey: key,
		});
		expect(idAfterRestart).toBe(idNoKey);

		const countKey = state2.db
			.query("SELECT COUNT(*) as c FROM working_memory WHERE source = ? AND idempotency_key = ?")
			.get(source, key) as { c: number };
		expect(countKey.c).toBe(1);
		const total = state2.db.query("SELECT COUNT(*) as c FROM working_memory").get() as { c: number };
		expect(total.c).toBe(1);
	});

	it("bypasses content dedup when existing duplicate already has different key", () => {
		const tmp = path.join(os.tmpdir(), `beam-p1-bypass-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
		files.push(tmp);
		const state = makeState(tmp, "sess-b");
		const content = "same content for different keys";
		const source = "custom-autolearn";
		const key1 = `key1-${Date.now()}`;
		const key2 = `key2-${Date.now()}`;

		const id1 = remember(state, content, { source, idempotencyKey: key1 });
		// Same content, same source, different key should create distinct row (bypass content dedup)
		const id2 = remember(state, content, { source, idempotencyKey: key2 });
		expect(id2).not.toBe(id1);

		const c1 = state.db
			.query("SELECT COUNT(*) as c FROM working_memory WHERE source = ? AND idempotency_key = ?")
			.get(source, key1) as { c: number };
		const c2 = state.db
			.query("SELECT COUNT(*) as c FROM working_memory WHERE source = ? AND idempotency_key = ?")
			.get(source, key2) as { c: number };
		expect(c1.c).toBe(1);
		expect(c2.c).toBe(1);
		const total = state.db.query("SELECT COUNT(*) as c FROM working_memory").get() as { c: number };
		expect(total.c).toBe(2);
	});
});

describe("P1 finding 2: migration repoint unique collision rollbacks", () => {
	it("merges graph_edges duplicates and completes migration without rollback", () => {
		const tmp = path.join(os.tmpdir(), `beam-p1-collision-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
		files.push(tmp);

		// Raw DB without initBeam: create minimal working_memory and graph_edges with unique constraint
		const raw = new Database(tmp);
		raw.run(
			"CREATE TABLE IF NOT EXISTS working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT, timestamp TEXT, session_id TEXT DEFAULT 'default', importance REAL DEFAULT 0.5, metadata_json TEXT, idempotency_key TEXT DEFAULT NULL)",
		);
		raw.run(
			"CREATE TABLE IF NOT EXISTS graph_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL, edge_type TEXT NOT NULL, weight REAL DEFAULT 1.0, timestamp TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(source, target, edge_type))",
		);
		// Insert duplicate source+key rows
		const source = "custom-autolearn";
		const key = `collision-key-${Date.now()}`;
		raw.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)",
			["dup-keep", "content keep", source, new Date().toISOString(), "sess-x", key],
		);
		raw.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)",
			["dup-2", "content dup2", source, new Date().toISOString(), "sess-x", key],
		);
		// Insert colliding graph_edges: both have edge to same target with same type but different source -> after repoint would collide
		raw.run("INSERT INTO graph_edges (source, target, edge_type) VALUES (?, ?, ?)", ["dup-keep", "target-X", "ctx"]);
		raw.run("INSERT INTO graph_edges (source, target, edge_type) VALUES (?, ?, ?)", ["dup-2", "target-X", "ctx"]);
		raw.close();

		// Now initBeam should merge the conflicting edge and succeed, keeping one row and one edge
		const db2 = openDatabase(tmp);
		initBeam(db2);
		const cnt = db2
			.query("SELECT COUNT(*) as c FROM working_memory WHERE source = ? AND idempotency_key = ?")
			.get(source, key) as { c: number };
		expect(cnt.c).toBe(1);
		const keep = db2.query("SELECT id FROM working_memory WHERE id = ?").get("dup-keep") as { id: string } | null;
		expect(keep?.id).toBe("dup-keep");
		const dup = db2.query("SELECT id FROM working_memory WHERE id = ?").get("dup-2") as { id: string } | null;
		expect(dup).toBeNull();
		const edgeCnt = db2.query("SELECT COUNT(*) as c FROM graph_edges").get() as { c: number };
		expect(edgeCnt.c).toBe(1);
		const edge = db2.query("SELECT source, target, edge_type FROM graph_edges").get() as {
			source: string;
			target: string;
			edge_type: string;
		};
		expect(edge.source).toBe("dup-keep");
		expect(edge.target).toBe("target-X");
		// Unique index must now exist
		const idx = db2
			.query("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_wm_source_idempotency_unique'")
			.get() as { sql: string } | null;
		expect(idx?.sql).toContain("UNIQUE");
		db2.close();
		try {
			fs.unlinkSync(`${tmp}-wal`);
		} catch {}
		try {
			fs.unlinkSync(`${tmp}-shm`);
		} catch {}
		const idxFile = files.indexOf(tmp);
		if (idxFile >= 0) files.splice(idxFile, 1);
	});

	it("merges annotation UNIQUE collision before repoint, preserving keep row and removing duplicate only after links safe", () => {
		const tmp = path.join(
			os.tmpdir(),
			`beam-p1-annot-collision-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
		);
		files.push(tmp);

		// Raw DB without initBeam: create working_memory + annotations with UNIQUE(memory_id,kind,value)
		const raw = new Database(tmp);
		raw.run(
			"CREATE TABLE IF NOT EXISTS working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT, timestamp TEXT, session_id TEXT DEFAULT 'default', importance REAL DEFAULT 0.5, metadata_json TEXT, idempotency_key TEXT DEFAULT NULL)",
		);
		raw.run(
			"CREATE TABLE IF NOT EXISTS annotations (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, source TEXT, confidence REAL DEFAULT 1.0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
		);
		raw.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_annot_unique ON annotations(memory_id, kind, value)");
		// Also create tables that initBeam expects to avoid missing-table warnings for other repoint steps
		raw.run(
			"CREATE TABLE IF NOT EXISTS memory_embeddings (memory_id TEXT PRIMARY KEY, embedding_json TEXT NOT NULL, model TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
		);
		raw.run(
			"CREATE TABLE IF NOT EXISTS gists (id TEXT PRIMARY KEY, text TEXT NOT NULL, timestamp TEXT, participants_json TEXT, location TEXT, emotion TEXT, time_scope TEXT, memory_id TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
		);
		raw.run(
			"CREATE TABLE IF NOT EXISTS graph_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL, edge_type TEXT NOT NULL, weight REAL DEFAULT 1.0, timestamp TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(source, target, edge_type))",
		);

		const source = "custom-autolearn";
		const key = `annot-collision-${Date.now()}`;
		raw.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)",
			["keep-annot", "keep content", source, new Date().toISOString(), "sess-annot", key],
		);
		raw.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)",
			["dup-annot", "dup content", source, new Date().toISOString(), "sess-annot", key],
		);
		// Both memories share same annotation (kind,value) which would violate UNIQUE after repoint if not merged
		raw.run("INSERT INTO annotations (memory_id, kind, value, source) VALUES (?, ?, ?, ?)", [
			"keep-annot",
			"mentions",
			"Alice",
			"extractor",
		]);
		raw.run("INSERT INTO annotations (memory_id, kind, value, source) VALUES (?, ?, ?, ?)", [
			"dup-annot",
			"mentions",
			"Alice",
			"extractor",
		]);
		// Dup also has a distinct annotation that should be repointed
		raw.run("INSERT INTO annotations (memory_id, kind, value, source) VALUES (?, ?, ?, ?)", [
			"dup-annot",
			"mentions",
			"Bob",
			"extractor",
		]);
		raw.close();

		const db2 = openDatabase(tmp);
		// initBeam must succeed despite the UNIQUE collision on annotations
		let threw = false;
		try {
			initBeam(db2);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);

		// One annotation (Alice) remains for keep, duplicate removed; Bob repointed to keep
		const annots = db2.query("SELECT memory_id, kind, value FROM annotations ORDER BY value").all() as Array<{
			memory_id: string;
			kind: string;
			value: string;
		}>;
		expect(annots).toEqual([
			{ memory_id: "keep-annot", kind: "mentions", value: "Alice" },
			{ memory_id: "keep-annot", kind: "mentions", value: "Bob" },
		]);
		expect(annots.length).toBe(2);
		// No annotation should still reference dup-annot
		const dupAnnotCnt = db2.query("SELECT COUNT(*) as c FROM annotations WHERE memory_id = ?").get("dup-annot") as {
			c: number;
		};
		expect(dupAnnotCnt.c).toBe(0);

		// Duplicate memory must have been removed only after links safe
		const cnt = db2
			.query("SELECT COUNT(*) as c FROM working_memory WHERE source = ? AND idempotency_key = ?")
			.get(source, key) as { c: number };
		expect(cnt.c).toBe(1);
		const keep = db2.query("SELECT id FROM working_memory WHERE id = ?").get("keep-annot") as { id: string } | null;
		expect(keep?.id).toBe("keep-annot");
		const dup = db2.query("SELECT id FROM working_memory WHERE id = ?").get("dup-annot") as { id: string } | null;
		expect(dup).toBeNull();

		// Unique idempotency index creation must have succeeded
		const idx = db2
			.query("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_wm_source_idempotency_unique'")
			.get() as { sql: string } | null;
		expect(idx?.sql).toContain("UNIQUE");

		db2.close();
		try {
			fs.unlinkSync(`${tmp}-wal`);
		} catch {}
		try {
			fs.unlinkSync(`${tmp}-shm`);
		} catch {}
		const idxFile = files.indexOf(tmp);
		if (idxFile >= 0) files.splice(idxFile, 1);
	});
});
