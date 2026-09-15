import type { Database } from "bun:sqlite";

type PragmaTableInfoRow = {
	name: string;
};

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): boolean {
	const rows = db.query(`PRAGMA table_info(${table})`).all() as PragmaTableInfoRow[];
	for (const row of rows) {
		if (row.name === column) {
			return false;
		}
	}
	db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	return true;
}

function runAll(db: Database, statements: readonly string[]): void {
	for (const statement of statements) {
		db.run(statement);
	}
}
function tableExistsForMigration(db: Database, table: string): boolean {
	try {
		const row = db
			.query("SELECT 1 FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ? LIMIT 1")
			.get(table) as unknown;
		return row != null;
	} catch {
		return false;
	}
}
function countRowsForMigration(db: Database, sql: string, ...params: unknown[]): number {
	try {
		const row = db.query(sql).get(...(params as never[])) as { c: number } | null | undefined;
		return row?.c ?? 0;
	} catch {
		return 0;
	}
}
function reconcileIdempotencyDuplicates(db: Database, table: "working_memory" | "episodic_memory"): void {
	try {
		db.run(
			`UPDATE ${table} SET idempotency_key = json_extract(metadata_json, '$.idempotency_key') WHERE idempotency_key IS NULL AND json_extract(metadata_json, '$.idempotency_key') IS NOT NULL AND json_extract(metadata_json, '$.idempotency_key') != ''`,
		);
	} catch {}
	try {
		const dupes = db
			.query(
				`SELECT source, idempotency_key, COUNT(*) as cnt, MIN(rowid) as keep_rowid FROM ${table} WHERE idempotency_key IS NOT NULL AND idempotency_key != '' GROUP BY source, idempotency_key HAVING cnt > 1`,
			)
			.all() as Array<{ source: string; idempotency_key: string; cnt: number; keep_rowid: number }>;
		if (dupes.length > 0) {
			console.warn(
				`[beam] ${table} idempotency duplicates detected: ${dupes.map(d => `${d.source}:${d.idempotency_key} x${d.cnt}`).join("; ")} - deterministic reconciliation keeping earliest row`,
			);
			for (const d of dupes) {
				try {
					const rows = db
						.query(`SELECT id, rowid FROM ${table} WHERE source = ? AND idempotency_key = ? ORDER BY rowid ASC`)
						.all(d.source, d.idempotency_key) as Array<{ id: string; rowid: number }>;
					if (rows.length <= 1) continue;
					const keep = rows[0]!;
					const dupRows = rows.slice(1);
					const dupIds = dupRows.map(r => r.id);
					const dupPlaceholders = dupIds.map(() => "?").join(", ");
					const memoriaTables = [
						"memoria_facts",
						"memoria_instructions",
						"memoria_kg",
						"memoria_preferences",
						"memoria_timelines",
					] as const;
					const hasLinked =
						memoriaTables.some(
							mt =>
								tableExistsForMigration(db, mt) &&
								countRowsForMigration(
									db,
									`SELECT COUNT(*) as c FROM ${mt} WHERE source_memory_id IN (${dupPlaceholders})`,
									...dupIds,
								) > 0,
						) ||
						(tableExistsForMigration(db, "facts") &&
							countRowsForMigration(
								db,
								`SELECT COUNT(*) as c FROM facts WHERE source_msg_id IN (${dupPlaceholders})`,
								...dupIds,
							) > 0) ||
						(tableExistsForMigration(db, "annotations") &&
							countRowsForMigration(
								db,
								`SELECT COUNT(*) as c FROM annotations WHERE memory_id IN (${dupPlaceholders})`,
								...dupIds,
							) > 0) ||
						(tableExistsForMigration(db, "memory_embeddings") &&
							countRowsForMigration(
								db,
								`SELECT COUNT(*) as c FROM memory_embeddings WHERE memory_id IN (${dupPlaceholders})`,
								...dupIds,
							) > 0) ||
						(tableExistsForMigration(db, "gists") &&
							(() => {
								const dupGistIds = dupIds.map(id => `gist_${id}`);
								const gistPh = dupGistIds.map(() => "?").join(", ");
								return (
									countRowsForMigration(
										db,
										`SELECT COUNT(*) as c FROM gists WHERE memory_id IN (${dupPlaceholders}) OR id IN (${gistPh})`,
										...dupIds,
										...dupGistIds,
									) > 0
								);
							})()) ||
						(tableExistsForMigration(db, "graph_edges") &&
							(() => {
								const allRefs = [...dupIds, ...dupIds.map(id => `gist_${id}`)];
								const refPh = allRefs.map(() => "?").join(", ");
								return (
									countRowsForMigration(
										db,
										`SELECT COUNT(*) as c FROM graph_edges WHERE source IN (${refPh}) OR target IN (${refPh})`,
										...allRefs,
										...allRefs,
									) > 0
								);
							})());
					// Transactionally repoint linked artifacts to keep id, then delete duplicates.
					// If repoint fails, abort deletion for this group to avoid silent loss (fail closed).
					try {
						db.exec("BEGIN IMMEDIATE");
						if (hasLinked) {
							for (const mt of memoriaTables) {
								if (!tableExistsForMigration(db, mt)) continue;
								db.run(`UPDATE ${mt} SET source_memory_id = ? WHERE source_memory_id IN (${dupPlaceholders})`, [
									keep.id,
									...dupIds,
								]);
							}
							if (tableExistsForMigration(db, "facts")) {
								db.run(`UPDATE facts SET source_msg_id = ? WHERE source_msg_id IN (${dupPlaceholders})`, [
									keep.id,
									...dupIds,
								]);
							}
							if (tableExistsForMigration(db, "annotations")) {
								// Transactional annotation conflict merge before repoint:
								// keep's (kind,value) wins; delete colliding dup rows first, then dedup within dup set,
								// then repoint remaining. Preserves one canonical row, no silent loss of keep.
								db.run(
									`DELETE FROM annotations WHERE memory_id IN (${dupPlaceholders}) AND EXISTS (SELECT 1 FROM annotations ka WHERE ka.memory_id = ? AND ka.kind = annotations.kind AND ka.value = annotations.value)`,
									[keep.id, ...dupIds],
								);
								if (dupIds.length > 1) {
									db.run(
										`DELETE FROM annotations WHERE memory_id IN (${dupPlaceholders}) AND id NOT IN (SELECT MIN(id) FROM annotations WHERE memory_id IN (${dupPlaceholders}) GROUP BY kind, value)`,
										[...dupIds, ...dupIds],
									);
								}
								db.run(
									`UPDATE OR IGNORE annotations SET memory_id = ? WHERE memory_id IN (${dupPlaceholders})`,
									[keep.id, ...dupIds],
								);
								db.run(`DELETE FROM annotations WHERE memory_id IN (${dupPlaceholders})`, [...dupIds]);
							}
							if (tableExistsForMigration(db, "memory_embeddings")) {
								const keepHas =
									countRowsForMigration(
										db,
										"SELECT COUNT(*) as c FROM memory_embeddings WHERE memory_id = ?",
										keep.id,
									) > 0;
								if (keepHas) {
									db.run(`DELETE FROM memory_embeddings WHERE memory_id IN (${dupPlaceholders})`, [...dupIds]);
								} else if (dupIds.length > 0) {
									const first = dupIds[0]!;
									db.run("UPDATE memory_embeddings SET memory_id = ? WHERE memory_id = ?", [keep.id, first]);
									if (dupIds.length > 1) {
										const rest = dupIds.slice(1);
										const restPh = rest.map(() => "?").join(", ");
										db.run(`DELETE FROM memory_embeddings WHERE memory_id IN (${restPh})`, [...rest]);
									}
								}
							}
							if (tableExistsForMigration(db, "gists")) {
								const dupGistIds = dupIds.map(id => `gist_${id}`);
								const keepGistId = `gist_${keep.id}`;
								const existingDupGistIds = dupGistIds.filter(
									gid => countRowsForMigration(db, "SELECT COUNT(*) as c FROM gists WHERE id = ?", gid) > 0,
								);
								const keepGistExists =
									countRowsForMigration(db, "SELECT COUNT(*) as c FROM gists WHERE id = ?", keepGistId) > 0;
								if (existingDupGistIds.length > 0) {
									const targetGistId = keepGistExists ? keepGistId : existingDupGistIds[0]!;
									const sourceGistIds = keepGistExists ? existingDupGistIds : existingDupGistIds.slice(1);
									for (const dupId of sourceGistIds) {
										const targetRow = db
											.query(
												"SELECT text, timestamp, participants_json, location, emotion, time_scope FROM gists WHERE id = ?",
											)
											.get(targetGistId) as
											| {
													text: string;
													timestamp: string | null;
													participants_json: string | null;
													location: string | null;
													emotion: string | null;
													time_scope: string | null;
											  }
											| null
											| undefined;
										const dupRow = db
											.query(
												"SELECT text, timestamp, participants_json, location, emotion, time_scope FROM gists WHERE id = ?",
											)
											.get(dupId) as
											| {
													text: string;
													timestamp: string | null;
													participants_json: string | null;
													location: string | null;
													emotion: string | null;
													time_scope: string | null;
											  }
											| null
											| undefined;
										if (targetRow && dupRow) {
											let mergedParticipants = targetRow.participants_json;
											try {
												const a = targetRow.participants_json
													? JSON.parse(targetRow.participants_json)
													: [];
												const b = dupRow.participants_json ? JSON.parse(dupRow.participants_json) : [];
												if (Array.isArray(a) && Array.isArray(b)) {
													const merged = [...new Set([...(a as unknown[]), ...(b as unknown[])])];
													if (merged.length > a.length) mergedParticipants = JSON.stringify(merged);
												}
											} catch {}
											const mergedLocation =
												targetRow.location && String(targetRow.location).trim()
													? targetRow.location
													: dupRow.location;
											const mergedEmotion =
												targetRow.emotion && String(targetRow.emotion).trim()
													? targetRow.emotion
													: dupRow.emotion;
											const mergedTimeScope =
												targetRow.time_scope && String(targetRow.time_scope).trim()
													? targetRow.time_scope
													: dupRow.time_scope;
											const mergedText =
												targetRow.text && String(targetRow.text).trim() ? targetRow.text : dupRow.text;
											const mergedTimestamp =
												targetRow.timestamp && String(targetRow.timestamp).trim()
													? targetRow.timestamp
													: dupRow.timestamp;
											db.run(
												"UPDATE gists SET text = ?, timestamp = ?, participants_json = ?, location = ?, emotion = ?, time_scope = ? WHERE id = ?",
												[
													mergedText,
													mergedTimestamp,
													mergedParticipants,
													mergedLocation,
													mergedEmotion,
													mergedTimeScope,
													targetGistId,
												],
											);
										}
										db.run("DELETE FROM gists WHERE id = ?", [dupId]);
									}
									if (!keepGistExists) {
										db.run("UPDATE gists SET id = ?, memory_id = ? WHERE id = ?", [
											keepGistId,
											keep.id,
											targetGistId,
										]);
									}
								}
								const leftoverGistCnt = countRowsForMigration(
									db,
									`SELECT COUNT(*) as c FROM gists WHERE memory_id IN (${dupPlaceholders}) AND id != ?`,
									...dupIds,
									keepGistId,
								);
								if (leftoverGistCnt > 0) {
									db.run(
										`UPDATE gists SET memory_id = ? WHERE memory_id IN (${dupPlaceholders}) AND id != ?`,
										[keep.id, ...dupIds, keepGistId],
									);
								}
							}
							if (tableExistsForMigration(db, "graph_edges")) {
								// Handle UNIQUE(source,target,edge_type) conflicts consistently: delete colliding
								// dup edges that would duplicate keep, dedup within dup, then repoint with OR IGNORE.
								db.run(
									`DELETE FROM graph_edges WHERE source IN (${dupPlaceholders}) AND EXISTS (SELECT 1 FROM graph_edges ka WHERE ka.source = ? AND ka.target = graph_edges.target AND ka.edge_type = graph_edges.edge_type)`,
									[keep.id, ...dupIds],
								);
								if (dupIds.length > 1) {
									db.run(
										`DELETE FROM graph_edges WHERE source IN (${dupPlaceholders}) AND id NOT IN (SELECT MIN(id) FROM graph_edges WHERE source IN (${dupPlaceholders}) GROUP BY target, edge_type)`,
										[...dupIds, ...dupIds],
									);
								}
								db.run(`UPDATE OR IGNORE graph_edges SET source = ? WHERE source IN (${dupPlaceholders})`, [
									keep.id,
									...dupIds,
								]);
								db.run(`DELETE FROM graph_edges WHERE source IN (${dupPlaceholders})`, [...dupIds]);
								db.run(
									`DELETE FROM graph_edges WHERE target IN (${dupPlaceholders}) AND EXISTS (SELECT 1 FROM graph_edges ka WHERE ka.target = ? AND ka.source = graph_edges.source AND ka.edge_type = graph_edges.edge_type)`,
									[keep.id, ...dupIds],
								);
								if (dupIds.length > 1) {
									db.run(
										`DELETE FROM graph_edges WHERE target IN (${dupPlaceholders}) AND id NOT IN (SELECT MIN(id) FROM graph_edges WHERE target IN (${dupPlaceholders}) GROUP BY source, edge_type)`,
										[...dupIds, ...dupIds],
									);
								}
								db.run(`UPDATE OR IGNORE graph_edges SET target = ? WHERE target IN (${dupPlaceholders})`, [
									keep.id,
									...dupIds,
								]);
								db.run(`DELETE FROM graph_edges WHERE target IN (${dupPlaceholders})`, [...dupIds]);
								const dupGistIds = dupIds.map(id => `gist_${id}`);
								const keepGistId = `gist_${keep.id}`;
								if (dupGistIds.length > 0) {
									const gistPh = dupGistIds.map(() => "?").join(", ");
									db.run(
										`DELETE FROM graph_edges WHERE source IN (${gistPh}) AND EXISTS (SELECT 1 FROM graph_edges ka WHERE ka.source = ? AND ka.target = graph_edges.target AND ka.edge_type = graph_edges.edge_type)`,
										[keepGistId, ...dupGistIds],
									);
									if (dupGistIds.length > 1) {
										db.run(
											`DELETE FROM graph_edges WHERE source IN (${gistPh}) AND id NOT IN (SELECT MIN(id) FROM graph_edges WHERE source IN (${gistPh}) GROUP BY target, edge_type)`,
											[...dupGistIds, ...dupGistIds],
										);
									}
									db.run(`UPDATE OR IGNORE graph_edges SET source = ? WHERE source IN (${gistPh})`, [
										keepGistId,
										...dupGistIds,
									]);
									db.run(`DELETE FROM graph_edges WHERE source IN (${gistPh})`, [...dupGistIds]);
									db.run(
										`DELETE FROM graph_edges WHERE target IN (${gistPh}) AND EXISTS (SELECT 1 FROM graph_edges ka WHERE ka.target = ? AND ka.source = graph_edges.source AND ka.edge_type = graph_edges.edge_type)`,
										[keepGistId, ...dupGistIds],
									);
									if (dupGistIds.length > 1) {
										db.run(
											`DELETE FROM graph_edges WHERE target IN (${gistPh}) AND id NOT IN (SELECT MIN(id) FROM graph_edges WHERE target IN (${gistPh}) GROUP BY source, edge_type)`,
											[...dupGistIds, ...dupGistIds],
										);
									}
									db.run(`UPDATE OR IGNORE graph_edges SET target = ? WHERE target IN (${gistPh})`, [
										keepGistId,
										...dupGistIds,
									]);
									db.run(`DELETE FROM graph_edges WHERE target IN (${gistPh})`, [...dupGistIds]);
								}
								// Repoint graph edges that reference facts which were repointed: fact_ids themselves unchanged, no action needed.
							}
						}
						db.run(`DELETE FROM ${table} WHERE source = ? AND idempotency_key = ? AND rowid != ?`, [
							d.source,
							d.idempotency_key,
							d.keep_rowid,
						]);
						db.exec("COMMIT");
					} catch (txErr) {
						try {
							db.exec("ROLLBACK");
						} catch {}
						console.warn(
							`[beam] ${table} duplicate reconciliation aborted for ${d.source}:${d.idempotency_key} - linked artifacts require manual resolution`,
							txErr,
						);
					}
				} catch (groupErr) {
					console.warn(
						`[beam] ${table} duplicate group handling failed for ${d.source}:${d.idempotency_key}`,
						groupErr,
					);
				}
			}
		}
	} catch (e) {
		if (e instanceof Error && !e.message.includes("no such column") && !e.message.includes("no such table")) throw e;
	}
}

export function initBeam(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS working_memory (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			embed_text TEXT DEFAULT NULL,
			source TEXT,
			timestamp TEXT,
			session_id TEXT DEFAULT 'default',
			importance REAL DEFAULT 0.5,
			metadata_json TEXT,
			veracity TEXT DEFAULT 'unknown',
			memory_type TEXT DEFAULT 'unknown',
			consolidated_at TEXT,
			recall_count INTEGER DEFAULT 0,
			last_recalled TIMESTAMP DEFAULT NULL,
			valid_until TIMESTAMP DEFAULT NULL,
			superseded_by TEXT DEFAULT NULL,
			scope TEXT DEFAULT 'global',
			author_id TEXT DEFAULT NULL,
			author_type TEXT DEFAULT NULL,
			channel_id TEXT DEFAULT NULL,
			trust_tier TEXT DEFAULT 'STATED',
			validator TEXT DEFAULT NULL,
			validated_at TIMESTAMP DEFAULT NULL,
			validation_count INTEGER DEFAULT 0,
			event_date TEXT DEFAULT NULL,
			event_date_precision TEXT DEFAULT 'unknown',
			temporal_tags TEXT DEFAULT '[]',
			corrected_by INTEGER DEFAULT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS episodic_memory (
			rowid INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT UNIQUE NOT NULL,
			content TEXT NOT NULL,
			source TEXT,
			timestamp TEXT,
			session_id TEXT DEFAULT 'default',
			importance REAL DEFAULT 0.5,
			metadata_json TEXT,
			summary_of TEXT DEFAULT '',
			veracity TEXT DEFAULT 'unknown',
			tier INTEGER DEFAULT 1,
			degraded_at TEXT,
			memory_type TEXT DEFAULT 'unknown',
			binary_vector BLOB,
			recall_count INTEGER DEFAULT 0,
			last_recalled TIMESTAMP DEFAULT NULL,
			valid_until TIMESTAMP DEFAULT NULL,
			superseded_by TEXT DEFAULT NULL,
			scope TEXT DEFAULT 'global',
			author_id TEXT DEFAULT NULL,
			author_type TEXT DEFAULT NULL,
			channel_id TEXT DEFAULT NULL,
			trust_tier TEXT DEFAULT 'STATED',
			validator TEXT DEFAULT NULL,
			validated_at TIMESTAMP DEFAULT NULL,
			validation_count INTEGER DEFAULT 0,
			event_date TEXT DEFAULT NULL,
			event_date_precision TEXT DEFAULT 'unknown',
			temporal_tags TEXT DEFAULT '[]',
			corrected_by INTEGER DEFAULT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);

	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_wm_session ON working_memory(session_id)",
		"CREATE INDEX IF NOT EXISTS idx_wm_timestamp ON working_memory(timestamp)",
		"CREATE INDEX IF NOT EXISTS idx_wm_source ON working_memory(source)",
		"CREATE INDEX IF NOT EXISTS idx_em_session ON episodic_memory(session_id)",
		"CREATE INDEX IF NOT EXISTS idx_em_timestamp ON episodic_memory(timestamp)",
		"CREATE INDEX IF NOT EXISTS idx_em_source ON episodic_memory(source)",
	]);

	addColumnIfMissing(db, "episodic_memory", "tier", "INTEGER DEFAULT 1");
	addColumnIfMissing(db, "episodic_memory", "degraded_at", "TEXT");
	db.run("CREATE INDEX IF NOT EXISTS idx_em_tier ON episodic_memory(tier)");
	addColumnIfMissing(db, "working_memory", "veracity", "TEXT DEFAULT 'unknown'");
	addColumnIfMissing(db, "episodic_memory", "veracity", "TEXT DEFAULT 'unknown'");
	addColumnIfMissing(db, "working_memory", "memory_type", "TEXT DEFAULT 'unknown'");
	addColumnIfMissing(db, "working_memory", "embed_text", "TEXT DEFAULT NULL");
	addColumnIfMissing(db, "episodic_memory", "memory_type", "TEXT DEFAULT 'unknown'");
	addColumnIfMissing(db, "episodic_memory", "binary_vector", "BLOB");
	const consolidatedAtAdded = addColumnIfMissing(db, "working_memory", "consolidated_at", "TEXT");
	if (consolidatedAtAdded) {
		db.run("UPDATE working_memory SET consolidated_at = ? WHERE consolidated_at IS NULL", [new Date().toISOString()]);
	}
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_wm_unconsolidated ON working_memory(session_id, timestamp) WHERE consolidated_at IS NULL",
	);

	db.run(`
		CREATE TABLE IF NOT EXISTS scratchpad (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			session_id TEXT DEFAULT 'default',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);
	db.run("CREATE INDEX IF NOT EXISTS idx_sp_session ON scratchpad(session_id)");

	db.run(`
		CREATE VIRTUAL TABLE IF NOT EXISTS fts_episodes USING fts5(
			content,
			content='episodic_memory',
			content_rowid='rowid'
		)
	`);
	db.run(`
		CREATE VIRTUAL TABLE IF NOT EXISTS fts_working USING fts5(
			id UNINDEXED,
			content
		)
	`);
	runAll(db, [
		`CREATE TRIGGER IF NOT EXISTS em_ai AFTER INSERT ON episodic_memory BEGIN
			INSERT INTO fts_episodes(rowid, content) VALUES (new.rowid, new.content);
		END`,
		`CREATE TRIGGER IF NOT EXISTS em_ad AFTER DELETE ON episodic_memory BEGIN
			INSERT INTO fts_episodes(fts_episodes, rowid, content) VALUES ('delete', old.rowid, old.content);
		END`,
		`CREATE TRIGGER IF NOT EXISTS em_au AFTER UPDATE ON episodic_memory BEGIN
			INSERT INTO fts_episodes(fts_episodes, rowid, content) VALUES ('delete', old.rowid, old.content);
			INSERT INTO fts_episodes(rowid, content) VALUES (new.rowid, new.content);
		END`,
		"DROP TRIGGER IF EXISTS wm_ai",
		`CREATE TRIGGER IF NOT EXISTS wm_ai AFTER INSERT ON working_memory BEGIN
			INSERT INTO fts_working(id, content) VALUES (new.id, COALESCE(new.embed_text, new.content));
		END`,
		`CREATE TRIGGER IF NOT EXISTS wm_ad AFTER DELETE ON working_memory BEGIN
			DELETE FROM fts_working WHERE id = old.id;
		END`,
		"DROP TRIGGER IF EXISTS wm_au",
		`CREATE TRIGGER IF NOT EXISTS wm_au AFTER UPDATE OF content, embed_text ON working_memory BEGIN
			DELETE FROM fts_working WHERE id = old.id;
			INSERT INTO fts_working(id, content) VALUES (new.id, COALESCE(new.embed_text, new.content));
		END`,
	]);

	db.run(`
		CREATE TABLE IF NOT EXISTS memoria_facts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT DEFAULT 'default',
			message_idx INTEGER,
			fact_type TEXT,
			key TEXT,
			value TEXT,
			context_snippet TEXT,
			importance REAL DEFAULT 0.5,
			timestamp TEXT,
			version_id INTEGER DEFAULT 0,
			previous_value TEXT,
			updated_msg_idx INTEGER,
			valid_from_msg_idx INTEGER,
			valid_to_msg_idx INTEGER,
			source_memory_id TEXT
		)
	`);
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_facts_key ON memoria_facts(key)",
		"CREATE INDEX IF NOT EXISTS idx_facts_type ON memoria_facts(fact_type)",
		"CREATE INDEX IF NOT EXISTS idx_facts_session ON memoria_facts(session_id)",
	]);
	addColumnIfMissing(db, "memoria_facts", "version_id", "INTEGER DEFAULT 0");
	addColumnIfMissing(db, "memoria_facts", "previous_value", "TEXT");
	addColumnIfMissing(db, "memoria_facts", "updated_msg_idx", "INTEGER");
	addColumnIfMissing(db, "memoria_facts", "valid_from_msg_idx", "INTEGER");
	addColumnIfMissing(db, "memoria_facts", "valid_to_msg_idx", "INTEGER");
	addColumnIfMissing(db, "memoria_facts", "source_memory_id", "TEXT");

	db.run(`
		CREATE TABLE IF NOT EXISTS memoria_timelines (
			event_id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT DEFAULT 'default',
			date TEXT,
			message_idx INTEGER,
			description TEXT,
			source TEXT,
			source_memory_id TEXT
		)
	`);
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_timelines_date ON memoria_timelines(date)",
		"CREATE INDEX IF NOT EXISTS idx_timelines_session ON memoria_timelines(session_id)",
	]);
	db.run(`
		CREATE TABLE IF NOT EXISTS memoria_instructions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT DEFAULT 'default',
			message_idx INTEGER,
			instruction TEXT,
			active INTEGER DEFAULT 1,
			topic TEXT,
			context_snippet TEXT,
			source_memory_id TEXT
		)
	`);
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_instr_session ON memoria_instructions(session_id)",
		"CREATE INDEX IF NOT EXISTS idx_instr_active ON memoria_instructions(active)",
	]);
	db.run(`
		CREATE TABLE IF NOT EXISTS memoria_preferences (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT DEFAULT 'default',
			message_idx INTEGER,
			preference TEXT,
			topic TEXT,
			evolution TEXT,
			context_snippet TEXT,
			source_memory_id TEXT
		)
	`);
	db.run("CREATE INDEX IF NOT EXISTS idx_pref_session ON memoria_preferences(session_id)");
	db.run(`
		CREATE TABLE IF NOT EXISTS memoria_kg (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT DEFAULT 'default',
			subject TEXT,
			predicate TEXT,
			object TEXT,
			message_idx INTEGER,
			confidence REAL DEFAULT 0.7,
			source_memory_id TEXT
		)
	`);
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_kg_subject ON memoria_kg(subject)",
		"CREATE INDEX IF NOT EXISTS idx_kg_predicate ON memoria_kg(predicate)",
		"CREATE INDEX IF NOT EXISTS idx_kg_session ON memoria_kg(session_id)",
	]);
	for (const table of ["memoria_timelines", "memoria_instructions", "memoria_preferences", "memoria_kg"] as const) {
		addColumnIfMissing(db, table, "source_memory_id", "TEXT");
	}

	db.run(`
		CREATE TABLE IF NOT EXISTS consolidation_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT,
			items_consolidated INTEGER,
			summary_preview TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);
	db.run(`
		CREATE TABLE IF NOT EXISTS memory_embeddings (
			memory_id TEXT PRIMARY KEY,
			embedding_json TEXT NOT NULL,
			model TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);

	addColumnIfMissing(db, "working_memory", "recall_count", "INTEGER DEFAULT 0");
	addColumnIfMissing(db, "working_memory", "last_recalled", "TIMESTAMP DEFAULT NULL");
	addColumnIfMissing(db, "episodic_memory", "recall_count", "INTEGER DEFAULT 0");
	addColumnIfMissing(db, "episodic_memory", "last_recalled", "TIMESTAMP DEFAULT NULL");
	addColumnIfMissing(db, "working_memory", "valid_until", "TIMESTAMP DEFAULT NULL");
	addColumnIfMissing(db, "working_memory", "superseded_by", "TEXT DEFAULT NULL");
	addColumnIfMissing(db, "working_memory", "scope", "TEXT DEFAULT 'global'");
	addColumnIfMissing(db, "episodic_memory", "valid_until", "TIMESTAMP DEFAULT NULL");
	addColumnIfMissing(db, "episodic_memory", "superseded_by", "TEXT DEFAULT NULL");
	addColumnIfMissing(db, "episodic_memory", "scope", "TEXT DEFAULT 'global'");
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_em_scope_imp ON episodic_memory(scope, importance) WHERE superseded_by IS NULL",
		"CREATE INDEX IF NOT EXISTS idx_wm_session_recall ON working_memory(session_id, last_recalled) WHERE valid_until IS NULL",
		"CREATE INDEX IF NOT EXISTS idx_mem_emb_type ON memory_embeddings(memory_id, model)",
	]);

	for (const table of ["working_memory", "episodic_memory"] as const) {
		addColumnIfMissing(db, table, "author_id", "TEXT DEFAULT NULL");
		addColumnIfMissing(db, table, "author_type", "TEXT DEFAULT NULL");
		addColumnIfMissing(db, table, "channel_id", "TEXT DEFAULT NULL");
		addColumnIfMissing(db, table, "trust_tier", "TEXT DEFAULT 'STATED'");
		addColumnIfMissing(db, table, "validator", "TEXT DEFAULT NULL");
		addColumnIfMissing(db, table, "validated_at", "TIMESTAMP DEFAULT NULL");
		addColumnIfMissing(db, table, "validation_count", "INTEGER DEFAULT 0");
	}
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_wm_author ON working_memory(author_id)",
		"CREATE INDEX IF NOT EXISTS idx_wm_channel ON working_memory(channel_id)",
		"CREATE INDEX IF NOT EXISTS idx_em_author ON episodic_memory(author_id)",
		"CREATE INDEX IF NOT EXISTS idx_em_channel ON episodic_memory(channel_id)",
		"CREATE INDEX IF NOT EXISTS idx_wm_validator ON working_memory(validator)",
		"CREATE INDEX IF NOT EXISTS idx_wm_validated_at ON working_memory(validated_at)",
	]);

	db.run(`
		CREATE TABLE IF NOT EXISTS memory_validations (
			validation_id INTEGER PRIMARY KEY AUTOINCREMENT,
			memory_id TEXT NOT NULL,
			validator TEXT NOT NULL,
			validated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			action TEXT NOT NULL,
			new_content TEXT,
			note TEXT
		)
	`);
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_validations_memory ON memory_validations(memory_id)",
		"CREATE INDEX IF NOT EXISTS idx_validations_validator ON memory_validations(validator)",
		`CREATE TRIGGER IF NOT EXISTS trim_validations_to_3
		AFTER INSERT ON memory_validations
		BEGIN
			DELETE FROM memory_validations
			WHERE memory_id = NEW.memory_id
			  AND validation_id NOT IN (
				SELECT validation_id FROM memory_validations
				WHERE memory_id = NEW.memory_id
				ORDER BY validation_id DESC
				LIMIT 3
			  );
		END`,
	]);

	db.run(`
		CREATE TABLE IF NOT EXISTS facts (
			fact_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			subject TEXT NOT NULL,
			predicate TEXT NOT NULL,
			object TEXT NOT NULL,
			timestamp TEXT,
			source_msg_id TEXT,
			confidence REAL DEFAULT 1.0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id)",
		"CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject)",
		"CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_msg_id)",
	]);
	db.run(`
		CREATE VIRTUAL TABLE IF NOT EXISTS fts_facts USING fts5(
			subject, predicate, object, content='facts'
		)
	`);
	runAll(db, [
		`CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
			INSERT INTO fts_facts(rowid, subject, predicate, object)
			VALUES (new.rowid, new.subject, new.predicate, new.object);
		END`,
		`CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
			INSERT INTO fts_facts(fts_facts, rowid, subject, predicate, object)
			VALUES ('delete', old.rowid, old.subject, old.predicate, old.object);
		END`,
	]);

	for (const table of ["working_memory", "episodic_memory"] as const) {
		addColumnIfMissing(db, table, "event_date", "TEXT DEFAULT NULL");
		addColumnIfMissing(db, table, "event_date_precision", "TEXT DEFAULT 'unknown'");
		addColumnIfMissing(db, table, "temporal_tags", "TEXT DEFAULT '[]'");
		addColumnIfMissing(db, table, "corrected_by", "INTEGER DEFAULT NULL");
	}
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_wm_event_date ON working_memory(event_date)",
		"CREATE INDEX IF NOT EXISTS idx_em_event_date ON episodic_memory(event_date)",
	]);

	db.run(`
		CREATE TABLE IF NOT EXISTS annotations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			memory_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			value TEXT NOT NULL,
			source TEXT,
			confidence REAL DEFAULT 1.0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_annot_memory_kind ON annotations(memory_id, kind)",
		"CREATE INDEX IF NOT EXISTS idx_annot_kind_value ON annotations(kind, value)",
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_annot_unique ON annotations(memory_id, kind, value)",
	]);

	db.run(`
		CREATE TABLE IF NOT EXISTS triples (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			subject TEXT NOT NULL,
			predicate TEXT NOT NULL,
			object TEXT NOT NULL,
			valid_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			valid_until TEXT,
			source TEXT,
			confidence REAL DEFAULT 1.0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);
	runAll(db, [
		"CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject)",
		"CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate)",
		"CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object)",
		"CREATE INDEX IF NOT EXISTS idx_triples_valid_from ON triples(valid_from)",
	]);
	// Idempotency / exact-bank safety: deterministic lookup for custom autolearn projection.
	// Preserve WAL/permissions: only additive columns/indexes.
	addColumnIfMissing(db, "working_memory", "idempotency_key", "TEXT DEFAULT NULL");
	addColumnIfMissing(db, "episodic_memory", "idempotency_key", "TEXT DEFAULT NULL");
	reconcileIdempotencyDuplicates(db, "working_memory");
	reconcileIdempotencyDuplicates(db, "episodic_memory");
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_wm_idempotency ON working_memory(idempotency_key) WHERE idempotency_key IS NOT NULL",
	);
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_wm_idempotency_source ON working_memory(source, idempotency_key) WHERE idempotency_key IS NOT NULL",
	);
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_em_idempotency ON episodic_memory(idempotency_key) WHERE idempotency_key IS NOT NULL",
	);
	db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_source_idempotency_unique ON working_memory(source, idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key != ''",
	);
	db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_em_source_idempotency_unique ON episodic_memory(source, idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key != ''",
	);
}
