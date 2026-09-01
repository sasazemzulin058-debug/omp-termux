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
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { projectBankSegment } from "../mnemopi/config";
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
	status: "pending" | "needs_review" | "approved" | "rejected" | "deleted" | "projection_pending";
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
	eventType:
		| "observed"
		| "verified"
		| "review_requested"
		| "approved"
		| "rejected"
		| "deleted"
		| "projected"
		| "rolled_back"
		| "delete_intent"
		| "rollback_intent";
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

export function resolveProjectIdentity(cwd: string): string {
	const normalizedCwd = path.resolve(cwd);
	try {
		const gitRoot = vcs.git(normalizedCwd)?.info()?.repoRoot ?? vcs.repo(normalizedCwd)?.root();
		if (typeof gitRoot === "string" && gitRoot.trim()) return canonicalProjectIdentity(gitRoot);
	} catch {}
	try {
		let cur = normalizedCwd;
		const fsRoot = path.parse(cur).root;
		while (true) {
			try {
				if (fs.existsSync(path.join(cur, ".git"))) return canonicalProjectIdentity(cur);
			} catch {}
			if (cur === fsRoot) break;
			const parent = path.dirname(cur);
			if (parent === cur) break;
			cur = parent;
		}
	} catch {}
	return canonicalProjectIdentity(normalizedCwd);
}

export function bankForScope(scope: string, projectIdentity: string): string {
	const canonical = canonicalProjectIdentity(projectIdentity);
	if (scope === "global") return "default";
	// Use exact mnemopi projectBankSegment contract for per-project isolation.
	return projectBankSegment(canonical);
}

// Allowlisted verifiers: exact tool call + fingerprint + project linkage required
const ALLOWLISTED_VERIFIERS = new Set(["cargo test", "bun test", "npm test", "pytest", "go test"]);

export function isAllowlistedVerifierCommand(command: string): boolean {
	const t = command.trim();
	for (const v of ALLOWLISTED_VERIFIERS) {
		if (t === v || t.startsWith(`${v} `) || t.startsWith(`${v}\t`)) return true;
	}
	return false;
}

// Capability contracts for crash-safe projection and exact-bank cleanup.
// rememberScoped is NOT idempotent: external write + crash before ID persistence leaves orphan.
// Require deterministic idempotent operation or exact lookup by candidate/content digest.
// getScopedMemory/editScopedMemory are cross-bank first-hit; require exact-bank resolver/edit before mutation.
export interface MnemopiIdempotentWriteCapability {
	rememberScopedIdempotent: (
		content: string,
		opts: { scope: string; source: string; idempotencyKey: string; targetBank?: string },
	) => string | undefined;
}

export interface MnemopiExactBankReadCapability {
	getScopedMemoryInBank: (id: string, bank: string) => { bank: string; store?: string } | null | undefined;
}

export interface MnemopiExactBankEditCapability {
	editScopedMemoryInBank: (
		op: string,
		id: string,
		bank: string,
	) => { status: string; bank?: string; store?: string } | unknown;
}

export interface MnemopiBankAccessibilityCapability {
	isBankAccessible?: (bank: string) => boolean;
	getScopedTargetForBank?: (bank: string) => unknown | null | undefined;
}

export type MnemopiProjectionClient = {
	rememberScoped?: (content: string, opts: { scope: string; source: string }) => string | undefined;
	rememberScopedIdempotent?: (
		content: string,
		opts: { scope: string; source: string; idempotencyKey: string; targetBank?: string },
	) => string | undefined;
	getScopedMemory?: (id: string) => { bank: string } | null | undefined;
	getScopedMemoryInBank?: (id: string, bank: string) => { bank: string } | null | undefined;
	editScopedMemory?: (op: string, id: string) => unknown;
	editScopedMemoryInBank?: (op: string, id: string, bank: string) => unknown;
	getScopedRetainTarget?: () => { bank: string } | null | undefined;
	getScopedRecallTargets?: () => readonly { bank: string }[] | null | undefined;
	isBankAccessible?: (bank: string) => boolean;
	getScopedTargetForBank?: (bank: string) => unknown | null | undefined;
	bank?: unknown;
};

export function hasIdempotentWriteCapability(client: unknown): client is MnemopiIdempotentWriteCapability {
	return typeof (client as Record<string, unknown>)?.rememberScopedIdempotent === "function";
}

export function hasExactBankReadCapability(client: unknown): client is MnemopiExactBankReadCapability {
	return typeof (client as Record<string, unknown>)?.getScopedMemoryInBank === "function";
}

export function hasExactBankEditCapability(client: unknown): client is MnemopiExactBankEditCapability {
	return typeof (client as Record<string, unknown>)?.editScopedMemoryInBank === "function";
}

export function hasBankAccessibilityCapability(client: unknown): client is MnemopiBankAccessibilityCapability {
	const c = client as Record<string, unknown>;
	return typeof c?.isBankAccessible === "function" || typeof c?.getScopedTargetForBank === "function";
}

export function isBankAccessibleForClient(client: unknown, bank: string): boolean | null {
	try {
		const c = client as MnemopiBankAccessibilityCapability & { getScopedMemoryInBank?: unknown };
		if (typeof c.isBankAccessible === "function") return c.isBankAccessible(bank);
		if (typeof c.getScopedTargetForBank === "function") return c.getScopedTargetForBank(bank) != null;
	} catch {}
	return null;
}

export function computeIdempotencyKey(
	candidateId: string,
	content: string,
	scope: string,
	projectIdentity: string,
): string {
	return computeOpaqueDigest(`${candidateId}\0${content}\0${scope}\0${projectIdentity}`);
}

// Redaction runs before every persistence boundary. Unknown evidence omitted.
function normalizeFailureClass(raw: string): string {
	const redacted = redactSensitiveText(raw);
	// Collapse to bounded metadata: opaque digest + truncated normalized class
	if (redacted.length > 512) return redacted.slice(0, 512);
	return redacted;
}

export class CustomAutolearnService {
	readonly #db: Database;
	readonly #dbPath: string;

	constructor(agentDir: string = getAgentDir()) {
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
			try {
				fs.chmodSync(this.#dbPath + suffix, 0o600);
			} catch {}
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
				timestamp INTEGER NOT NULL
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
			CREATE TABLE IF NOT EXISTS operation_intents (
				candidate_id TEXT PRIMARY KEY,
				operation TEXT NOT NULL,
				project_identity TEXT NOT NULL,
				scope TEXT NOT NULL,
				mnemopi_id TEXT NOT NULL,
				mnemopi_bank TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
		`);
		// Migration: older DBs lack mnemopi_bank column; backfill legacy banks scope-aware
		try {
			const cols = this.#db.prepare("PRAGMA table_info(projection_references)").all() as { name: string }[];
			if (!cols.some(c => c.name === "mnemopi_bank")) {
				this.#db.exec("ALTER TABLE projection_references ADD COLUMN mnemopi_bank TEXT NOT NULL DEFAULT 'default';");
			}
			// Backfill every legacy/default row from scope/project_identity:
			// global -> default, project/local -> bankForScope(scope, projectIdentity).
			// Preserve already-valid nonempty banks.
			try {
				const rows = this.#db
					.prepare("SELECT candidate_id, project_identity, scope, mnemopi_bank FROM projection_references")
					.all() as {
					candidate_id: string;
					project_identity: string;
					scope: string;
					mnemopi_bank: string | null;
				}[];
				for (const r of rows) {
					const current = r.mnemopi_bank;
					if (current != null && typeof current === "string" && current.trim() !== "") {
						if (current !== "default") continue;
						if (r.scope === "global" && current === "default") continue;
					}
					const expected = r.scope === "global" ? "default" : bankForScope(r.scope, r.project_identity);
					if (!expected?.trim()) continue;
					if (current === expected) continue;
					this.#db
						.prepare("UPDATE projection_references SET mnemopi_bank = ? WHERE candidate_id = ?")
						.run(expected, r.candidate_id);
				}
			} catch {}
		} catch {}
		// Migration: learning_events must be append-only without FK cascade (preserve audit on candidate delete)
		try {
			const row = this.#db
				.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='learning_events'")
				.get() as { sql: string } | undefined;
			if (row?.sql?.includes("FOREIGN KEY")) {
				this.#db.exec("PRAGMA foreign_keys = OFF;");
				this.#db.exec("ALTER TABLE learning_events RENAME TO learning_events_old;");
				this.#db.exec(`
					CREATE TABLE learning_events (
						id TEXT PRIMARY KEY,
						candidate_id TEXT NOT NULL,
						event_type TEXT NOT NULL,
						payload_json TEXT NOT NULL,
						timestamp INTEGER NOT NULL
					);
				`);
				this.#db.exec(
					"INSERT INTO learning_events (id, candidate_id, event_type, payload_json, timestamp) SELECT id, candidate_id, event_type, payload_json, timestamp FROM learning_events_old;",
				);
				this.#db.exec("DROP TABLE learning_events_old;");
				this.#db.exec("PRAGMA foreign_keys = ON;");
			}
		} catch {}
	}

	// Episodes: append-only, TTL bounded retention
	ensureEpisode(episodeId: string, projectIdentity: string, sessionId: string): void {
		const exists = this.#db.prepare("SELECT id FROM episodes WHERE id = ?").get(episodeId);
		if (exists) return;
		this.#db
			.prepare("INSERT INTO episodes (id, project_identity, session_id, created_at) VALUES (?, ?, ?, ?)")
			.run(episodeId, projectIdentity, sessionId, Date.now());
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

	recordVerifierResult(
		candidateId: string,
		verifierName: string,
		structuredResult: {
			verified: boolean;
			summary: string;
			toolCallId: string;
			expectedCommand: string;
			failureFingerprint: string;
			projectIdentity: string;
			sessionId: string;
			episodeId: string;
		},
	): boolean {
		const candidate = this.getCandidate(candidateId);
		if (!candidate) return false;
		// Strict contract: require exact toolCallId, expectedCommand, failure fingerprint, canonical project, session/episode identity.
		// All fields are required; missing or mismatched => keep pending, no promotion.
		if (!structuredResult.toolCallId || structuredResult.toolCallId !== candidate.toolCallId) return false;
		if (!structuredResult.expectedCommand) return false;
		// Normalize allowlist: base executable/subcommand allowlisted, full invocation preserved for digest/proof linkage
		const expectedAllowlisted = isAllowlistedVerifierCommand(structuredResult.expectedCommand);
		const verifierAllowlisted = isAllowlistedVerifierCommand(verifierName);
		if (!expectedAllowlisted && !verifierAllowlisted) return false;
		// If verifierName differs from expectedCommand, at least verifier must be allowlisted (exact proof linkage already enforced via toolCallId/fingerprint)
		if (verifierName !== structuredResult.expectedCommand && !verifierAllowlisted) return false;
		if (!structuredResult.failureFingerprint || structuredResult.failureFingerprint !== candidate.failureDigest)
			return false;
		// Canonical project identity comparison uses normalized absolute paths.
		const normalizedProject = canonicalProjectIdentity(structuredResult.projectIdentity);
		const candidateProject = canonicalProjectIdentity(candidate.projectIdentity);
		if (normalizedProject !== candidateProject) return false;
		if (!structuredResult.sessionId || structuredResult.sessionId !== candidate.sessionId) return false;
		if (!structuredResult.episodeId || structuredResult.episodeId !== candidate.episodeId) return false;
		if (!structuredResult.verified) return false;
		// isError=false does not prove semantic correctness; structured verifier must be explicit boolean true.
		// Repository-controlled keywords not treated as proof; we rely on structured verified flag only.

		const verifierDigest = computeOpaqueDigest(redactSensitiveText(structuredResult.summary).slice(0, 512));
		const now = Date.now();

		// Record verifier result linkage
		const vrId = `vr_${computeOpaqueDigest(`${candidateId}:${verifierName}:${now}`)}`;
		this.#db
			.prepare(
				`INSERT INTO verifier_results (id, candidate_id, verifier_name, tool_call_id, failure_fingerprint, project_identity, session_id, episode_id, summary_digest, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				vrId,
				candidateId,
				verifierName,
				candidate.toolCallId,
				candidate.failureDigest,
				candidate.projectIdentity,
				candidate.sessionId,
				candidate.episodeId,
				verifierDigest,
				1,
				now,
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
	approveCandidate(
		candidateId: string,
		reviewedContent: string,
		projectIdentity: string,
	): { success: boolean; error?: string } {
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
		const incomingDigest = computeOpaqueDigest(cleanContent);
		const existingDigest = candidate.reviewedContent
			? computeOpaqueDigest(redactSensitiveText(candidate.reviewedContent.trim()))
			: null;
		const proj = this.getProjection(candidateId);

		// Idempotent / fail-closed handling for already-approved with projection
		if (candidate.status === "approved") {
			if (existingDigest && incomingDigest === existingDigest) return { success: true };
			return {
				success: false,
				error: proj
					? "already projected; content changed — requires rollback before re-approval"
					: "Candidate already approved; content changed requires rollback before re-approval",
			};
		}
		// projection_pending: verify digest, preserve reference/pending state on same content
		if (candidate.status === "projection_pending" && existingDigest) {
			if (existingDigest !== incomingDigest) {
				return {
					success: false,
					error: "already staged with projection; content changed — requires rollback before re-approval",
				};
			}
			return { success: true };
		}
		// Gate: only needs_review/projection_pending can be approved; pending/rejected cannot approve
		if (candidate.status !== "needs_review" && candidate.status !== "projection_pending") {
			return {
				success: false,
				error: `Candidate status ${candidate.status} not eligible for approve (requires needs_review)`,
			};
		}
		// Crash-safe: persist reviewed_content and projection_pending durably before external Mnemopi write.
		// Approved only after confirmed durable reference in projectToMnemopiReal.
		// Keep exact CAS on version + status, no duplicate, mode/privacy preserved.
		const now = Date.now();
		const stmt = this.#db.prepare(`
			UPDATE candidates
			SET reviewed_content = ?, status = 'projection_pending', version = version + 1, updated_at = ?
			WHERE id = ? AND version = ? AND (status = 'needs_review' OR status = 'projection_pending')
		`);
		const result = stmt.run(cleanContent, now, candidateId, candidate.version);
		if (result.changes > 0) {
			this.#recordEvent(candidateId, "approved", {
				contentDigest: computeOpaqueDigest(cleanContent),
				pendingProjection: true,
			});
			return { success: true };
		}
		return { success: false, error: "Concurrent modification or status changed" };
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
		// Append-only: record deletion audit BEFORE removing candidate so FK-less event persists.
		// learning_events is now FK-free to guarantee history survives candidate deletion.
		this.#recordEvent(candidateId, "deleted", { projectIdentity: candidate.projectIdentity, scope: candidate.scope });
		this.#db.transaction(() => {
			this.#db.prepare("DELETE FROM candidates WHERE id = ?").run(candidateId);
			this.#db
				.prepare(
					"INSERT OR REPLACE INTO tombstones (candidate_id, project_identity, scope, deleted_at) VALUES (?, ?, ?, ?)",
				)
				.run(candidateId, candidate.projectIdentity, candidate.scope, now);
		})();
		return true;
	}

	rollbackCandidate(candidateId: string, projectIdentity: string): boolean {
		const candidate = this.getCandidate(candidateId);
		if (candidate && candidate.projectIdentity !== projectIdentity && candidate.scope !== "global") return false;
		// Tombstone prevents resurrection
		const tomb = this.#db.prepare("SELECT candidate_id FROM tombstones WHERE candidate_id = ?").get(candidateId);
		if (tomb) return false;
		// Check projection reference exists
		const proj = this.#db
			.prepare("SELECT candidate_id FROM projection_references WHERE candidate_id = ?")
			.get(candidateId) as any;
		if (!proj) return false;
		this.#db.transaction(() => {
			this.#db.prepare("DELETE FROM projection_references WHERE candidate_id = ?").run(candidateId);
			if (candidate) {
				this.#db
					.prepare(
						"UPDATE candidates SET status = 'needs_review', version = version + 1, updated_at = ? WHERE id = ?",
					)
					.run(Date.now(), candidateId);
			}
		})();
		try {
			this.#recordEvent(candidateId, "rolled_back", {});
		} catch {}
		return true;
	}

	sweepExpired(): number {
		const now = Date.now();
		const rows = this.#db
			.prepare(`
			SELECT id, project_identity as projectIdentity FROM candidates WHERE (? - created_at) > ttl_ms AND status != 'approved' AND status != 'projection_pending'
		`)
			.all(now) as { id: string; projectIdentity: string }[];

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
		const rows = this.#db
			.prepare("SELECT id FROM candidates WHERE status = 'pending' AND verifier_name IS NOT NULL")
			.all() as { id: string }[];
		let n = 0;
		for (const r of rows) {
			this.#db
				.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
				.run(Date.now(), r.id);
			try {
				this.#recordEvent(r.id, "review_requested", { reason: "restart_recovery" });
			} catch {}
			n++;
		}
		return n;
	}

	projectToMnemopi(candidateId: string, mnemopiId: string, mnemopiBank?: string): boolean {
		const cand = this.getCandidate(candidateId);
		if ((cand?.status !== "approved" && cand?.status !== "projection_pending") || !cand.reviewedContent) return false;
		// Fail-closed: do not overwrite existing projection with different reference; preserve old reference to avoid orphaning
		const existing = this.getProjection(candidateId);
		if (existing) {
			const bank = mnemopiBank ?? bankForScope(cand.scope, cand.projectIdentity);
			if (existing.mnemopiId === mnemopiId && existing.bank === bank) return true;
			return false;
		}
		const bank = mnemopiBank ?? bankForScope(cand.scope, cand.projectIdentity);
		this.#db
			.prepare(
				"INSERT INTO projection_references (candidate_id, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(candidateId, cand.projectIdentity, cand.scope, mnemopiId, bank, Date.now());
		try {
			this.#recordEvent(candidateId, "projected", { mnemopiId, bank });
		} catch {}
		return true;
	}

	/**
	 * Persist reviewed content for retry when Mnemopi is unavailable.
	 * Keeps candidate in a retryable projection_pending state with reviewedContent.
	 * Idempotent: never demotes an already approved/projected candidate; preserves existing projection reference.
	 */
	stageForRetry(
		candidateId: string,
		reviewedContent: string,
		projectIdentity: string,
	): { success: boolean; error?: string } {
		const candidate = this.getCandidate(candidateId);
		if (!candidate) return { success: false, error: `Candidate not found: ${candidateId}` };
		if (candidate.projectIdentity !== projectIdentity && candidate.scope !== "global") {
			return { success: false, error: "Unauthorized project scope" };
		}
		if (
			candidate.status !== "needs_review" &&
			candidate.status !== "approved" &&
			candidate.status !== "projection_pending"
		) {
			return {
				success: false,
				error: `Candidate status ${candidate.status} not eligible for stage (requires needs_review)`,
			};
		}
		const tomb = this.#db.prepare("SELECT candidate_id FROM tombstones WHERE candidate_id = ?").get(candidateId);
		if (tomb) return { success: false, error: "Candidate deleted (tombstoned)" };
		const cleanContent = redactSensitiveText(reviewedContent.trim());
		if (!cleanContent || cleanContent.startsWith("Verified resolution for")) {
			return { success: false, error: "Meaningful reviewed content required" };
		}
		if (cleanContent.length > 8192) return { success: false, error: "Reviewed content too large" };
		const incomingDigest = computeOpaqueDigest(cleanContent);
		const existingDigest = candidate.reviewedContent
			? computeOpaqueDigest(redactSensitiveText(candidate.reviewedContent.trim()))
			: null;
		const proj = this.getProjection(candidateId);

		// Idempotent / fail-closed handling for candidates with existing projection
		if (proj) {
			if (existingDigest && incomingDigest === existingDigest) return { success: true };
			const msg =
				candidate.status === "approved"
					? "already projected; content changed — requires rollback before re-approval"
					: "already staged with projection; content changed — requires rollback before re-approval";
			return {
				success: false,
				error: existingDigest ? msg : "already staged with projection; requires rollback before re-approval",
			};
		}

		// Approved without projection: idempotent if same content
		if (candidate.status === "approved" && existingDigest && existingDigest === incomingDigest) {
			return { success: true };
		}
		const now = Date.now();
		const stmt = this.#db.prepare(`
			UPDATE candidates
			SET reviewed_content = ?, status = 'projection_pending', version = version + 1, updated_at = ?
			WHERE id = ? AND version = ?
		`);
		const result = stmt.run(cleanContent, now, candidateId, candidate.version);
		if (result.changes > 0) {
			this.#recordEvent(candidateId, "approved", { contentDigest: incomingDigest, pendingProjection: true });
			return { success: true };
		}
		return { success: false, error: "Concurrent modification or status changed" };
	}

	/** Real scoped Mnemopi projection: uses conservative target-bank resolution.
	 *  Requires explicit confirmed write result and exact bank/reference; null/throw => fail and retain retryable state.
	 *  Capability-gated: requires rememberScopedIdempotent with deterministic idempotencyKey for crash-safe retry;
	 *  absent capability returns needs_review without external mutation (no unsafe rememberScoped fallback).
	 *  Exact-bank verification requires getScopedMemoryInBank; cross-bank getScopedMemory alone is not trusted for same-ID foreign cases.
	 */
	async projectToMnemopiReal(
		candidateId: string,
		mnemopi: MnemopiProjectionClient,
		opts?: { targetBank?: string },
	): Promise<{ ok: boolean; mnemopiId?: string; error?: string }> {
		const cand = this.getCandidate(candidateId);
		if ((cand?.status !== "approved" && cand?.status !== "projection_pending") || !cand.reviewedContent)
			return { ok: false, error: "candidate not approved" };
		const redacted = redactSensitiveText(cand.reviewedContent);
		let targetBank: string | null = null;
		if (opts?.targetBank && typeof opts.targetBank === "string" && opts.targetBank.trim()) {
			targetBank = opts.targetBank.trim();
		} else {
			try {
				const h = mnemopi as unknown as {
					getScopedRetainTarget?: () => { bank: string } | null | undefined;
					bank?: unknown;
				};
				const retain = h.getScopedRetainTarget?.();
				if (retain && typeof retain.bank === "string" && retain.bank.trim()) {
					targetBank = retain.bank.trim();
				} else if (typeof h.bank === "string" && (h.bank as string).trim()) {
					targetBank = (h.bank as string).trim();
				}
			} catch {}
		}
		if (!targetBank) {
			targetBank = bankForScope(cand.scope, cand.projectIdentity);
		}
		// Idempotent reconciliation: if already projected, preserve existing reference and avoid second memory write
		const existing = this.getProjection(candidateId);
		if (existing) {
			if (existing.bank !== targetBank) {
				return {
					ok: false,
					error: `already projected with different bank ${existing.bank} != ${targetBank}; requires rollback`,
				};
			}
			if (hasExactBankReadCapability(mnemopi)) {
				try {
					const memExisting = (mnemopi as MnemopiExactBankReadCapability).getScopedMemoryInBank(
						existing.mnemopiId,
						targetBank,
					);
					if (!memExisting || typeof memExisting.bank !== "string" || !memExisting.bank.trim()) {
						return {
							ok: false,
							error: "existing projection not confirmed: missing bank/reference; requires rollback",
						};
					}
					if (memExisting.bank !== targetBank) {
						return {
							ok: false,
							error: `existing bank ${existing.bank} != actual memory bank ${memExisting.bank}; requires rollback`,
						};
					}
				} catch (e) {
					return { ok: false, error: e instanceof Error ? e.message.slice(0, 512) : String(e).slice(0, 512) };
				}
			} else if (typeof (mnemopi as unknown as { getScopedMemory?: unknown }).getScopedMemory === "function") {
				// Cross-bank fallback: if it returns foreign bank, fail closed; if missing capability, we still check but do not trust for same-ID foreign
				try {
					const h2 = mnemopi as unknown as {
						getScopedMemory?: (id: string) => { bank: string } | null | undefined;
					};
					const memExisting = h2.getScopedMemory?.(existing.mnemopiId);
					if (memExisting && typeof memExisting.bank === "string" && memExisting.bank.trim() !== targetBank) {
						return {
							ok: false,
							error: `existing bank ${existing.bank} != actual memory bank ${memExisting.bank}; requires rollback (cross-bank)`,
						};
					}
					if (!memExisting || typeof memExisting.bank !== "string" || !memExisting.bank.trim()) {
						// Without exact capability we cannot confirm; preserve needs_review instead of claiming success?
						// For backward compatibility, allow but mark needs_review if caller expects exact?
						// We treat missing exact as uncertain only when bank mismatch; absence alone is not fatal if local reference exists
					}
				} catch (e) {
					return { ok: false, error: e instanceof Error ? e.message.slice(0, 512) : String(e).slice(0, 512) };
				}
			}
			// Preserve existing reference; set approved atomically before return so durable reconciliation does not leave projection_pending
			try {
				this.#db
					.prepare(
						"UPDATE candidates SET status = 'approved', updated_at = ? WHERE id = ? AND status = 'projection_pending'",
					)
					.run(Date.now(), candidateId);
			} catch {}
			// Clean any stale projection intent
			try {
				this.#db
					.prepare("DELETE FROM operation_intents WHERE candidate_id = ? AND operation = 'projection'")
					.run(candidateId);
			} catch {}
			return { ok: true, mnemopiId: existing.mnemopiId };
		}
		const pendingIntent = this.getOperationIntent(candidateId);
		if (pendingIntent && pendingIntent.operation === "projection") {
			if (pendingIntent.mnemopiId === "__pending_projection__") {
				// Sentinel crash recovery: recompute deterministic key and replay idempotent write
				// Never call non-idempotent rememberScoped; preserve intent if capability unavailable
				const candForRecovery = this.getCandidate(candidateId);
				if (!candForRecovery || !candForRecovery.reviewedContent) {
					try {
						this.#db
							.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
							.run(Date.now(), candidateId);
					} catch {}
					return {
						ok: false,
						error: "sentinel recovery: missing candidate or reviewed content; intent preserved",
					};
				}
				if (!hasIdempotentWriteCapability(mnemopi)) {
					try {
						this.#db
							.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
							.run(Date.now(), candidateId);
					} catch {}
					return {
						ok: false,
						error: "sentinel recovery requires idempotent capability rememberScopedIdempotent; intent preserved for retry",
					};
				}
				const redactedRecovery = redactSensitiveText(candForRecovery.reviewedContent);
				const idempotencyKeyRecovery = computeIdempotencyKey(
					candidateId,
					redactedRecovery,
					candForRecovery.scope,
					candForRecovery.projectIdentity,
				);
				const targetBankRecovery = pendingIntent.mnemopiBank?.trim()
					? pendingIntent.mnemopiBank.trim()
					: bankForScope(candForRecovery.scope, candForRecovery.projectIdentity);
				let recoveredId: string | undefined;
				try {
					recoveredId = (mnemopi as MnemopiIdempotentWriteCapability).rememberScopedIdempotent(redactedRecovery, {
						scope: "bank",
						source: "custom-autolearn",
						idempotencyKey: idempotencyKeyRecovery,
						targetBank: targetBankRecovery,
					});
				} catch (e) {
					try {
						this.#db
							.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
							.run(Date.now(), candidateId);
					} catch {}
					return { ok: false, error: e instanceof Error ? e.message.slice(0, 512) : String(e).slice(0, 512) };
				}
				if (!recoveredId || typeof recoveredId !== "string" || !recoveredId.trim()) {
					try {
						this.#db
							.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
							.run(Date.now(), candidateId);
					} catch {}
					return { ok: false, error: "sentinel recovery: idempotent write returned no id; intent preserved" };
				}
				recoveredId = recoveredId.trim();
				try {
					this.#db
						.prepare(
							"INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
						)
						.run(
							candidateId,
							"projection",
							candForRecovery.projectIdentity,
							candForRecovery.scope,
							recoveredId,
							targetBankRecovery,
							Date.now(),
						);
				} catch {}
				let durableOkRecovery = false;
				try {
					this.#db.transaction(() => {
						this.#db
							.prepare(
								"UPDATE candidates SET status = 'projection_pending', updated_at = ? WHERE id = ? AND status != 'projection_pending'",
							)
							.run(Date.now(), candidateId);
						const ex = this.getProjection(candidateId);
						if (!ex) {
							this.#db
								.prepare(
									"INSERT INTO projection_references (candidate_id, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?)",
								)
								.run(
									candidateId,
									candForRecovery.projectIdentity,
									candForRecovery.scope,
									recoveredId,
									targetBankRecovery,
									Date.now(),
								);
							try {
								this.#recordEvent(candidateId, "projected", {
									mnemopiId: recoveredId,
									bank: targetBankRecovery,
								});
							} catch {}
						} else if (ex.mnemopiId !== recoveredId || ex.bank !== targetBankRecovery) {
							throw new Error("projection conflict during sentinel recovery");
						}
					})();
					durableOkRecovery = true;
				} catch {
					durableOkRecovery = false;
				}
				if (!durableOkRecovery) {
					try {
						this.#db
							.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
							.run(Date.now(), candidateId);
					} catch {}
					return {
						ok: false,
						error: "sentinel recovery: projection persistence failed; intent updated with recovered id for retry",
					};
				}
				if (hasExactBankReadCapability(mnemopi)) {
					let mem: { bank: string } | null | undefined;
					try {
						mem = (mnemopi as MnemopiExactBankReadCapability).getScopedMemoryInBank(
							recoveredId,
							targetBankRecovery,
						);
					} catch (e) {
						try {
							this.#db
								.prepare("UPDATE candidates SET status = 'projection_pending', updated_at = ? WHERE id = ?")
								.run(Date.now(), candidateId);
						} catch {}
						return { ok: false, error: e instanceof Error ? e.message.slice(0, 512) : String(e).slice(0, 512) };
					}
					if (!mem || typeof mem.bank !== "string" || !mem.bank.trim()) {
						try {
							this.#db
								.prepare("UPDATE candidates SET status = 'projection_pending', updated_at = ? WHERE id = ?")
								.run(Date.now(), candidateId);
						} catch {}
						return { ok: false, error: "sentinel recovery: projection not confirmed: missing bank/reference" };
					}
					if (mem.bank !== targetBankRecovery) {
						try {
							this.#db
								.prepare(
									"INSERT OR REPLACE INTO projection_references (candidate_id, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?)",
								)
								.run(
									candidateId,
									candForRecovery.projectIdentity,
									candForRecovery.scope,
									recoveredId,
									mem.bank,
									Date.now(),
								);
							this.#db
								.prepare(
									"INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
								)
								.run(
									candidateId,
									"projection",
									candForRecovery.projectIdentity,
									candForRecovery.scope,
									recoveredId,
									mem.bank,
									Date.now(),
								);
							this.#db
								.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
								.run(Date.now(), candidateId);
						} catch {}
						return {
							ok: false,
							error: `sentinel recovery: stored bank ${targetBankRecovery} != actual write bank ${mem.bank}; preserved actual bank for reconciliation`,
						};
					}
				}
				try {
					this.#db
						.prepare("UPDATE candidates SET status = 'approved', updated_at = ? WHERE id = ?")
						.run(Date.now(), candidateId);
				} catch {
					return {
						ok: false,
						error: "sentinel recovery: status persist failed after durable reference; retry required",
					};
				}
				try {
					this.#db
						.prepare(
							"DELETE FROM operation_intents WHERE candidate_id = ? AND operation IN ('projection', 'projection_cleanup')",
						)
						.run(candidateId);
				} catch {}
				return { ok: true, mnemopiId: recoveredId };
			}
			const curProjForIntent = this.getProjection(candidateId);
			if (!curProjForIntent && pendingIntent.mnemopiId && pendingIntent.mnemopiId !== "__pending_projection__") {
				let confirmed = false;
				if (hasExactBankReadCapability(mnemopi)) {
					try {
						const memForIntent = (mnemopi as MnemopiExactBankReadCapability).getScopedMemoryInBank(
							pendingIntent.mnemopiId,
							pendingIntent.mnemopiBank,
						);
						confirmed = memForIntent?.bank?.trim() === pendingIntent.mnemopiBank;
					} catch {}
				} else if (typeof (mnemopi as unknown as { getScopedMemory?: unknown }).getScopedMemory === "function") {
					try {
						const hh = mnemopi as unknown as {
							getScopedMemory: (id: string) => { bank: string } | null | undefined;
						};
						const memForIntent = hh.getScopedMemory?.(pendingIntent.mnemopiId);
						confirmed = memForIntent?.bank?.trim() === pendingIntent.mnemopiBank;
					} catch {}
				}
				if (confirmed) {
					try {
						this.#db.transaction(() => {
							const cur2 = this.getProjection(candidateId);
							if (!cur2) {
								this.#db
									.prepare(
										"INSERT INTO projection_references (candidate_id, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?)",
									)
									.run(
										candidateId,
										pendingIntent.projectIdentity,
										pendingIntent.scope,
										pendingIntent.mnemopiId,
										pendingIntent.mnemopiBank,
										Date.now(),
									);
								try {
									this.#recordEvent(candidateId, "projected", {
										mnemopiId: pendingIntent.mnemopiId,
										bank: pendingIntent.mnemopiBank,
									});
								} catch {}
							}
							this.#db
								.prepare("UPDATE candidates SET status = 'approved', updated_at = ? WHERE id = ?")
								.run(Date.now(), candidateId);
							this.#db
								.prepare("DELETE FROM operation_intents WHERE candidate_id = ? AND operation = 'projection'")
								.run(candidateId);
						})();
						return { ok: true, mnemopiId: pendingIntent.mnemopiId };
					} catch {}
				}
				try {
					this.#db
						.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
						.run(Date.now(), candidateId);
				} catch {}
				return {
					ok: false,
					error: "projection intent with real id pending reconciliation; retry blocked to prevent duplicate; use recoverOperationIntents",
				};
			}
		}
		// Gate on idempotent capability before any external mutation. No fallback to non-idempotent rememberScoped.
		if (!hasIdempotentWriteCapability(mnemopi)) {
			try {
				this.#db
					.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
					.run(Date.now(), candidateId);
			} catch {}
			return {
				ok: false,
				error: "missing idempotent write capability rememberScopedIdempotent; needs_review without external mutation",
			};
		}
		// Durable projection intent before external write: crash leaves pending with intent for retry, never orphan approved
		try {
			this.#db
				.prepare(
					"INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					candidateId,
					"projection",
					cand.projectIdentity,
					cand.scope,
					"__pending_projection__",
					targetBank,
					Date.now(),
				);
		} catch {
			// If intent persist fails, remain pending for retry; do not proceed to external write without durable marker
			return { ok: false, error: "projection intent persist failed before external write" };
		}
		const idempotencyKey = computeIdempotencyKey(candidateId, redacted, cand.scope, cand.projectIdentity);
		let mnemopiId: string | undefined;
		try {
			mnemopiId = (mnemopi as MnemopiIdempotentWriteCapability).rememberScopedIdempotent(redacted, {
				scope: "bank",
				source: "custom-autolearn",
				idempotencyKey,
				targetBank,
			});
		} catch (e) {
			try {
				this.#db
					.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
					.run(Date.now(), candidateId);
			} catch {}
			try {
				this.#db
					.prepare("DELETE FROM operation_intents WHERE candidate_id = ? AND operation = 'projection'")
					.run(candidateId);
			} catch {}
			return { ok: false, error: e instanceof Error ? e.message.slice(0, 512) : String(e).slice(0, 512) };
		}
		if (!mnemopiId || typeof mnemopiId !== "string" || !mnemopiId.trim()) {
			try {
				this.#db
					.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
					.run(Date.now(), candidateId);
			} catch {}
			try {
				this.#db
					.prepare("DELETE FROM operation_intents WHERE candidate_id = ? AND operation = 'projection'")
					.run(candidateId);
			} catch {}
			return { ok: false, error: "mnemopi projection failed: no id returned" };
		}
		// Update durable intent with actual mnemopiId before local persist, so crash after external write can be reconciled
		try {
			this.#db
				.prepare(
					"INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(candidateId, "projection", cand.projectIdentity, cand.scope, mnemopiId, targetBank, Date.now());
		} catch {}
		// Durable: persist returned ID + target bank before verification so retry can reconcile/delete and never orphan.
		// Fail-closed: if local durable persistence fails, never report success; attempt compensated external cleanup after durable fallback intent.
		let durableOk = false;
		try {
			this.#db.transaction(() => {
				this.#db
					.prepare(
						"UPDATE candidates SET status = 'projection_pending', updated_at = ? WHERE id = ? AND status != 'projection_pending'",
					)
					.run(Date.now(), candidateId);
				const ex = this.getProjection(candidateId);
				if (!ex) {
					this.#db
						.prepare(
							"INSERT INTO projection_references (candidate_id, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?)",
						)
						.run(candidateId, cand.projectIdentity, cand.scope, mnemopiId, targetBank, Date.now());
					try {
						this.#recordEvent(candidateId, "projected", { mnemopiId, bank: targetBank });
					} catch {}
				} else if (ex.mnemopiId !== mnemopiId || ex.bank !== targetBank) {
					throw new Error("projection conflict");
				}
			})();
			durableOk = true;
		} catch {
			durableOk = false;
		}
		if (!durableOk) {
			// Try to persist a fallback intent so a future retry/recovery can clean up the orphan
			let fallbackPersisted = false;
			try {
				const fr = this.#db
					.prepare(
						"INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						candidateId,
						"projection_cleanup",
						cand.projectIdentity,
						cand.scope,
						mnemopiId,
						targetBank,
						Date.now(),
					);
				const ch = (fr as unknown as { changes?: number })?.changes;
				fallbackPersisted = typeof ch === "number" ? ch === 1 : true;
				if (typeof ch === "number" && ch !== 1) fallbackPersisted = false;
			} catch {
				fallbackPersisted = false;
			}
			if (fallbackPersisted && hasExactBankEditCapability(mnemopi)) {
				try {
					const projCleanup = { mnemopiId, bank: targetBank };
					const cleaned = this.#cleanMnemopiProjection(
						candidateId,
						projCleanup,
						mnemopi as unknown as MnemopiProjectionClient,
						"projection_cleanup",
					);
					if (cleaned) {
						try {
							this.#db
								.prepare(
									"DELETE FROM operation_intents WHERE candidate_id = ? AND operation = 'projection_cleanup' AND mnemopi_id = ? AND mnemopi_bank = ?",
								)
								.run(candidateId, mnemopiId, targetBank);
						} catch {}
						try {
							// Preserve first valid reference: delete only if row matches compensated id and bank
							const cur = this.getProjection(candidateId);
							if (cur && cur.mnemopiId === mnemopiId && cur.bank === targetBank) {
								this.#db
									.prepare(
										"DELETE FROM projection_references WHERE candidate_id = ? AND mnemopi_id = ? AND mnemopi_bank = ?",
									)
									.run(candidateId, mnemopiId, targetBank);
							}
						} catch {}
						try {
							this.#db
								.prepare(
									"DELETE FROM operation_intents WHERE candidate_id = ? AND operation = 'projection' AND mnemopi_bank = ?",
								)
								.run(candidateId, targetBank);
						} catch {}
					}
				} catch {}
			}
			try {
				this.#db
					.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
					.run(Date.now(), candidateId);
			} catch {}
			return {
				ok: false,
				error: "projection persistence failed: local durable reference not persisted; external memory may require manual reconciliation",
			};
		}
		if (hasExactBankReadCapability(mnemopi)) {
			let mem: { bank: string } | null | undefined;
			try {
				mem = (mnemopi as MnemopiExactBankReadCapability).getScopedMemoryInBank(mnemopiId, targetBank);
			} catch (e) {
				try {
					this.#db
						.prepare("UPDATE candidates SET status = 'projection_pending', updated_at = ? WHERE id = ?")
						.run(Date.now(), candidateId);
				} catch {}
				return { ok: false, error: e instanceof Error ? e.message.slice(0, 512) : String(e).slice(0, 512) };
			}
			if (!mem || typeof mem.bank !== "string" || !mem.bank.trim()) {
				try {
					this.#db
						.prepare("UPDATE candidates SET status = 'projection_pending', updated_at = ? WHERE id = ?")
						.run(Date.now(), candidateId);
				} catch {}
				return { ok: false, error: "mnemopi projection not confirmed: missing bank/reference" };
			}
			if (mem.bank !== targetBank) {
				try {
					this.#db
						.prepare(
							"INSERT OR REPLACE INTO projection_references (candidate_id, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?)",
						)
						.run(candidateId, cand.projectIdentity, cand.scope, mnemopiId, mem.bank, Date.now());
					this.#db
						.prepare(
							"INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
						)
						.run(candidateId, "projection", cand.projectIdentity, cand.scope, mnemopiId, mem.bank, Date.now());
					this.#db
						.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
						.run(Date.now(), candidateId);
				} catch {}
				return {
					ok: false,
					error: `stored bank ${targetBank} != actual write bank ${mem.bank}; preserved actual bank for reconciliation`,
				};
			}
		} else if (typeof (mnemopi as unknown as { getScopedMemory?: unknown }).getScopedMemory === "function") {
			let mem: { bank: string } | null | undefined;
			try {
				const h2 = mnemopi as unknown as { getScopedMemory?: (id: string) => { bank: string } | null | undefined };
				mem = h2.getScopedMemory?.(mnemopiId);
			} catch (e) {
				try {
					this.#db
						.prepare("UPDATE candidates SET status = 'projection_pending', updated_at = ? WHERE id = ?")
						.run(Date.now(), candidateId);
				} catch {}
				return { ok: false, error: e instanceof Error ? e.message.slice(0, 512) : String(e).slice(0, 512) };
			}
			if (!mem || typeof mem.bank !== "string" || !mem.bank.trim()) {
				try {
					this.#db
						.prepare("UPDATE candidates SET status = 'projection_pending', updated_at = ? WHERE id = ?")
						.run(Date.now(), candidateId);
				} catch {}
				return { ok: false, error: "mnemopi projection not confirmed: missing bank/reference" };
			}
			if (mem.bank !== targetBank) {
				try {
					this.#db
						.prepare(
							"INSERT OR REPLACE INTO projection_references (candidate_id, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?)",
						)
						.run(candidateId, cand.projectIdentity, cand.scope, mnemopiId, mem.bank, Date.now());
					this.#db
						.prepare(
							"INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
						)
						.run(candidateId, "projection", cand.projectIdentity, cand.scope, mnemopiId, mem.bank, Date.now());
					this.#db
						.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
						.run(Date.now(), candidateId);
				} catch {}
				return {
					ok: false,
					error: `stored bank ${targetBank} != actual write bank ${mem.bank}; preserved actual bank for reconciliation`,
				};
			}
		}
		// Ensure projection reference exists (already persisted durable before verification); verify idempotence.
		const existingAfter = this.getProjection(candidateId);
		if (!existingAfter || existingAfter.mnemopiId !== mnemopiId) {
			const inserted = this.projectToMnemopi(candidateId, mnemopiId, targetBank);
			if (
				!inserted &&
				(!this.getProjection(candidateId) || this.getProjection(candidateId)?.mnemopiId !== mnemopiId)
			) {
				return { ok: false, error: "projection already exists; requires rollback before re-projection" };
			}
		}
		try {
			this.#db
				.prepare("UPDATE candidates SET status = 'approved', updated_at = ? WHERE id = ?")
				.run(Date.now(), candidateId);
		} catch {
			// If final status flip fails, keep projection_pending for retry reconciliation; do not report success as approved
			return { ok: false, error: "projection status persist failed after durable reference; retry required" };
		}
		// Success: clear durable projection intents
		try {
			this.#db
				.prepare(
					"DELETE FROM operation_intents WHERE candidate_id = ? AND operation IN ('projection', 'projection_cleanup')",
				)
				.run(candidateId);
		} catch {}
		return { ok: true, mnemopiId };
	}

	getProjection(
		candidateId: string,
	): { mnemopiId: string; bank: string; scope: string; projectIdentity: string } | null {
		const row = this.#db
			.prepare(
				"SELECT candidate_id as candidateId, mnemopi_id as mnemopiId, mnemopi_bank as bank, scope, project_identity as projectIdentity FROM projection_references WHERE candidate_id = ?",
			)
			.get(candidateId) as any;
		if (!row) return null;
		return {
			mnemopiId: row.mnemopiId,
			bank: row.bank ?? bankForScope(row.scope, row.projectIdentity),
			scope: row.scope,
			projectIdentity: row.projectIdentity,
		};
	}

	/**
	 * Clean Mnemopi projection references and scoped memory for delete/rollback operations.
	 * Conservative on failure: preserves projection and marks needs_review if backend is uncertain.
	 * Capability-gated: requires exact-bank resolver and edit (getScopedMemoryInBank/editScopedMemoryInBank)
	 * before any mutation. Cross-bank getScopedMemory/editScopedMemory first-hit is unsafe for same-ID foreign cases.
	 * State machine against real mnemopi/state.ts editScopedMemory:
	 * - forget success (deleted/invalidated) with stored bank confirms cleanup; do not call invalidate
	 *   (working forget mutates DB, subsequent invalidate would be bankless not_found)
	 * - episodic forget returns not_found (bank-tied) -> fallback to invalidate and require bank-tied success
	 * - any bankless not_found after operation that may leave memory fails closed (preserve projection)
	 */
	#cleanMnemopiProjection(
		candidateId: string,
		proj: { mnemopiId: string; bank: string },
		mnemopi: MnemopiProjectionClient,
		actionReason: string,
	): boolean {
		const isProjectionCleanup = actionReason.includes("projection_cleanup");
		const markUncertain = (reason: string, details?: Record<string, unknown>): false => {
			try {
				this.#db
					.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
					.run(Date.now(), candidateId);
			} catch {}
			try {
				this.#recordEvent(candidateId, "review_requested", { reason, ...details });
			} catch {}
			return false;
		};

		// Strict capability gate: require exact-bank read and edit before any mutation.
		if (!hasExactBankReadCapability(mnemopi) || !hasExactBankEditCapability(mnemopi)) {
			return markUncertain(`${actionReason}_missing_exact_bank_capability`, { expectedBank: proj.bank });
		}

		// Inaccessible bank must be treated as uncertain: never clear local reference/candidate when we cannot inspect the stored bank.
		const accessible = isBankAccessibleForClient(mnemopi, proj.bank);
		if (accessible === false) {
			return markUncertain(`${actionReason}_bank_inaccessible`, { expectedBank: proj.bank });
		}

		const isBankMatch = (bank?: string): boolean => typeof bank === "string" && bank.trim() === proj.bank;

		// Exact-bank introspection: confirm presence/absence in stored bank before mutation.
		// Never call edit when exact read shows foreign or confirms absence without needing mutation.
		const exactHit = (() => {
			try {
				return (mnemopi as MnemopiExactBankReadCapability).getScopedMemoryInBank(proj.mnemopiId, proj.bank);
			} catch {
				return undefined;
			}
		})();

		// If exact read confirms absence (null), we can consider cleanup idempotent without edit, unless projection_cleanup requires explicit banked invalidate.
		// For projection_cleanup (orphan), we still attempt edit to get explicit banked success rather than assuming idempotent.
		if (exactHit === null && !isProjectionCleanup) {
			// Absent in stored bank and not projection_cleanup -> treat as already cleaned.
			return true;
		}
		// For projection_cleanup with null, fall through to edit attempt for explicit confirmation.
		if (
			exactHit !== undefined &&
			exactHit !== null &&
			typeof exactHit === "object" &&
			"bank" in (exactHit as Record<string, unknown>)
		) {
			const b = (exactHit as Record<string, unknown>).bank;
			if (typeof b === "string" && b.trim() !== proj.bank) {
				// Foreign bank hit for exact query should not happen, but treat as mismatch -> do not mutate foreign
				return markUncertain("mnemopi_bank_mismatch", { expectedBank: proj.bank, actualBank: b });
			}
		}
		// If exact read threw or returned undefined, we proceed to edit but will still require bank-matched success.

		const runOpInBank = (
			op: "forget" | "invalidate",
		): { ok: boolean; status?: string; bank?: string; err?: string } => {
			try {
				const res = (mnemopi as MnemopiExactBankEditCapability).editScopedMemoryInBank(
					op,
					proj.mnemopiId,
					proj.bank,
				);
				if (!res || typeof res !== "object" || !("status" in (res as Record<string, unknown>))) {
					return { ok: false, err: `${op} returned non-object or missing status` };
				}
				const rec = res as Record<string, unknown>;
				return { ok: true, status: rec.status as string, bank: rec.bank as string | undefined };
			} catch (e) {
				return { ok: false, err: String(e).slice(0, 512) };
			}
		};

		const fRes = runOpInBank("forget");
		if (!fRes.ok) {
			return markUncertain(actionReason, { forgetError: fRes.err });
		}

		// Forget succeeded: working memory deleted (or invalidated). Confirmed - do not call invalidate.
		if (fRes.status === "deleted" || fRes.status === "invalidated") {
			if (!isBankMatch(fRes.bank)) {
				return markUncertain("mnemopi_bank_mismatch", { expectedBank: proj.bank, actualBank: fRes.bank });
			}
			return true;
		}

		// Only on explicit not_found with matching bank do we fallback to invalidate (episodic path).
		if (fRes.status === "not_found") {
			if (!isBankMatch(fRes.bank)) {
				return markUncertain(actionReason, { forgetError: `forget status not_found bank=${String(fRes.bank)}` });
			}
			const forgetDesc = `forget status not_found bank=${String(fRes.bank)}`;
			const iRes = runOpInBank("invalidate");
			if (!iRes.ok) {
				return markUncertain(actionReason, { forgetError: forgetDesc, invalidateError: iRes.err });
			}
			if (iRes.status === "invalidated" || iRes.status === "deleted") {
				if (!isBankMatch(iRes.bank)) {
					return markUncertain("mnemopi_bank_mismatch", { expectedBank: proj.bank, actualBank: iRes.bank });
				}
				return true;
			}
			return markUncertain(actionReason, {
				forgetError: forgetDesc,
				invalidateError: `invalidate status ${String(iRes.status)} bank=${String(iRes.bank)}`,
			});
		}

		// Any other forget status (not_editable, unexpected) -> fail closed, preserve projection
		return markUncertain(actionReason, {
			forgetError: `forget status ${String(fRes.status)} bank=${String(fRes.bank)}`,
		});
	}

	/** Delete candidate and its exact Mnemopi projection (scoped to the stored bank). Conservative on failure: preserves projection and marks needs_review if backend is uncertain.
	 *  Durable: persists operation intent before external call so crash between intent and external/local commit can be reconciled on restart.
	 *  Capability-gated: requires exact-bank read+edit; otherwise preserve without mutation.
	 */
	deleteCandidateWithMnemopi(
		candidateId: string,
		projectIdentity: string,
		mnemopi?: MnemopiProjectionClient | null,
	): boolean {
		const proj = this.getProjection(candidateId);
		const candidate = this.getCandidate(candidateId);
		if (!candidate) return false;
		if (candidate.projectIdentity !== projectIdentity && candidate.scope !== "global") return false;
		if (proj) {
			if (!proj.bank || !proj.mnemopiId) {
				try {
					this.#db
						.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
						.run(Date.now(), candidateId);
				} catch {}
				try {
					this.#recordEvent(candidateId, "review_requested", { reason: "missing_projection_bank" });
				} catch {}
				return false;
			}
			if (!mnemopi) {
				try {
					this.#db
						.prepare("UPDATE candidates SET status = 'projection_pending', updated_at = ? WHERE id = ?")
						.run(Date.now(), candidateId);
				} catch {}
				try {
					this.#recordEvent(candidateId, "review_requested", { reason: "mnemopi_required_for_delete" });
				} catch {}
				return false;
			}
			// Durable intent before external call — mandatory, fail closed if cannot persist
			let intentPersisted = false;
			try {
				const r = this.#db
					.prepare(
						"INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						candidateId,
						"delete",
						candidate.projectIdentity,
						candidate.scope,
						proj.mnemopiId,
						proj.bank,
						Date.now(),
					);
				const ch = (r as unknown as { changes?: number })?.changes;
				intentPersisted = typeof ch === "number" ? ch === 1 : true;
				if (typeof ch === "number" && ch !== 1) intentPersisted = false;
			} catch {
				intentPersisted = false;
			}
			if (!intentPersisted) {
				try {
					this.#db
						.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
						.run(Date.now(), candidateId);
				} catch {}
				try {
					this.#recordEvent(candidateId, "review_requested", {
						reason: "intent_persist_failed",
						operation: "delete",
					});
				} catch {}
				return false;
			}
			try {
				this.#recordEvent(candidateId, "delete_intent", {
					operation: "delete",
					mnemopiId: proj.mnemopiId,
					bank: proj.bank,
				});
			} catch {}
			const ok = this.#cleanMnemopiProjection(candidateId, proj, mnemopi, "mnemopi_delete_uncertain");
			if (!ok) return false;
			// External succeeded: perform local deletion and clear intent atomically
			this.#db.transaction(() => {
				this.#recordEvent(candidateId, "deleted", {
					projectIdentity: candidate.projectIdentity,
					scope: candidate.scope,
				});
				this.#db.prepare("DELETE FROM candidates WHERE id = ?").run(candidateId);
				this.#db
					.prepare(
						"INSERT OR REPLACE INTO tombstones (candidate_id, project_identity, scope, deleted_at) VALUES (?, ?, ?, ?)",
					)
					.run(candidateId, candidate.projectIdentity, candidate.scope, Date.now());
				this.#db.prepare("DELETE FROM projection_references WHERE candidate_id = ?").run(candidateId);
				this.#db.prepare("DELETE FROM operation_intents WHERE candidate_id = ?").run(candidateId);
			})();
			return true;
		}
		const ok = this.deleteCandidate(candidateId, projectIdentity);
		if (ok) {
			try {
				this.#db.prepare("DELETE FROM projection_references WHERE candidate_id = ?").run(candidateId);
				this.#db.prepare("DELETE FROM operation_intents WHERE candidate_id = ?").run(candidateId);
			} catch {}
		}
		return ok;
	}

	/** Rollback candidate and delete its exact Mnemopi bank entry. Conservative on failure: preserves projection and marks needs_review if backend is uncertain.
	 *  Durable: persists operation intent before external call.
	 *  Capability-gated: requires exact-bank read+edit.
	 */
	rollbackCandidateWithMnemopi(
		candidateId: string,
		projectIdentity: string,
		mnemopi?: MnemopiProjectionClient | null,
	): boolean {
		const proj = this.getProjection(candidateId);
		if (!proj || !proj.bank || !proj.mnemopiId) return false;
		const tomb = this.#db.prepare("SELECT candidate_id FROM tombstones WHERE candidate_id = ?").get(candidateId);
		if (tomb) return false;
		if (proj.projectIdentity !== projectIdentity && proj.scope !== "global") return false;
		if (!mnemopi) {
			try {
				this.#db
					.prepare("UPDATE candidates SET status = 'projection_pending', updated_at = ? WHERE id = ?")
					.run(Date.now(), candidateId);
			} catch {}
			try {
				this.#recordEvent(candidateId, "review_requested", { reason: "mnemopi_required_for_rollback" });
			} catch {}
			return false;
		}
		const candidate = this.getCandidate(candidateId);
		// Durable intent before external call — mandatory, fail closed if cannot persist
		let intentPersisted = false;
		try {
			const r = this.#db
				.prepare(
					"INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(candidateId, "rollback", proj.projectIdentity, proj.scope, proj.mnemopiId, proj.bank, Date.now());
			const ch = (r as unknown as { changes?: number })?.changes;
			intentPersisted = typeof ch === "number" ? ch === 1 : true;
			if (typeof ch === "number" && ch !== 1) intentPersisted = false;
		} catch {
			intentPersisted = false;
		}
		if (!intentPersisted) {
			try {
				this.#db
					.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
					.run(Date.now(), candidateId);
			} catch {}
			try {
				this.#recordEvent(candidateId, "review_requested", {
					reason: "intent_persist_failed",
					operation: "rollback",
				});
			} catch {}
			return false;
		}
		try {
			this.#recordEvent(candidateId, "rollback_intent", {
				operation: "rollback",
				mnemopiId: proj.mnemopiId,
				bank: proj.bank,
			});
		} catch {}
		const ok = this.#cleanMnemopiProjection(candidateId, proj, mnemopi, "mnemopi_rollback_uncertain");
		if (!ok) return false;
		// External succeeded: clear projection and set needs_review, clear intent
		this.#db.transaction(() => {
			this.#db.prepare("DELETE FROM projection_references WHERE candidate_id = ?").run(candidateId);
			if (candidate) {
				this.#db
					.prepare(
						"UPDATE candidates SET status = 'needs_review', version = version + 1, updated_at = ? WHERE id = ?",
					)
					.run(Date.now(), candidateId);
			}
			this.#db.prepare("DELETE FROM operation_intents WHERE candidate_id = ?").run(candidateId);
		})();
		try {
			this.#recordEvent(candidateId, "rolled_back", {});
		} catch {}
		return true;
	}

	getOperationIntent(candidateId: string): {
		operation: string;
		projectIdentity: string;
		scope: string;
		mnemopiId: string;
		mnemopiBank: string;
		createdAt: number;
	} | null {
		try {
			const row = this.#db
				.prepare(
					"SELECT candidate_id as candidateId, operation, project_identity as projectIdentity, scope, mnemopi_id as mnemopiId, mnemopi_bank as mnemopiBank, created_at as createdAt FROM operation_intents WHERE candidate_id = ?",
				)
				.get(candidateId) as
				| {
						operation: string;
						projectIdentity: string;
						scope: string;
						mnemopiId: string;
						mnemopiBank: string;
						createdAt: number;
				  }
				| undefined;
			if (!row) return null;
			return {
				operation: row.operation,
				projectIdentity: row.projectIdentity,
				scope: row.scope,
				mnemopiId: row.mnemopiId,
				mnemopiBank: row.mnemopiBank,
				createdAt: row.createdAt,
			};
		} catch {
			return null;
		}
	}
	recoverOperationIntents(mnemopi?: MnemopiProjectionClient | null): number {
		let rows: {
			candidate_id: string;
			operation: string;
			project_identity: string;
			scope: string;
			mnemopi_id: string;
			mnemopi_bank: string;
		}[] = [];
		try {
			rows = this.#db
				.prepare(
					"SELECT candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank FROM operation_intents",
				)
				.all() as typeof rows;
		} catch {
			return 0;
		}
		// Build set of banks accessible in current session (retain/recall/global). Inaccessible foreign intents remain untouched.
		const accessibleBanks = new Set<string>();
		if (mnemopi) {
			try {
				const h = mnemopi as unknown as {
					getScopedRetainTarget?: () => { bank?: string } | null | undefined;
					getScopedRecallTargets?: () => readonly { bank?: string }[];
					scoped?: { retain?: { bank?: string }; recall?: { bank?: string }[]; global?: { bank?: string } };
					global?: { bank?: string };
					bank?: string;
				};
				const addBank = (b?: string | null): void => {
					if (typeof b === "string" && b.trim()) accessibleBanks.add(b.trim());
				};
				addBank(h.getScopedRetainTarget?.()?.bank);
				addBank(h.scoped?.retain?.bank);
				addBank(h.scoped?.global?.bank);
				addBank(h.global?.bank);
				addBank(h.bank);
				const targets = h.getScopedRecallTargets?.() ?? h.scoped?.recall;
				if (Array.isArray(targets)) {
					for (const t of targets) addBank(t?.bank);
				}
			} catch {}
		}
		const isBankAccessible = (bank: string): boolean => {
			if (accessibleBanks.size === 0) return true;
			return accessibleBanks.has(bank.trim());
		};
		let recovered = 0;
		for (const r of rows) {
			const proj = { mnemopiId: r.mnemopi_id, bank: r.mnemopi_bank };
			const candidateId = r.candidate_id;
			// Foreign-bank filter: do not touch intents whose stored bank is not in current session's accessible targets
			if (!isBankAccessible(r.mnemopi_bank)) {
				// Leave pending/needs_review untouched, no edit
				continue;
			}
			const clearIntent = (op?: string, id?: string, bank?: string): void => {
				try {
					if (id && bank) {
						this.#db
							.prepare(
								"DELETE FROM operation_intents WHERE candidate_id = ? AND mnemopi_id = ? AND mnemopi_bank = ?",
							)
							.run(candidateId, id, bank);
					} else if (op) {
						this.#db
							.prepare("DELETE FROM operation_intents WHERE candidate_id = ? AND operation = ?")
							.run(candidateId, op);
					} else {
						this.#db.prepare("DELETE FROM operation_intents WHERE candidate_id = ?").run(candidateId);
					}
				} catch {}
			};
			const deleteMatchingProjRef = (id?: string, bank?: string): void => {
				try {
					const cur = this.getProjection(candidateId);
					if (!cur) {
						this.#db.prepare("DELETE FROM projection_references WHERE candidate_id = ?").run(candidateId);
					} else if (!id || (cur.mnemopiId === id && (!bank || cur.bank === bank))) {
						this.#db
							.prepare(
								"DELETE FROM projection_references WHERE candidate_id = ? AND mnemopi_id = ? AND mnemopi_bank = ?",
							)
							.run(candidateId, cur.mnemopiId, cur.bank);
					}
				} catch {}
			};
			if (r.operation === "projection") {
				const cand = this.getCandidate(candidateId);
				if (!cand) {
					if (r.mnemopi_id !== "__pending_projection__" && mnemopi) {
						const ok = this.#cleanMnemopiProjection(candidateId, proj, mnemopi, "projection_cleanup_retry");
						if (ok) {
							clearIntent("projection");
							recovered++;
						}
					} else {
						clearIntent("projection");
						recovered++;
					}
					continue;
				}
				const curProj = this.getProjection(candidateId);
				if (cand.status === "approved" && curProj) {
					clearIntent("projection");
					recovered++;
					continue;
				}
				if (r.mnemopi_id === "__pending_projection__") {
					if (cand.status === "projection_pending" && curProj && curProj.mnemopiId !== "__pending_projection__") {
						clearIntent("projection");
						try {
							this.#db
								.prepare(
									"UPDATE candidates SET status = 'approved', updated_at = ? WHERE id = ? AND status = 'projection_pending'",
								)
								.run(Date.now(), candidateId);
						} catch {}
						recovered++;
						continue;
					}
					// Sentinel without projection: attempt idempotent recovery via deterministic key
					// Never call non-idempotent rememberScoped; preserve intent if capability unavailable
					if (cand && cand.reviewedContent && mnemopi && hasIdempotentWriteCapability(mnemopi)) {
						const redactedRec = redactSensitiveText(cand.reviewedContent);
						const keyRec = computeIdempotencyKey(candidateId, redactedRec, cand.scope, cand.projectIdentity);
						const bankRec = r.mnemopi_bank?.trim()
							? r.mnemopi_bank.trim()
							: bankForScope(cand.scope, cand.projectIdentity);
						let recId: string | undefined;
						try {
							recId = (mnemopi as MnemopiIdempotentWriteCapability).rememberScopedIdempotent(redactedRec, {
								scope: "bank",
								source: "custom-autolearn",
								idempotencyKey: keyRec,
								targetBank: bankRec,
							});
						} catch {}
						if (recId && typeof recId === "string" && recId.trim()) {
							const safeRecId = recId.trim();
							if (!safeRecId) continue;
							const safeBankRec = typeof bankRec === "string" ? bankRec : "";
							if (!safeBankRec) continue;
							// Fail-closed narrowing: required SQL bindings must be non-empty strings
							const safeProjectIdentity = typeof r.project_identity === "string" ? r.project_identity.trim() : "";
							const safeScope = typeof r.scope === "string" ? r.scope.trim() : "";
							const safeCandidateId = typeof candidateId === "string" ? candidateId.trim() : "";
							if (!safeCandidateId || !safeProjectIdentity || !safeScope) continue;
							try {
								this.#db
									.prepare(
										"INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
									)
									.run(safeCandidateId, "projection", safeProjectIdentity, safeScope, safeRecId, safeBankRec, Date.now());
							} catch {}
							try {
								this.#db.transaction(() => {
									const cur2 = this.getProjection(safeCandidateId);
									if (!cur2) {
										this.#db
											.prepare(
												"INSERT INTO projection_references (candidate_id, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?)",
											)
											.run(safeCandidateId, safeProjectIdentity, safeScope, safeRecId, safeBankRec, Date.now());
										try {
											this.#recordEvent(safeCandidateId, "projected", { mnemopiId: safeRecId, bank: safeBankRec });
										} catch {}
									} else if (cur2.mnemopiId !== safeRecId || cur2.bank !== safeBankRec) {
										throw new Error("projection conflict during sentinel recovery");
									}
									this.#db
										.prepare("UPDATE candidates SET status = 'approved', updated_at = ? WHERE id = ?")
										.run(Date.now(), safeCandidateId);
									this.#db
										.prepare(
											"DELETE FROM operation_intents WHERE candidate_id = ? AND operation = 'projection'",
										)
										.run(safeCandidateId);
								})();
								recovered++;
							} catch {}
						}
					}
					continue;
				}
				// Real-ID projection: crash after external rememberScopedIdempotent + intent update but before reference commit.
				// Must never retry rememberScoped; reconcile via exact stored bank. Sentinel handled above.
				if (curProj) {
					if (curProj.mnemopiId === r.mnemopi_id && curProj.bank === r.mnemopi_bank) {
						try {
							this.#db
								.prepare(
									"UPDATE candidates SET status = 'approved', updated_at = ? WHERE id = ? AND status = 'projection_pending'",
								)
								.run(Date.now(), candidateId);
						} catch {}
						clearIntent("projection");
						recovered++;
						continue;
					}
					if (!mnemopi) continue;
					const ok = this.#cleanMnemopiProjection(
						candidateId,
						{ mnemopiId: r.mnemopi_id, bank: r.mnemopi_bank },
						mnemopi,
						"projection_cleanup_retry",
					);
					if (ok) {
						clearIntent("projection", r.mnemopi_id, r.mnemopi_bank);
						recovered++;
					}
					continue;
				}
				if (!mnemopi) continue;
				let confirmed = false;
				if (hasExactBankReadCapability(mnemopi)) {
					try {
						const hit = (mnemopi as MnemopiExactBankReadCapability).getScopedMemoryInBank(
							r.mnemopi_id,
							r.mnemopi_bank,
						);
						if (hit && typeof hit === "object" && "bank" in (hit as Record<string, unknown>)) {
							const b = (hit as Record<string, unknown>).bank;
							if (typeof b === "string" && b.trim() === r.mnemopi_bank) confirmed = true;
						} else if (
							hit &&
							typeof (hit as { bank?: unknown }).bank === "string" &&
							(hit as { bank: string }).bank === r.mnemopi_bank
						) {
							confirmed = true;
						}
					} catch {}
				} else if (typeof (mnemopi as unknown as { getScopedMemory?: unknown }).getScopedMemory === "function") {
					try {
						const hit = (mnemopi as unknown as { getScopedMemory: (id: string) => unknown }).getScopedMemory(
							r.mnemopi_id,
						) as { bank?: string } | null | undefined;
						if (hit && typeof hit === "object" && "bank" in (hit as Record<string, unknown>)) {
							const b = (hit as Record<string, unknown>).bank;
							if (typeof b === "string" && b.trim() === r.mnemopi_bank) confirmed = true;
						}
					} catch {}
				}
				if (confirmed) {
					try {
						this.#db.transaction(() => {
							const cur2 = this.getProjection(candidateId);
							if (!cur2) {
								this.#db
									.prepare(
										"INSERT INTO projection_references (candidate_id, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?)",
									)
									.run(candidateId, r.project_identity, r.scope, r.mnemopi_id, r.mnemopi_bank, Date.now());
								try {
									this.#recordEvent(candidateId, "projected", {
										mnemopiId: r.mnemopi_id,
										bank: r.mnemopi_bank,
									});
								} catch {}
							} else if (cur2.mnemopiId !== r.mnemopi_id || cur2.bank !== r.mnemopi_bank) {
								throw new Error("projection conflict during reconciliation");
							}
							this.#db
								.prepare("UPDATE candidates SET status = 'approved', updated_at = ? WHERE id = ?")
								.run(Date.now(), candidateId);
							this.#db
								.prepare("DELETE FROM operation_intents WHERE candidate_id = ? AND operation = 'projection'")
								.run(candidateId);
						})();
						recovered++;
					} catch {}
					continue;
				}
				let absent = false;
				if (hasExactBankReadCapability(mnemopi)) {
					try {
						const hit2 = (mnemopi as MnemopiExactBankReadCapability).getScopedMemoryInBank(
							r.mnemopi_id,
							r.mnemopi_bank,
						);
						if (hit2 == null) absent = true;
					} catch {}
				} else if (typeof (mnemopi as unknown as { getScopedMemory?: unknown }).getScopedMemory === "function") {
					try {
						const hit2 = (mnemopi as unknown as { getScopedMemory: (id: string) => unknown }).getScopedMemory(
							r.mnemopi_id,
						);
						if (hit2 == null) absent = true;
						else if (typeof hit2 === "object" && hit2 !== null && "bank" in (hit2 as Record<string, unknown>)) {
							const bb = (hit2 as Record<string, unknown>).bank;
							if (typeof bb !== "string" || !(bb as string).trim()) absent = true;
							else if ((bb as string).trim() !== r.mnemopi_bank) {
								// Foreign bank hit via cross-bank getScopedMemory -> not proof of absence in stored bank, keep intent
								absent = false;
							}
						}
					} catch {}
				}
				if (absent) {
					clearIntent("projection", r.mnemopi_id, r.mnemopi_bank);
					try {
						this.#db
							.prepare(
								"UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ? AND status = 'projection_pending'",
							)
							.run(Date.now(), candidateId);
					} catch {}
					recovered++;
					continue;
				}
				const ok2 = this.#cleanMnemopiProjection(
					candidateId,
					{ mnemopiId: r.mnemopi_id, bank: r.mnemopi_bank },
					mnemopi,
					"projection_cleanup_retry",
				);
				if (ok2) {
					clearIntent("projection", r.mnemopi_id, r.mnemopi_bank);
					deleteMatchingProjRef(r.mnemopi_id, r.mnemopi_bank);
					try {
						this.#db
							.prepare(
								"UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ? AND status = 'projection_pending'",
							)
							.run(Date.now(), candidateId);
					} catch {}
					recovered++;
				}
				continue;
			}
			if (r.operation === "delete") {
				if (!mnemopi) {
					try {
						this.#db
							.prepare("UPDATE candidates SET status = 'projection_pending', updated_at = ? WHERE id = ?")
							.run(Date.now(), candidateId);
					} catch {}
					continue;
				}
				const ok = this.#cleanMnemopiProjection(candidateId, proj, mnemopi, "mnemopi_delete_uncertain_retry");
				if (!ok) continue;
				const cand = this.getCandidate(candidateId);
				if (!cand) {
					// Already deleted locally, just clear intent and matching reference
					clearIntent("delete", r.mnemopi_id, r.mnemopi_bank);
					deleteMatchingProjRef(r.mnemopi_id, r.mnemopi_bank);
					recovered++;
					continue;
				}
				try {
					this.#db.transaction(() => {
						this.#recordEvent(candidateId, "deleted", {
							projectIdentity: cand.projectIdentity,
							scope: cand.scope,
						});
						this.#db.prepare("DELETE FROM candidates WHERE id = ?").run(candidateId);
						this.#db
							.prepare(
								"INSERT OR REPLACE INTO tombstones (candidate_id, project_identity, scope, deleted_at) VALUES (?, ?, ?, ?)",
							)
							.run(candidateId, cand.projectIdentity, cand.scope, Date.now());
						// Preserve first valid reference: delete only matching row
						const cur = this.getProjection(candidateId);
						if (cur && cur.mnemopiId === r.mnemopi_id && cur.bank === r.mnemopi_bank) {
							this.#db
								.prepare(
									"DELETE FROM projection_references WHERE candidate_id = ? AND mnemopi_id = ? AND mnemopi_bank = ?",
								)
								.run(candidateId, r.mnemopi_id, r.mnemopi_bank);
						} else if (!cur) {
							this.#db.prepare("DELETE FROM projection_references WHERE candidate_id = ?").run(candidateId);
						}
						this.#db
							.prepare(
								"DELETE FROM operation_intents WHERE candidate_id = ? AND mnemopi_id = ? AND mnemopi_bank = ?",
							)
							.run(candidateId, r.mnemopi_id, r.mnemopi_bank);
					})();
					recovered++;
				} catch {}
			} else if (r.operation === "rollback") {
				if (!mnemopi) {
					try {
						this.#db
							.prepare("UPDATE candidates SET status = 'projection_pending', updated_at = ? WHERE id = ?")
							.run(Date.now(), candidateId);
					} catch {}
					continue;
				}
				const ok = this.#cleanMnemopiProjection(candidateId, proj, mnemopi, "mnemopi_rollback_uncertain_retry");
				if (!ok) continue;
				try {
					this.#db.transaction(() => {
						// Preserve first valid reference check: delete only matching
						const cur = this.getProjection(candidateId);
						if (cur && cur.mnemopiId === r.mnemopi_id && cur.bank === r.mnemopi_bank) {
							this.#db
								.prepare(
									"DELETE FROM projection_references WHERE candidate_id = ? AND mnemopi_id = ? AND mnemopi_bank = ?",
								)
								.run(candidateId, r.mnemopi_id, r.mnemopi_bank);
						} else if (!cur) {
							this.#db.prepare("DELETE FROM projection_references WHERE candidate_id = ?").run(candidateId);
						} else {
							// Different valid reference exists, preserve it, just clear intent
							this.#db
								.prepare(
									"DELETE FROM operation_intents WHERE candidate_id = ? AND mnemopi_id = ? AND mnemopi_bank = ?",
								)
								.run(candidateId, r.mnemopi_id, r.mnemopi_bank);
							return;
						}
						this.#db
							.prepare(
								"UPDATE candidates SET status = 'needs_review', version = version + 1, updated_at = ? WHERE id = ?",
							)
							.run(Date.now(), candidateId);
						this.#db
							.prepare(
								"DELETE FROM operation_intents WHERE candidate_id = ? AND mnemopi_id = ? AND mnemopi_bank = ?",
							)
							.run(candidateId, r.mnemopi_id, r.mnemopi_bank);
					})();
					try {
						this.#recordEvent(candidateId, "rolled_back", {});
					} catch {}
					recovered++;
				} catch {}
			} else if (r.operation === "projection_cleanup") {
				if (!mnemopi) {
					try {
						this.#db
							.prepare("UPDATE candidates SET status = 'needs_review', updated_at = ? WHERE id = ?")
							.run(Date.now(), candidateId);
					} catch {}
					continue;
				}
				if (!r.mnemopi_id || !r.mnemopi_bank) continue;
				const ok = this.#cleanMnemopiProjection(candidateId, proj, mnemopi, "projection_cleanup_retry");
				if (!ok) continue;
				clearIntent("projection_cleanup", r.mnemopi_id, r.mnemopi_bank);
				deleteMatchingProjRef(r.mnemopi_id, r.mnemopi_bank);
				recovered++;
			}
		}
		return recovered;
	}

	/** Create a managed skill

	/** Create a managed skill from approved reviewed content through hardened path.
	 *  Enforces safe name, bounded size, symlink checks, atomic write, audit event, and explicit rollback.
	 */
	async createSkillFromApprovedCandidate(
		candidateId: string,
		input: { name: string; description: string; body?: string },
		deps: {
			writeManagedSkill: (i: {
				name: string;
				description: string;
				body: string;
				action: "create" | "update";
			}) => Promise<{ path: string }>;
		},
	): Promise<{ ok: boolean; path?: string; error?: string }> {
		const cand = this.getCandidate(candidateId);
		if (cand?.status !== "approved" || !cand.reviewedContent) return { ok: false, error: "candidate not approved" };
		const reviewed = redactSensitiveText(cand.reviewedContent);
		const body = (input.body ?? reviewed).trim();
		if (!body || body.startsWith("Verified resolution for"))
			return { ok: false, error: "Meaningful reviewed procedure required" };
		if (body.length > 64_000) return { ok: false, error: "Skill body exceeds size limit" };
		// Hardened path is inside writeManagedSkill (safe name, size, symlink, atomic).
		try {
			const result = await deps.writeManagedSkill({
				name: input.name,
				description: input.description,
				body,
				action: "create",
			});
			this.#recordEvent(candidateId, "projected", { skillPath: result.path, skillName: input.name });
			// Regression: verify file exists and is not symlink before activation.
			const stat = await fs.promises.lstat(result.path).catch(() => null);
			if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
				return { ok: false, error: "Skill regression check failed" };
			}
			return { ok: true, path: result.path };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message.slice(0, 512) : String(e).slice(0, 512) };
		}
	}

	getCandidate(id: string): CandidateRecord | null {
		const row = this.#db
			.prepare(`
			SELECT
				id, episode_id as episodeId, session_id as sessionId, project_identity as projectIdentity,
				tool_name as toolName, tool_call_id as toolCallId, failure_digest as failureDigest,
				verifier_name as verifierName, verifier_digest as verifierDigest, status, scope,
				reviewed_content as reviewedContent, version, ttl_ms as ttlMs, created_at as createdAt,
				updated_at as updatedAt
			FROM candidates WHERE id = ?
		`)
			.get(id) as CandidateRecord | null;
		return row ?? null;
	}

	listCandidates(projectIdentity?: string): CandidateRecord[] {
		if (projectIdentity) {
			return this.#db
				.prepare(`
				SELECT
					id, episode_id as episodeId, session_id as sessionId, project_identity as projectIdentity,
					tool_name as toolName, tool_call_id as toolCallId, failure_digest as failureDigest,
					verifier_name as verifierName, verifier_digest as verifierDigest, status, scope,
					reviewed_content as reviewedContent, version, ttl_ms as ttlMs, created_at as createdAt,
					updated_at as updatedAt
				FROM candidates WHERE project_identity = ? OR scope = 'global'
				ORDER BY created_at DESC
			`)
				.all(projectIdentity) as CandidateRecord[];
		}
		return this.#db
			.prepare(`
			SELECT
				id, episode_id as episodeId, session_id as sessionId, project_identity as projectIdentity,
				tool_name as toolName, tool_call_id as toolCallId, failure_digest as failureDigest,
				verifier_name as verifierName, verifier_digest as verifierDigest, status, scope,
				reviewed_content as reviewedContent, version, ttl_ms as ttlMs, created_at as createdAt,
				updated_at as updatedAt
			FROM candidates
			ORDER BY created_at DESC
		`)
			.all() as CandidateRecord[];
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
