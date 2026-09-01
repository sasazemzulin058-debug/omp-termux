import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bankForScope, CustomAutolearnService, canonicalProjectIdentity } from "../src/autolearn/custom-service";

describe("custom autolearn extended termux", () => {
	let dir: string;
	let svc: CustomAutolearnService;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-learn-ext-"));
		svc = new CustomAutolearnService(dir);
	});
	afterEach(() => {
		try {
			svc.close();
		} catch {}
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	});

	it("canonical identity uses full path not basename alone", () => {
		const a = canonicalProjectIdentity("/tmp/repo-a");
		const b = canonicalProjectIdentity("/tmp/other/repo-a");
		expect(a).not.toBe(b);
		expect(a).toContain("/tmp/repo-a");
		expect(b).toContain("/tmp/other/repo-a");
	});

	it("projection stores exact bank derived from canonical identity", () => {
		const canon = canonicalProjectIdentity("/home/user/projects/my-repo");
		const cand = svc.observeCandidate({
			episodeId: "ep1",
			sessionId: "s1",
			projectIdentity: canon,
			toolName: "bash",
			toolCallId: "tc1",
			failureMessage: "fail",
		});
		svc.recordVerifierResult(cand.id, "cargo test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc1",
			expectedCommand: "cargo test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: canon,
			sessionId: "s1",
			episodeId: "ep1",
		});
		svc.approveCandidate(cand.id, "Real fix: handle android bionic fallback for pidfd", canon);
		const ok = svc.projectToMnemopi(cand.id, "mem_123");
		expect(ok).toBe(true);
		const proj = svc.getProjection(cand.id);
		expect(proj).not.toBeNull();
		expect(proj?.bank).toBeDefined();
		expect(proj?.bank.length).toBeGreaterThan(0);
		// Different repo with same basename must yield different bank
		const otherCanon = canonicalProjectIdentity("/other/path/my-repo");
		const cand2 = svc.observeCandidate({
			episodeId: "ep2",
			sessionId: "s1",
			projectIdentity: otherCanon,
			toolName: "bash",
			toolCallId: "tc2",
			failureMessage: "fail",
		});
		svc.recordVerifierResult(cand2.id, "cargo test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc2",
			expectedCommand: "cargo test",
			failureFingerprint: cand2.failureDigest,
			projectIdentity: otherCanon,
			sessionId: "s1",
			episodeId: "ep2",
		});
		svc.approveCandidate(cand2.id, "Another real fix", otherCanon);
		svc.projectToMnemopi(cand2.id, "mem_456");
		const proj2 = svc.getProjection(cand2.id);
		expect(proj2?.bank).not.toBe(proj?.bank);
	});

	it("real mnemopi projection is conservative on failure", async () => {
		const canon = canonicalProjectIdentity("/tmp/proj");
		const cand = svc.observeCandidate({
			episodeId: "ep3",
			sessionId: "s1",
			projectIdentity: canon,
			toolName: "bash",
			toolCallId: "tc3",
			failureMessage: "fail",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc3",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: canon,
			sessionId: "s1",
			episodeId: "ep3",
		});
		svc.approveCandidate(cand.id, "Meaningful content for projection", canon);
		const fakeFail = { rememberScopedIdempotent: () => undefined };
		const res = await svc.projectToMnemopiReal(cand.id, fakeFail as any);
		expect(res.ok).toBe(false);
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");
	});

	it("delete with exact bank and rollback respect tombstone", () => {
		const canon = canonicalProjectIdentity("/tmp/proj2");
		const cand = svc.observeCandidate({
			episodeId: "ep4",
			sessionId: "s1",
			projectIdentity: canon,
			toolName: "bash",
			toolCallId: "tc4",
			failureMessage: "fail",
		});
		svc.recordVerifierResult(cand.id, "cargo test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc4",
			expectedCommand: "cargo test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: canon,
			sessionId: "s1",
			episodeId: "ep4",
		});
		svc.approveCandidate(cand.id, "Fix handles edge case", canon);
		svc.projectToMnemopi(cand.id, "mem_789");
		const projBank = svc.getProjection(cand.id)?.bank ?? "default";
		// Mock mnemopi that records deletes with exact bank
		const deleted: string[] = [];
		const mockMnemopi = {
			getScopedMemoryInBank: (id: string, b: string) => (id && b === projBank ? { bank: projBank } : null),
			editScopedMemoryInBank: (op: string, id: string, _bank: string) => {
				deleted.push(`${op}:${id}`);
				return { status: "deleted", bank: _bank };
			},
		};
		const ok = svc.deleteCandidateWithMnemopi(cand.id, canon, mockMnemopi as any);
		expect(ok).toBe(true);
		expect(svc.getCandidate(cand.id)).toBeNull();
		expect(deleted.length).toBeGreaterThan(0);
		// Rollback should fail because tombstoned
		expect(svc.rollbackCandidateWithMnemopi(cand.id, canon, mockMnemopi as any)).toBe(false);
	});

	it("managed skill creation via hardened path rejects synthetic content", async () => {
		const canon = canonicalProjectIdentity("/tmp/proj3");
		const cand = svc.observeCandidate({
			episodeId: "ep5",
			sessionId: "s1",
			projectIdentity: canon,
			toolName: "bash",
			toolCallId: "tc5",
			failureMessage: "fail",
		});
		svc.recordVerifierResult(cand.id, "pytest", {
			verified: true,
			summary: "ok",
			toolCallId: "tc5",
			expectedCommand: "pytest",
			failureFingerprint: cand.failureDigest,
			projectIdentity: canon,
			sessionId: "s1",
			episodeId: "ep5",
		});
		// Try approve with synthetic should fail
		expect(svc.approveCandidate(cand.id, "Verified resolution for fail", canon).success).toBe(false);
		svc.approveCandidate(
			cand.id,
			"Concrete procedure: run cargo test with -- --nocapture and check android pidfd fallback",
			canon,
		);
		expect(svc.getCandidate(cand.id)?.status).toBe("projection_pending");
		// Crash-safe: project via real Mnemopi to reach approved before skill creation
		const proj = await svc.projectToMnemopiReal(cand.id, {
			rememberScopedIdempotent: (c: string) => "mem-skill-" + c.slice(0, 4),
			getScopedMemoryInBank: (id: string, _bank: string) => ({ bank: "default" }),
			getScopedRetainTarget: () => ({ bank: "default" }),
		} as any);
		expect(proj.ok).toBe(true);
		expect(svc.getCandidate(cand.id)?.status).toBe("approved");
		// Mock hardened writer that validates name
		const mockWriter = {
			writeManagedSkill: async (input: {
				name: string;
				description: string;
				body: string;
				action: "create" | "update";
			}) => {
				if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.name)) throw new Error("bad name");
				if (input.body.length > 64000) throw new Error("too large");
				const skillPath = path.join(dir, input.name, "SKILL.md");
				fs.mkdirSync(path.dirname(skillPath), { recursive: true });
				fs.writeFileSync(
					skillPath,
					`---\nname: ${input.name}\ndescription: ${input.description}\n---\n${input.body}\n`,
				);
				return { path: skillPath };
			},
		};
		const res = await svc.createSkillFromApprovedCandidate(
			cand.id,
			{ name: "android-pidfd-fix", description: "Fix pidfd on bionic" },
			mockWriter as any,
		);
		expect(res.ok).toBe(true);
	});

	it("learning_events remain append-only after candidate deletion", () => {
		const canon = canonicalProjectIdentity("/tmp/proj-append");
		const cand = svc.observeCandidate({
			episodeId: "ep-append",
			sessionId: "s-append",
			projectIdentity: canon,
			toolName: "bash",
			toolCallId: "tc-append",
			failureMessage: "fail append",
		});
		svc.recordVerifierResult(cand.id, "cargo test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-append",
			expectedCommand: "cargo test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: canon,
			sessionId: "s-append",
			episodeId: "ep-append",
		});
		svc.deleteCandidate(cand.id, canon);
		// After delete, candidate gone but events must survive
		expect(svc.getCandidate(cand.id)).toBeNull();
		// Query via new service instance on same dir to check learning_events still has observed+deleted
		const svc2 = new CustomAutolearnService(dir);
		// Use raw SQL via the service's DB handle accessed via private field hack: use Database directly
		const { Database } = require("bun:sqlite");
		const db2 = new Database(path.join(dir, "learn.db"));
		const rows = db2.prepare("SELECT event_type FROM learning_events WHERE candidate_id = ?").all(cand.id) as {
			event_type: string;
		}[];
		db2.close();
		const types = rows.map(r => r.event_type);
		expect(types).toContain("observed");
		expect(types).toContain("deleted");
		svc2.close();
	});

	it("deleteCandidateWithMnemopi keeps projection on uncertain backend failure", () => {
		const canon = canonicalProjectIdentity("/tmp/proj-conservative");
		const cand = svc.observeCandidate({
			episodeId: "ep-cons",
			sessionId: "s-cons",
			projectIdentity: canon,
			toolName: "bash",
			toolCallId: "tc-cons",
			failureMessage: "fail cons",
		});
		svc.recordVerifierResult(cand.id, "cargo test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-cons",
			expectedCommand: "cargo test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: canon,
			sessionId: "s-cons",
			episodeId: "ep-cons",
		});
		svc.approveCandidate(cand.id, "Conservative fix content", canon);
		svc.projectToMnemopi(cand.id, "mem_cons");
		const failingMnemopi = {
			editScopedMemoryInBank: () => {
				throw new Error("backend down");
			},
		};
		const ok = svc.deleteCandidateWithMnemopi(
			cand.id,
			canon,
			failingMnemopi as unknown as { editScopedMemoryInBank: (op: string, id: string, _bank: string) => unknown },
		);
		expect(ok).toBe(false);
		// Candidate must still exist and be needs_review, projection must remain
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");
		expect(svc.getProjection(cand.id)).not.toBeNull();
	});

	it("migration backfills legacy projection banks scope-aware and preserves explicit banks, enabling cleanup", () => {
		const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-legacy-mig-"));
		const dbPath = path.join(legacyDir, "learn.db");
		const db = new Database(dbPath);
		// Legacy schema: projection_references without mnemopi_bank
		db.exec(`
			CREATE TABLE episodes (id TEXT PRIMARY KEY, project_identity TEXT NOT NULL, session_id TEXT NOT NULL, created_at INTEGER NOT NULL);
			CREATE TABLE candidates (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, session_id TEXT NOT NULL, project_identity TEXT NOT NULL, tool_name TEXT NOT NULL, tool_call_id TEXT NOT NULL, failure_digest TEXT NOT NULL, verifier_name TEXT, verifier_digest TEXT, status TEXT NOT NULL, scope TEXT NOT NULL, reviewed_content TEXT, version INTEGER NOT NULL DEFAULT 1, ttl_ms INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_identity, tool_call_id, failure_digest));
			CREATE TABLE verifier_results (id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, verifier_name TEXT NOT NULL, tool_call_id TEXT NOT NULL, failure_fingerprint TEXT NOT NULL, project_identity TEXT NOT NULL, session_id TEXT NOT NULL, episode_id TEXT NOT NULL, summary_digest TEXT NOT NULL, verified INTEGER NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE);
			CREATE TABLE learning_events (id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, timestamp INTEGER NOT NULL);
			CREATE TABLE tombstones (candidate_id TEXT PRIMARY KEY, project_identity TEXT NOT NULL, scope TEXT NOT NULL, deleted_at INTEGER NOT NULL);
			CREATE TABLE projection_references (candidate_id TEXT PRIMARY KEY, project_identity TEXT NOT NULL, scope TEXT NOT NULL, mnemopi_id TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE);
		`);
		const globalProj = "/tmp/legacy-global";
		const projectProj = canonicalProjectIdentity("/tmp/legacy-project");
		const localProj = canonicalProjectIdentity("/tmp/legacy-local");
		const now = Date.now();
		const rows = [
			{ id: "cand_global", proj: globalProj, scope: "global", tc: "tc_g", fd: "fd_g", mem: "mem_global" },
			{ id: "cand_proj", proj: projectProj, scope: "project", tc: "tc_p", fd: "fd_p", mem: "mem_proj" },
			{ id: "cand_local", proj: localProj, scope: "local", tc: "tc_l", fd: "fd_l", mem: "mem_local" },
		];
		for (const r of rows) {
			db.prepare(
				"INSERT INTO candidates (id, episode_id, session_id, project_identity, tool_name, tool_call_id, failure_digest, status, scope, version, ttl_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				r.id,
				`ep_${r.id}`,
				"sess1",
				r.proj,
				"bash",
				r.tc,
				r.fd,
				"approved",
				r.scope,
				1,
				7 * 24 * 60 * 60 * 1000,
				now,
				now,
			);
			db.prepare("INSERT INTO episodes (id, project_identity, session_id, created_at) VALUES (?, ?, ?, ?)").run(
				`ep_${r.id}`,
				r.proj,
				"sess1",
				now,
			);
			db.prepare(
				"INSERT INTO projection_references (candidate_id, project_identity, scope, mnemopi_id, created_at) VALUES (?, ?, ?, ?, ?)",
			).run(r.id, r.proj, r.scope, r.mem, now);
		}
		// Provide reviewed_content so delete/rollback gates pass
		for (const r of rows) {
			db.prepare("UPDATE candidates SET reviewed_content = ? WHERE id = ?").run(
				"reviewed: real fix for " + r.scope,
				r.id,
			);
		}
		db.close();
		const svcLegacy = new CustomAutolearnService(legacyDir);
		const g = svcLegacy.getProjection("cand_global");
		const p = svcLegacy.getProjection("cand_proj");
		const l = svcLegacy.getProjection("cand_local");
		expect(g).not.toBeNull();
		expect(g?.bank).toBe("default");
		expect(p).not.toBeNull();
		expect(p?.bank).toBe(bankForScope("project", projectProj));
		expect(l).not.toBeNull();
		expect(l?.bank).toBe(bankForScope("local", localProj));
		// Cleanup eligibility: strict bank mismatch would leave stuck needs_review; after backfill delete with exact bank must succeed
		for (const r of rows) {
			const proj = svcLegacy.getProjection(r.id)!;
			const mock = {
				getScopedMemoryInBank: (mid: string, b: string) =>
					mid === r.mem && b === proj.bank ? { bank: proj.bank } : null,
				editScopedMemoryInBank: (_op: string, id: string, _bank: string) => {
					expect(id).toBe(r.mem);
					return { status: "deleted", bank: _bank };
				},
			};
			const ok = svcLegacy.deleteCandidateWithMnemopi(
				r.id,
				r.proj,
				mock as unknown as {
					getScopedMemoryInBank: (id: string, bank: string) => unknown;
					editScopedMemoryInBank: (op: string, id: string, bank: string) => unknown;
				},
			);
			expect(ok).toBe(true);
			expect(svcLegacy.getCandidate(r.id)).toBeNull();
			expect(svcLegacy.getProjection(r.id)).toBeNull();
		}
		svcLegacy.close();
		// Preserve already-valid nonempty banks: create DB with explicit bank for one project row
		const preserveDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-preserve-mig-"));
		const db2Path = path.join(preserveDir, "learn.db");
		const db2 = new Database(db2Path);
		db2.exec(`
			CREATE TABLE episodes (id TEXT PRIMARY KEY, project_identity TEXT NOT NULL, session_id TEXT NOT NULL, created_at INTEGER NOT NULL);
			CREATE TABLE candidates (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, session_id TEXT NOT NULL, project_identity TEXT NOT NULL, tool_name TEXT NOT NULL, tool_call_id TEXT NOT NULL, failure_digest TEXT NOT NULL, verifier_name TEXT, verifier_digest TEXT, status TEXT NOT NULL, scope TEXT NOT NULL, reviewed_content TEXT, version INTEGER NOT NULL DEFAULT 1, ttl_ms INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_identity, tool_call_id, failure_digest));
			CREATE TABLE verifier_results (id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, verifier_name TEXT NOT NULL, tool_call_id TEXT NOT NULL, failure_fingerprint TEXT NOT NULL, project_identity TEXT NOT NULL, session_id TEXT NOT NULL, episode_id TEXT NOT NULL, summary_digest TEXT NOT NULL, verified INTEGER NOT NULL, created_at INTEGER NOT NULL);
			CREATE TABLE learning_events (id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, timestamp INTEGER NOT NULL);
			CREATE TABLE tombstones (candidate_id TEXT PRIMARY KEY, project_identity TEXT NOT NULL, scope TEXT NOT NULL, deleted_at INTEGER NOT NULL);
			CREATE TABLE projection_references (candidate_id TEXT PRIMARY KEY, project_identity TEXT NOT NULL, scope TEXT NOT NULL, mnemopi_id TEXT NOT NULL, mnemopi_bank TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(candidate_id) REFERENCES candidates(id) ON DELETE CASCADE);
			CREATE TABLE operation_intents (candidate_id TEXT PRIMARY KEY, operation TEXT NOT NULL, project_identity TEXT NOT NULL, scope TEXT NOT NULL, mnemopi_id TEXT NOT NULL, mnemopi_bank TEXT NOT NULL, created_at INTEGER NOT NULL);
		`);
		const explicitProj = canonicalProjectIdentity("/tmp/legacy-explicit");
		const explicitBank = bankForScope("project", explicitProj);
		const defaultProj = canonicalProjectIdentity("/tmp/legacy-default-preserve");
		const now2 = Date.now();
		db2.prepare(
			"INSERT INTO candidates (id, episode_id, session_id, project_identity, tool_name, tool_call_id, failure_digest, status, scope, version, ttl_ms, created_at, updated_at, reviewed_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"cand_explicit",
			"ep1",
			"sess1",
			explicitProj,
			"bash",
			"tc_e",
			"fd_e",
			"approved",
			"project",
			1,
			7 * 24 * 60 * 60 * 1000,
			now2,
			now2,
			"reviewed explicit",
		);
		db2.prepare("INSERT INTO episodes (id, project_identity, session_id, created_at) VALUES (?, ?, ?, ?)").run(
			"ep1",
			explicitProj,
			"sess1",
			now2,
		);
		db2.prepare(
			"INSERT INTO projection_references (candidate_id, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run("cand_explicit", explicitProj, "project", "mem_explicit", explicitBank, now2);
		db2.prepare(
			"INSERT INTO candidates (id, episode_id, session_id, project_identity, tool_name, tool_call_id, failure_digest, status, scope, version, ttl_ms, created_at, updated_at, reviewed_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			"cand_default",
			"ep2",
			"sess1",
			defaultProj,
			"bash",
			"tc_d",
			"fd_d",
			"approved",
			"project",
			1,
			7 * 24 * 60 * 60 * 1000,
			now2,
			now2,
			"reviewed default",
		);
		db2.prepare("INSERT INTO episodes (id, project_identity, session_id, created_at) VALUES (?, ?, ?, ?)").run(
			"ep2",
			defaultProj,
			"sess1",
			now2,
		);
		db2.prepare(
			"INSERT INTO projection_references (candidate_id, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run("cand_default", defaultProj, "project", "mem_default", "default", now2);
		db2.close();
		const svc2 = new CustomAutolearnService(preserveDir);
		const explicitProjAfter = svc2.getProjection("cand_explicit");
		expect(explicitProjAfter).not.toBeNull();
		expect(explicitProjAfter?.bank).toBe(explicitBank);
		const defaultProjAfter = svc2.getProjection("cand_default");
		expect(defaultProjAfter).not.toBeNull();
		expect(defaultProjAfter?.bank).toBe(bankForScope("project", defaultProj));
		// Cleanup eligibility for backfilled row after preserve test
		const mock2 = {
			getScopedMemoryInBank: (mid: string, b: string) => (b === defaultProjAfter!.bank ? { bank: b } : null),
			editScopedMemoryInBank: (_op: string, _id: string, _bank: string) => ({ status: "deleted", bank: _bank }),
		};
		expect(
			svc2.deleteCandidateWithMnemopi(
				"cand_default",
				defaultProj,
				mock2 as unknown as { editScopedMemoryInBank: (op: string, id: string, _bank: string) => unknown },
			),
		).toBe(true);
		svc2.close();
		try {
			fs.rmSync(legacyDir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(preserveDir, { recursive: true, force: true });
		} catch {}
	});
});
