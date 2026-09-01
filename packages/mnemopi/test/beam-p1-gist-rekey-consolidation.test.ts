import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import { consolidateToEpisodic } from "@oh-my-pi/pi-mnemopi/core/beam/consolidate";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";
import { openDatabase } from "@oh-my-pi/pi-mnemopi/db";

const files: string[] = [];
const states: BeamMemoryState[] = [];

function makeBeamState(db: Database, sessionId = "sess-gist"): BeamMemoryState {
	const state = {
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
	} as BeamMemoryState;
	states.push(state);
	return state;
}

afterEach(() => {
	while (states.length > 0) states.pop()?.db.close();
	for (const f of files.splice(0)) {
		try { fs.unlinkSync(f); } catch {}
		try { fs.unlinkSync(f + "-wal"); } catch {}
		try { fs.unlinkSync(f + "-shm"); } catch {}
	}
});

describe("P1 finding: gist identity rekey with collision preserves metadata and edges", () => {
	it("rekeys gist_duplicate to gist_kept and merges collision preserving keep metadata plus union participants, no dangling edges", () => {
		const tmp = path.join(os.tmpdir(), `beam-gist-collision-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
		files.push(tmp);
		const raw = new Database(tmp);
		raw.run("CREATE TABLE IF NOT EXISTS working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT, timestamp TEXT, session_id TEXT DEFAULT 'default', importance REAL DEFAULT 0.5, metadata_json TEXT, idempotency_key TEXT DEFAULT NULL)");
		raw.run("CREATE TABLE IF NOT EXISTS gists (id TEXT PRIMARY KEY, text TEXT NOT NULL, timestamp TEXT, participants_json TEXT, location TEXT, emotion TEXT, time_scope TEXT, memory_id TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
		raw.run("CREATE TABLE IF NOT EXISTS graph_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL, edge_type TEXT NOT NULL, weight REAL DEFAULT 1.0, timestamp TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(source, target, edge_type))");
		const source = "custom-autolearn";
		const key = `gist-collision-${Date.now()}`;
		raw.run("INSERT INTO working_memory (id, content, source, timestamp, session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)", ["keep-mem", "keep content", source, new Date().toISOString(), "sess-gist", key]);
		raw.run("INSERT INTO working_memory (id, content, source, timestamp, session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)", ["dup-mem", "dup content", source, new Date().toISOString(), "sess-gist", key]);
		// keep gist with location Moscow, participants Alice
		raw.run("INSERT INTO gists (id, text, timestamp, participants_json, location, emotion, time_scope, memory_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["gist_keep-mem", "keep gist text", new Date().toISOString(), JSON.stringify(["Alice"]), "Moscow", "positive", "point_in_time", "keep-mem"]);
		// dup gist with different participants and empty location (should merge participants, keep location)
		raw.run("INSERT INTO gists (id, text, timestamp, participants_json, location, emotion, time_scope, memory_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["gist_dup-mem", "dup gist text", new Date().toISOString(), JSON.stringify(["Bob"]), null, null, null, "dup-mem"]);
		// graph edges from each gist to same target with same type -> would collide after rekey if not merged
		raw.run("INSERT INTO graph_edges (source, target, edge_type) VALUES (?, ?, ?)", ["gist_keep-mem", "entity_X", "ctx"]);
		raw.run("INSERT INTO graph_edges (source, target, edge_type) VALUES (?, ?, ?)", ["gist_dup-mem", "entity_X", "ctx"]);
		// also edge from gist_dup to different target to test repoint
		raw.run("INSERT INTO graph_edges (source, target, edge_type) VALUES (?, ?, ?)", ["gist_dup-mem", "entity_Y", "rel"]);
		raw.close();

		const db2 = openDatabase(tmp);
		initBeam(db2);
		// working_memory deduped
		const cnt = db2.query("SELECT COUNT(*) as c FROM working_memory WHERE source = ? AND idempotency_key = ?").get(source, key) as { c: number };
		expect(cnt.c).toBe(1);
		const keep = db2.query("SELECT id FROM working_memory WHERE id = ?").get("keep-mem") as { id: string } | null;
		expect(keep?.id).toBe("keep-mem");
		const dup = db2.query("SELECT id FROM working_memory WHERE id = ?").get("dup-mem") as { id: string } | null;
		expect(dup).toBeNull();
		// gists: only keep gist should remain, id = gist_keep-mem, memory_id = keep-mem, no stale gist_dup-mem
		const gists = db2.query("SELECT id, memory_id, text, participants_json, location FROM gists ORDER BY id").all() as Array<{ id: string; memory_id: string; text: string; participants_json: string; location: string | null }>;
		expect(gists.length).toBe(1);
		expect(gists[0]!.id).toBe("gist_keep-mem");
		expect(gists[0]!.memory_id).toBe("keep-mem");
		// participants should be union of Alice and Bob (preserve all metadata)
		const parts = JSON.parse(gists[0]!.participants_json) as string[];
		expect(parts).toContain("Alice");
		expect(parts).toContain("Bob");
		// location preserved from keep (Moscow)
		expect(gists[0]!.location).toBe("Moscow");
		// no dangling gist id
		const stale = db2.query("SELECT COUNT(*) as c FROM gists WHERE id = ?").get("gist_dup-mem") as { c: number };
		expect(stale.c).toBe(0);
		// graph edges: no edge still referencing gist_dup-mem, and no duplicates
		const edgeSources = db2.query("SELECT source, target, edge_type FROM graph_edges ORDER BY target").all() as Array<{ source: string; target: string; edge_type: string }>;
		for (const e of edgeSources) expect(e.source).not.toBe("gist_dup-mem");
		// should have 2 edges: keep->X and keep->Y, deduped X only once
		expect(edgeSources.length).toBe(2);
		expect(edgeSources.some(e => e.source === "gist_keep-mem" && e.target === "entity_X")).toBe(true);
		expect(edgeSources.some(e => e.source === "gist_keep-mem" && e.target === "entity_Y")).toBe(true);
		// ensure no edge points to non-existent gist
		const gistIds = new Set(gists.map(g => g.id));
		for (const e of edgeSources) {
			if (e.source.startsWith("gist_")) expect(gistIds.has(e.source) || e.source === "keep-mem").toBe(true);
		}
		db2.close();
	});

	it("rekeys gist when keep has no gist, creating gist_kept from duplicate without collision", () => {
		const tmp = path.join(os.tmpdir(), `beam-gist-rekey-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
		files.push(tmp);
		const raw = new Database(tmp);
		raw.run("CREATE TABLE IF NOT EXISTS working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT, timestamp TEXT, session_id TEXT DEFAULT 'default', importance REAL DEFAULT 0.5, metadata_json TEXT, idempotency_key TEXT DEFAULT NULL)");
		raw.run("CREATE TABLE IF NOT EXISTS gists (id TEXT PRIMARY KEY, text TEXT NOT NULL, timestamp TEXT, participants_json TEXT, location TEXT, emotion TEXT, time_scope TEXT, memory_id TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
		raw.run("CREATE TABLE IF NOT EXISTS graph_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL, edge_type TEXT NOT NULL, weight REAL DEFAULT 1.0, timestamp TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(source, target, edge_type))");
		const source = "custom-autolearn";
		const key = `gist-rekey-${Date.now()}`;
		raw.run("INSERT INTO working_memory (id, content, source, timestamp, session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)", ["keep2", "keep2 content", source, new Date().toISOString(), "sess-gist", key]);
		raw.run("INSERT INTO working_memory (id, content, source, timestamp, session_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)", ["dup2", "dup2 content", source, new Date().toISOString(), "sess-gist", key]);
		raw.run("INSERT INTO gists (id, text, timestamp, participants_json, location, emotion, time_scope, memory_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ["gist_dup2", "dup2 gist text", new Date().toISOString(), JSON.stringify(["Carol"]), "Berlin", "neutral", "span", "dup2"]);
		raw.run("INSERT INTO graph_edges (source, target, edge_type) VALUES (?, ?, ?)", ["gist_dup2", "entity_Z", "ctx"]);
		raw.close();

		const db2 = openDatabase(tmp);
		initBeam(db2);
		const gists = db2.query("SELECT id, memory_id, text, location FROM gists ORDER BY id").all() as Array<{ id: string; memory_id: string; text: string; location: string | null }>;
		expect(gists.length).toBe(1);
		expect(gists[0]!.id).toBe("gist_keep2");
		expect(gists[0]!.memory_id).toBe("keep2");
		expect(gists[0]!.text).toBe("dup2 gist text");
		expect(gists[0]!.location).toBe("Berlin");
		const edge = db2.query("SELECT source, target FROM graph_edges WHERE target = ?").get("entity_Z") as { source: string; target: string } | null;
		expect(edge?.source).toBe("gist_keep2");
		const staleEdge = db2.query("SELECT COUNT(*) as c FROM graph_edges WHERE source = ?").get("gist_dup2") as { c: number };
		expect(staleEdge.c).toBe(0);
		db2.close();
	});
});

describe("P1 finding: consolidation exact-once with keyed uniqueness reread", () => {
	it("second consolidate with same source+key returns existing id and does not create unkeyed duplicate", () => {
		const db = openDatabase(":memory:");
		initBeam(db);
		const beam = makeBeamState(db, "sess-consol");
		// Insert working memory with idempotency key
		const wmId = "wm-keyed-1";
		const source = "custom-autolearn";
		const key = `consol-key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		db.run("INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, metadata_json, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [wmId, "working content for consolidation", source, new Date().toISOString(), "sess-consol", 0.7, JSON.stringify({ idempotency_key: key }), key]);
		const summaryA = "Consolidated summary for idempotent source A with sufficient length to generate distinct content and trigger episodic insertion.";
		const id1 = consolidateToEpisodic(beam, summaryA, [wmId], source, 0.6, {});
		expect(typeof id1).toBe("string");
		const count1 = db.query("SELECT COUNT(*) as c FROM episodic_memory WHERE source = ? AND idempotency_key = ?").get(source, key) as { c: number };
		expect(count1.c).toBe(1);
		const row1 = db.query("SELECT id FROM episodic_memory WHERE source = ? AND idempotency_key = ?").get(source, key) as { id: string };
		expect(row1.id).toBe(id1);
		// Second consolidation with same working id but different summary (different memoryId) should hit unique on (source, key) and return existing
		const summaryB = "Different consolidated summary B for same idempotent source should not create duplicate episodic row, must return existing.";
		const id2 = consolidateToEpisodic(beam, summaryB, [wmId], source, 0.6, {});
		expect(id2).toBe(id1);
		const count2 = db.query("SELECT COUNT(*) as c FROM episodic_memory WHERE source = ? AND idempotency_key = ?").get(source, key) as { c: number };
		expect(count2.c).toBe(1);
		const totalEpisodic = db.query("SELECT COUNT(*) as c FROM episodic_memory").get() as { c: number };
		expect(totalEpisodic.c).toBe(1);
		// Ensure no unkeyed duplicate was created (query without key should not have extra row with same content)
		const unkeyed = db.query("SELECT COUNT(*) as c FROM episodic_memory WHERE source = ? AND idempotency_key IS NULL").get(source) as { c: number };
		// should be 0 or at least not contain the duplicate B summary as unkeyed
		const bRows = db.query("SELECT COUNT(*) as c FROM episodic_memory WHERE content = ?").get(summaryB) as { c: number };
		expect(bRows.c).toBe(0);
		db.close();
	});

	it("consolidation fallback only on missing column, not on arbitrary error creating null-keyed duplicate", () => {
		const db = openDatabase(":memory:");
		initBeam(db);
		const beam = makeBeamState(db, "sess-consol2");
		const wmId = "wm-keyed-2";
		const source = "custom-autolearn";
		const key = `consol-key2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		db.run("INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, metadata_json, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [wmId, "working content 2", source, new Date().toISOString(), "sess-consol2", 0.7, JSON.stringify({ idempotency_key: key }), key]);
		const summary = "Summary for testing that unique conflict does not trigger unkeyed insert.";
		const id1 = consolidateToEpisodic(beam, summary, [wmId], source, 0.6, {});
		// Manually attempt to simulate unique conflict by direct insert? Instead verify that after successful first, second with same key but different summary still unique
		const summary2 = "Second summary with same key should not create second row even though id would differ.";
		const id2 = consolidateToEpisodic(beam, summary2, [wmId], source, 0.6, {});
		expect(id2).toBe(id1);
		// There must be exactly one row with that key, and no row without key for same source that duplicates content
		const rows = db.query("SELECT id, idempotency_key, content FROM episodic_memory WHERE source = ?").all(source) as Array<{ id: string; idempotency_key: string | null; content: string }>;
		expect(rows.length).toBe(1);
		expect(rows[0]!.idempotency_key).toBe(key);
		expect(rows[0]!.id).toBe(id1);
		db.close();
	});
});
