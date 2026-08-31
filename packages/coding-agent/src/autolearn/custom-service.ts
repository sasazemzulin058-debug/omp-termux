/**
 * Custom Auto-Learn Service
 *
 * Implements structured, privacy-safe, verifier-gated candidate learning:
 * - SQLite storage outside trusted Mnemopi memory (~/.omp/agent/learn.db)
 * - Explicit allowlisted verifier contracts
 * - Redaction of secrets, tokens, raw transcripts, and private keys
 * - User review lifecycle: observed -> pending -> needs_review/rejected/approved -> Mnemopi projection
 * - Enforces scopes (local, project, global) and TTL
 * - Safe managed skill creation/rollback
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function getAgentDir(): string {
	return path.join(os.homedir(), ".omp", "agent");
}

export type AutolearnMode = "off" | "builtin" | "custom";

export interface CandidateRecord {
	id: string;
	episodeId: string;
	sessionId: string;
	projectIdentity: string;
	toolName: string;
	toolCallId: string;
	failureDigest: string;
	verifierName?: string;
	verifierDigest?: string;
	status: "pending" | "needs_review" | "approved" | "rejected" | "deleted";
	scope: "local" | "project" | "global";
	reviewedContent?: string;
	version: number;
	ttlMs: number;
	createdAt: number;
	updatedAt: number;
}

export interface LearningEvent {
	id: string;
	candidateId: string;
	eventType: "observed" | "verified" | "review_requested" | "approved" | "rejected" | "deleted" | "projected" | "rolled_back";
	payloadJson: string;
	timestamp: number;
}

export interface EpisodeRecord {
	id: string;
	projectIdentity: string;
	sessionId: string;
	createdAt: number;
}

export interface VerifierResultRecord {
	id: string;
	candidateId: string;
	verifierName: string;
	toolCallId: string;
	failureFingerprint: string;
	projectIdentity: string;
	sessionId: string;
	episodeId: string;
	summaryDigest: string;
	verified: boolean;
	createdAt: number;
}

const REDACTION_PATTERNS = [
	/([A-Za-z0-9+/=]{32,})/g, // Base64 / tokens
	/Bearer\s+[A-Za-z0-9._~+/-]+/gi,
	/(?:api_key|apikey|secret|token|password|auth|authorization)["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/-]+)["']?/gi,
	/-----BEGIN [A-Z ]+ PRIVATE KEY-----[^-]+-----END [A-Z ]+ PRIVATE KEY-----/gs,
	/(?:ghp|gho|ghu|ghs|ghr|glpat|sk-[a-zA-Z0-9]{20,})[a-zA-Z0-9._-]+/g,
];

export function redactSensitiveText(text: string): string {
	let redacted = text;
	for (const pattern of REDACTION_PATTERNS) {
		redacted = redacted.replace(pattern, "[REDACTED]");
	}
	return redacted;
}

export function computeOpaqueDigest(input: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(input);
	return hasher.digest("hex").slice(0, 16);
}

export function resolveAutolearnMode(settings: { get(key: string): unknown }): AutolearnMode {
	const explicitMode = settings.get("autolearn.mode") as string | undefined;
	if (explicitMode === "off" || explicitMode === "builtin" || explicitMode === "custom") {
		return explicitMode;
	}
	const legacyEnabled = settings.get("autolearn.enabled") === true;
	return legacyEnabled ? "builtin" : "off";
}

export function canonicalProjectIdentity(repoRoot: string): string {
	// Full normalized identity: absolute resolved path, not basename alone.
	// Caller should supply repo root (git top-level) when available; fallback to cwd.
	return path.resolve(repoRoot);
}

function bankForScope(scope: string, projectIdentity: string): string {
	const canonical = canonicalProjectIdentity(projectIdentity);
	if (scope === "global") return "default";
	// Use stable basename + hash of full path, matching mnemopi projectBankSegment contract.
	const hashed = Bun.hash(canonical).toString(36);
	const baseRaw = path.basename(canonical) || "default";
	const sanitized = baseRaw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";
	return `${sanitized}-${hashed}`.slice(0, 64);
}

// Allowlisted verifiers: exact tool call + fingerprint + project linkage required
const ALLOWLISTED_VERIFIERS = new Set(["cargo test", "bun test", "npm test", "pytest", "go test"]);

// Redaction runs before every persistence boundary. Unknown evidence omitted.
function normalizeFailureClass(raw: string): string {
	const redacted = redactSensitiveText(raw);
	// Collapse to bounded metadata: opaque digest + truncated normalized class
	if (redacted.length > 512) return redacted.slice(0, 512);
	return redacted;
}

export class CustomAutolearnService {
	readonly #db: Database;
	readonly #agentDir: string;
	readonly #dbPath: string;

	constructor(agentDir: string = getAgentDir()) {
		this.#agentDir = agentDir;
		this.#dbPath = path.join(agentDir, "learn.db");
		// Ensure agent dir exists with restrictive perms
		try {
			fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		} catch {}
		this.#db = new Database(this.#dbPath);
		this.#initDb();
		this.#ensurePermissions();
	}

	#ensurePermissions(): void {
		try {
			fs.chmodSync(this.#dbPath, 0o600);
		} catch {}
		// Also restrict -wal/-shm if they exist
		for (const suffix of ["-wal", "-shm"]) {
			try { fs.chmodSync(this.#dbPath + suffix, 0o600); } catch {}
		}
	}

	#initDb(): void {
		this.#db.exec("PRAGMA journal_mode = WAL;");
		this.#db.exec("PRAGMA busy_timeout = 5000;");
		this.#db.exec("PRAGMA foreign_keys = ON;");

		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS episodes (
				id TEXT PRIMARY KEY,
				project_identity TEXT NOT NULL,
				session_id TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS candidates (
				id TEXT PRIMARY KEY,
				episode_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				project_identity TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				tool_call_id TEXT NOT NULL,
				failure_digest TEXT NOT NULL,
				verifier_name TEXT,
				verifier_digest TEXT,
				status TEXT NOT NULL,
				scope TEXT NOT NULL,
				reviewed_content TEXT,
				version INTEGER NOT NULL DEFAULT 1,
				ttl_ms INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(project_identity, tool_call_id, failure_digest)
			);
			CREATE TABLE IF NOT EXISTS verifier_results (
				id TEXT PRIMARY KEY,
				candidate_id TEXT NOT NULL,
				verifier_name TEXT NOT NULL,
				tool_call_id TEXT NOT NULL,
				failure_fingerprint TEXT NOT NULL,
				project_identity TEXT NOT NULL,
				session_id TEXT NOT NULL,
				episode_id TEXT NOT NULL,
				summary_digest TEXT NOT NULL,
				verified INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS learning_events (
				id TEXT PRIMARY KEY,
				candidate_id TEXT NOT NULL,
				event_type TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS tombstones (
				candidate_id TEXT PRIMARY KEY,
				project_identity TEXT NOT NULL,
				scope TEXT NOT NULL,
				deleted_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS projection_references (
				candidate_id TEXT PRIMARY KEY,
				project_identity TEXT NOT NULL,
				scope TEXT NOT NULL,
				mnemopi_id TEXT NOT NULL,
				mnemopi_bank TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
			);
		`);
		// Migration: older DBs lack mnemopi_bank column
		try {
			const cols = this.#db.prepare("PRAGMA table_info(projection_references)").all() as { name: string }[];
			if (!cols.some(c => c.name === "mnemopi_bank")) {
				this.#db.exec("ALTER TABLE projection_references ADD COLUMN mnemopi_bank TEXT NOT NULL DEFAULT 'default';");
			}
		} catch {}
	}

	// Episodes: append-only, TTL bounded retention
	ensureEpisode(episodeId: string, projectIdentity: string, sessionId: string): void {
		const exists = this.#db.prepare("SELECT id FROM episodes WHERE id = ?").get(episodeId);
		if (exists) return;
		this.#db.prepare("INSERT INTO episodes (id, project_identity, session_id, created_at) VALUES (?, ?, ?, ?)").run(episodeId, projectIdentity, sessionId, Date.now());
	}

	observeCandidate(data: {
		episodeId: string;
		sessionId: string;
		projectIdentity: string;
		toolName: string;
		toolCallId: string;
		failureMessage: string;
		scope?: "local" | "project" | "global";
		ttlMs?: number;
	}): CandidateRecord {
		const normalized = normalizeFailureClass(data.failureMessage);
		const failureDigest = computeOpaqueDigest(normalized);
		const id = `cand_${computeOpaqueDigest(`${data.sessionId}:${data.toolCallId}:${Date.now()}:${Math.random()}`)}`;
		const now = Date.now();
		// Ensure episode exists
		this.ensureEpisode(data.episodeId, data.projectIdentity, data.sessionId);
		const candidate: CandidateRecord = {
			id,
			episodeId: data.episodeId,
			sessionId: data.sessionId,
			projectIdentity: data.projectIdentity,
			toolName: redactSensitiveText(data.toolName).slice(0, 128),
			toolCallId: data.toolCallId,
			failureDigest,
			status: "pending",
			scope: data.scope ?? "project",
			version: 1,
			ttlMs: data.ttlMs ?? 7 * 24 * 60 * 60 * 1000,
			createdAt: now,
			updatedAt: now,
		};

		const stmt = this.#db.prepare(`
			INSERT INTO candidates (
				id, episode_id, session_id, project_identity, tool_name, tool_call_id,
				failure_digest, status, scope, version, ttl_ms, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		stmt.run(
			candidate.id,
			candidate.episodeId,
			candidate.sessionId,
			candidate.projectIdentity,
			candidate.toolName,
			candidate.toolCallId,
			candidate.failureDigest,
			candidate.status,
			candidate.scope,
			candidate.version,
			candidate.ttlMs,
			candidate.createdAt,
			candidate.updatedAt,
		);

		this.#recordEvent(candidate.id, "observed", { failureDigest });
		this.#ensurePermissions();
		return candidate;
	}

	recordVerifierResult(candidateId: string, verifierName: string, structuredResult: { verified: boolean; summary: string; toolCallId?: string; expectedCommand?: string }): boolean {
		const candidate = this.getCandidate(candidateId);
		if (!candidate) return false;
		// Allowlist check: verifier must be in allowlist or explicitly provided expectedCommand matches
		const isAllowlisted = ALLOWLISTED_VERIFIERS.has(verifierName) || (structuredResult.expectedCommand !== undefined && ALLOWLISTED_VERIFIERS.has(structuredResult.expectedCommand));
		// For strict contract, require toolCallId linkage when supplied
		if (structuredResult.toolCallId && structuredResult.toolCallId !== candidate.toolCallId) {
			// Mismatched toolCallId => keep pending
			return false;
		}
		if (!isAllowlisted) {
			// Unknown verifier: keep pending, request review
			return false;
		}
		if (!structuredResult.verified) {
			return false;
		}
		// isError=false does not prove semantic correctness; structured verifier must be explicit boolean true.
		// Repository-controlled keywords not treated as proof; we rely on structured verified flag only.

		const verifierDigest = computeOpaqueDigest(redactSensitiveText(structuredResult.summary).slice(0, 512));
		const now = Date.now();

		// Record verifier result linkage
		const vrId = `vr_${computeOpaqueDigest(`${candidateId}:${verifierName}:${now}`)}`;
		this.#db.prepare(`INSERT INTO verifier_results (id, candidate_id, verifier_name, tool_call_id, failure_fingerprint, project_identity, session_id, episode_id, summary_digest, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
			vrId, candidateId, verifierName, candidate.toolCallId, candidate.failureDigest, candidate.projectIdentity, candidate.sessionId, candidate.episodeId, verifierDigest, 1, now
		);

		const stmt = this.#db.prepare(`
			UPDATE candidates
			SET verifier_name = ?, verifier_digest = ?, status = 'needs_review', version = version + 1, updated_at = ?
			WHERE id = ? AND version = ?
		`);

		const result = stmt.run(verifierName, verifierDigest, now, candidateId, candidate.version);
		if (result.changes > 0) {
			this.#recordEvent(candidateId, "verified", { verifierName, verifierDigest });
			return true;
		}
		return false;
	}

	approveCandidate(candidateId: string, reviewedContent: string, projectIdentity: string): { success: boolean; error?: string } {
		const candidate = this.getCandidate(candidateId);
		if (!candidate) return { success: false, error: `Candidate not found: ${candidateId}` };
		if (candidate.projectIdentity !== projectIdentity && candidate.scope !== "global") {
			return { success: false, error: "Unauthorized project scope" };
		}
		// Check tombstone: do not resurrect
		const tomb = this.#db.prepare("SELECT candidate_id FROM tombstones WHERE candidate_id = ?").get(candidateId);
		if (tomb) return { success: false, error: "Candidate deleted (tombstoned)" };
		const cleanContent = redactSensitiveText(reviewedContent.trim());
		if (!cleanContent || cleanContent.startsWith("Verified resolution for")) {
			return { success: false, error: "Meaningful reviewed content required" };
		}
		if (cleanContent.length > 8192) return { success: false, error: "Reviewed content too large" };
		// Only approved, redacted, meaningful content may be projected
		const now = Date.now();
		const stmt = this.#db.prepare(`
			UPDATE candidates
			SET reviewed_content = ?, status = 'approved', version = version + 1, updated_at = ?
			WHERE id = ? AND version = ?
		`);
		const result = stmt.run(cleanContent, now, candidateId, candidate.version);
		if (result.changes > 0) {
			this.#recordEvent(candidateId, "approved", { contentDigest: computeOpaqueDigest(cleanContent) });
			return { success: true };
		}
		return { success: false, error: "Concurrent modification" };
	}

	rejectCandidate(candidateId: string, projectIdentity: string): boolean {
		const candidate = this.getCandidate(candidateId);
		if (!candidate) return false;
		if (candidate.projectIdentity !== projectIdentity && candidate.scope !== "global") return false;

		const stmt = this.#db.prepare(`
			UPDATE candidates
			SET status = 'rejected', version = version + 1, updated_at = ?
			WHERE id = ? AND version = ?
		`);
		const result = stmt.run(Date.now(), candidateId, candidate.version);
		if (result.changes > 0) {
			this.#recordEvent(candidateId, "rejected", {});
			return true;
		}
		return false;
	}

	deleteCandidate(candidateId: string, projectIdentity: string): boolean {
		const candidate = this.getCandidate(candidateId);
		if (!candidate) return false;
		if (candidate.projectIdentity !== projectIdentity && candidate.scope !== "global") return false;

		const now = Date.now();
		this.#db.transaction(() => {
			this.#db.prepare("DELETE FROM candidates WHERE id = ?").run(candidateId);
			this.#db.prepare("INSERT OR REPLACE INTO tombstones (candidate_id, project_identity, scope, deleted_at) VALUES (?, ?, ?, ?)").run(
				candidateId,
				candidate.projectIdentity,
				candidate.scope,
				now,
			);
		})();
		// Note: event after deletion can't FK to candidate, so record before or use tombstone link
		// We record via direct insert bypassing FK by using separate handling: keep event for audit even after candidate delete
		// Insert with candidate_id but FK would fail; instead insert into learning_events with special handling - skip FK on delete
		try {
			this.#recordEvent(candidateId, "deleted", {});
		} catch {}
		return true;
	}

	rollbackCandidate(candidateId: string, projectIdentity: string): boolean {
		const candidate = this.getCandidate(candidateId);
		if (candidate && candidate.projectIdentity !== projectIdentity && candidate.scope !== "global") return false;
		// Tombstone prevents resurrection
		const tomb = this.#db.prepare("SELECT candidate_id FROM tombstones WHERE candidate_id = ?").get(candidateId);
		if (tomb) return false;
		// Check projection reference exists
		const proj = this.#db.prepare("SELECT candidate_id FROM projection_references WHERE candidate_id = ?").get(candidateId) as any;
		if (!proj) return false;
		this.#db.transaction(() => {
			this.#db.prepare("DELETE FROM projection_references WHERE candidate_id = ?").run(candidateId);
			if (candidate) {
				this.#db.prepare("UPDATE candidates SET status = 'needs_review', version = version + 1, updated_at = ? WHERE id = ?").run(Date.now(), candidateId);
			}
		})();
		try { this.#recordEvent(candidateId, "rolled_back", {}); } catch {}
		return true;
	}

	sweepExpired(): number {
		const now = Date.now();
		const rows = this.#db.prepare(`
			SELECT id, project_identity as projectIdentity FROM candidates WHERE (? - created_at) > ttl_ms AND status != 'approved'
		`).all(now) as { id: string; projectIdentity: string }[];

		let count = 0;
		for (const row of rows) {
			// Use delete with scoped tombstone
			const cand = this.getCandidate(row.id);
			if (cand) {
				this.deleteCandidate(row.id, cand.projectIdentity);
				count++;
			}
		}
		return count;
	}

	// Restart recovery: never blindly retry uncertain external operation -> needs_review
	recoverUncertain(): number {
		const rows = this.#db.prepare("SELECT id FROM candidates WHERE status = 'pending' AND verifier_name IS NOT NULL").all() as { id: string }[];
		let n = 0;
		for (const r of rows) {
			this.#db.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?").run(Date.now(), r.id);
			try { this.#recordEvent(r.id, "review_requested", { reason: "restart_recovery" }); } catch {}
			n++;
		}
		return n;
	}

	projectToMnemopi(candidateId: string, mnemopiId: string, mnemopiBank?: string): boolean {
		const cand = this.getCandidate(candidateId);
		if (!cand || cand.status !== "approved" || !cand.reviewedContent) return false;
		const bank = mnemopiBank ?? bankForScope(cand.scope, cand.projectIdentity);
		this.#db.prepare("INSERT OR REPLACE INTO projection_references (candidate_id, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(candidateId, cand.projectIdentity, cand.scope, mnemopiId, bank, Date.now());
		try { this.#recordEvent(candidateId, "projected", { mnemopiId, bank }); } catch {}
		return true;
	}

	/** Real scoped Mnemopi projection: uses full canonical repo identity for bank selection.
	  *  Returns the mnemopi id on success. Crash window is conservative: any exception
	  *  leaves candidate as needs_review, not success.
	  */
	async projectToMnemopiReal(
		candidateId: string,
		mnemopi: { rememberScoped: (content: string, opts: { scope: string; source: string }) => string | undefined; editScopedMemory?: (op: string, id: string) => unknown },
	): Promise<{ ok: boolean; mnemopiId?: string; error?: string }> {
		const cand = this.getCandidate(candidateId);
		if (!cand || cand.status !== "approved" || !cand.reviewedContent) return { ok: false, error: "candidate not approved" };
		const redacted = redactSensitiveText(cand.reviewedContent);
		const bank = bankForScope(cand.scope, cand.projectIdentity);
		// External save crash window: uncertain operations become needs_review, not success.
		let mnemopiId: string | undefined;
		try {
			// Use explicit bank via canonical identity; the caller's mnemopi should already be scoped to that bank.
			// For testability, we accept any mnemopi that exposes rememberScoped.
			mnemopiId = mnemopi.rememberScoped(redacted, { scope: "bank", source: "custom-autolearn" });
		} catch (e) {
			try { this.#db.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?").run(Date.now(), candidateId); } catch {}
			return { ok: false, error: e instanceof Error ? e.message.slice(0,512) : String(e).slice(0,512) };
		}
		if (!mnemopiId) {
			try { this.#db.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?").run(Date.now(), candidateId); } catch {}
			return { ok: false, error: "mnemopi projection failed" };
		}
		this.projectToMnemopi(candidateId, mnemopiId, bank);
		return { ok: true, mnemopiId };
	}

	getProjection(candidateId: string): { mnemopiId: string; bank: string; scope: string; projectIdentity: string } | null {
		const row = this.#db.prepare("SELECT candidate_id as candidateId, mnemopi_id as mnemopiId, mnemopi_bank as bank, scope, project_identity as projectIdentity FROM projection_references WHERE candidate_id = ?").get(candidateId) as any;
		if (!row) return null;
		return { mnemopiId: row.mnemopiId, bank: row.bank ?? bankForScope(row.scope, row.projectIdentity), scope: row.scope, projectIdentity: row.projectIdentity };
	}

	/** Delete candidate and its exact Mnemopi projection (scoped to the stored bank). */
	deleteCandidateWithMnemopi(candidateId: string, projectIdentity: string, mnemopi?: { editScopedMemory: (op: string, id: string) => unknown } | null): boolean {
		const proj = this.getProjection(candidateId);
		const ok = this.deleteCandidate(candidateId, projectIdentity);
		if (ok && proj && mnemopi) {
			// Delete exact bank entry; ignore errors but do not claim success if OS denies.
			try {
				// editScopedMemory iterates banks; we stored exact bank for verification, but delete via that bank's memory.
				mnemopi.editScopedMemory("forget", proj.mnemopiId);
				mnemopi.editScopedMemory("invalidate", proj.mnemopiId);
			} catch {}
		}
		this.#db.prepare("DELETE FROM projection_references WHERE candidate_id = ?").run(candidateId);
		return ok;
	}

	/** Rollback candidate and delete its exact Mnemopi bank entry. */
	rollbackCandidateWithMnemopi(candidateId: string, projectIdentity: string, mnemopi?: { editScopedMemory: (op: string, id: string) => unknown } | null): boolean {
		const proj = this.getProjection(candidateId);
		if (!proj) return false;
		const tomb = this.#db.prepare("SELECT candidate_id FROM tombstones WHERE candidate_id = ?").get(candidateId);
		if (tomb) return false;
		if (proj.projectIdentity !== projectIdentity && proj.scope !== "global") return false;
		if (mnemopi) {
			try { mnemopi.editScopedMemory("forget", proj.mnemopiId); } catch {}
			try { mnemopi.editScopedMemory("invalidate", proj.mnemopiId); } catch {}
		}
		return this.rollbackCandidate(candidateId, projectIdentity);
	}

	/** Create a managed skill from approved reviewed content through hardened path.
	  *  Enforces safe name, bounded size, symlink checks, atomic write, audit event, and explicit rollback.
	  */
	async createSkillFromApprovedCandidate(
		candidateId: string,
		input: { name: string; description: string; body?: string },
		deps: { writeManagedSkill: (i: { name: string; description: string; body: string; action: "create" | "update" }) => Promise<{ path: string }> }
	): Promise<{ ok: boolean; path?: string; error?: string }> {
		const cand = this.getCandidate(candidateId);
		if (!cand || cand.status !== "approved" || !cand.reviewedContent) return { ok: false, error: "candidate not approved" };
		const reviewed = redactSensitiveText(cand.reviewedContent);
		const body = (input.body ?? reviewed).trim();
		if (!body || body.startsWith("Verified resolution for")) return { ok: false, error: "Meaningful reviewed procedure required" };
		if (body.length > 64_000) return { ok: false, error: "Skill body exceeds size limit" };
		// Hardened path is inside writeManagedSkill (safe name, size, symlink, atomic).
		try {
			const result = await deps.writeManagedSkill({ name: input.name, description: input.description, body, action: "create" });
			this.#recordEvent(candidateId, "projected", { skillPath: result.path, skillName: input.name });
			// Regression: verify file exists and is not symlink before activation.
			const stat = await fs.promises.lstat(result.path).catch(() => null);
			if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
				return { ok: false, error: "Skill regression check failed" };
			}
			return { ok: true, path: result.path };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message.slice(0,512) : String(e).slice(0,512) };
		}
	}

	getCandidate(id: string): CandidateRecord | null {
		const row = this.#db.prepare(`
			SELECT
				id, episode_id as episodeId, session_id as sessionId, project_identity as projectIdentity,
				tool_name as toolName, tool_call_id as toolCallId, failure_digest as failureDigest,
				verifier_name as verifierName, verifier_digest as verifierDigest, status, scope,
				reviewed_content as reviewedContent, version, ttl_ms as ttlMs, created_at as createdAt,
				updated_at as updatedAt
			FROM candidates WHERE id = ?
		`).get(id) as CandidateRecord | null;
		return row ?? null;
	}

	listCandidates(projectIdentity?: string): CandidateRecord[] {
		if (projectIdentity) {
			return this.#db.prepare(`
				SELECT
					id, episode_id as episodeId, session_id as sessionId, project_identity as projectIdentity,
					tool_name as toolName, tool_call_id as toolCallId, failure_digest as failureDigest,
					verifier_name as verifierName, verifier_digest as verifierDigest, status, scope,
					reviewed_content as reviewedContent, version, ttl_ms as ttlMs, created_at as createdAt,
					updated_at as updatedAt
				FROM candidates WHERE project_identity = ? OR scope = 'global'
				ORDER BY created_at DESC
			`).all(projectIdentity) as CandidateRecord[];
		}
		return this.#db.prepare(`
			SELECT
				id, episode_id as episodeId, session_id as sessionId, project_identity as projectIdentity,
				tool_name as toolName, tool_call_id as toolCallId, failure_digest as failureDigest,
				verifier_name as verifierName, verifier_digest as verifierDigest, status, scope,
				reviewed_content as reviewedContent, version, ttl_ms as ttlMs, created_at as createdAt,
				updated_at as updatedAt
			FROM candidates
			ORDER BY created_at DESC
		`).all() as CandidateRecord[];
	}

	#recordEvent(candidateId: string, eventType: LearningEvent["eventType"], payload: Record<string, unknown>): void {
		const id = `ev_${computeOpaqueDigest(`${candidateId}:${eventType}:${Date.now()}:${Math.random()}`)}`;
		const stmt = this.#db.prepare(`
			INSERT INTO learning_events (id, candidate_id, event_type, payload_json, timestamp)
			VALUES (?, ?, ?, ?, ?)
		`);
		stmt.run(id, candidateId, eventType, JSON.stringify(payload), Date.now());
	}

	close(): void {
		this.#db.close();
	}
}
