import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CustomAutolearnService, canonicalProjectIdentity } from "../src/autolearn/custom-service";

describe("custom autolearn extended termux", () => {
	let dir: string;
	let svc: CustomAutolearnService;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-learn-ext-"));
		svc = new CustomAutolearnService(dir);
	});
	afterEach(() => {
		try { svc.close(); } catch {}
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
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
		const cand = svc.observeCandidate({ episodeId: "ep1", sessionId: "s1", projectIdentity: canon, toolName: "bash", toolCallId: "tc1", failureMessage: "fail" });
		svc.recordVerifierResult(cand.id, "cargo test", { verified: true, summary: "ok", toolCallId: "tc1", expectedCommand: "cargo test", failureFingerprint: cand.failureDigest, projectIdentity: canon, sessionId: "s1", episodeId: "ep1" });
		svc.approveCandidate(cand.id, "Real fix: handle android bionic fallback for pidfd", canon);
		const ok = svc.projectToMnemopi(cand.id, "mem_123");
		expect(ok).toBe(true);
		const proj = svc.getProjection(cand.id);
		expect(proj).not.toBeNull();
		expect(proj?.bank).toBeDefined();
		expect(proj?.bank.length).toBeGreaterThan(0);
		// Different repo with same basename must yield different bank
		const otherCanon = canonicalProjectIdentity("/other/path/my-repo");
		const cand2 = svc.observeCandidate({ episodeId: "ep2", sessionId: "s1", projectIdentity: otherCanon, toolName: "bash", toolCallId: "tc2", failureMessage: "fail" });
		svc.recordVerifierResult(cand2.id, "cargo test", { verified: true, summary: "ok", toolCallId: "tc2", expectedCommand: "cargo test", failureFingerprint: cand2.failureDigest, projectIdentity: otherCanon, sessionId: "s1", episodeId: "ep2" });
		svc.approveCandidate(cand2.id, "Another real fix", otherCanon);
		svc.projectToMnemopi(cand2.id, "mem_456");
		const proj2 = svc.getProjection(cand2.id);
		expect(proj2?.bank).not.toBe(proj?.bank);
	});

	it("real mnemopi projection is conservative on failure", async () => {
		const canon = canonicalProjectIdentity("/tmp/proj");
		const cand = svc.observeCandidate({ episodeId: "ep3", sessionId: "s1", projectIdentity: canon, toolName: "bash", toolCallId: "tc3", failureMessage: "fail" });
		svc.recordVerifierResult(cand.id, "bun test", { verified: true, summary: "ok", toolCallId: "tc3", expectedCommand: "bun test", failureFingerprint: cand.failureDigest, projectIdentity: canon, sessionId: "s1", episodeId: "ep3" });
		svc.approveCandidate(cand.id, "Meaningful content for projection", canon);
		const fakeFail = { rememberScoped: () => undefined };
		const res = await svc.projectToMnemopiReal(cand.id, fakeFail as any);
		expect(res.ok).toBe(false);
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");
	});

	it("delete with exact bank and rollback respect tombstone", () => {
		const canon = canonicalProjectIdentity("/tmp/proj2");
		const cand = svc.observeCandidate({ episodeId: "ep4", sessionId: "s1", projectIdentity: canon, toolName: "bash", toolCallId: "tc4", failureMessage: "fail" });
		svc.recordVerifierResult(cand.id, "cargo test", { verified: true, summary: "ok", toolCallId: "tc4", expectedCommand: "cargo test", failureFingerprint: cand.failureDigest, projectIdentity: canon, sessionId: "s1", episodeId: "ep4" });
		svc.approveCandidate(cand.id, "Fix handles edge case", canon);
		svc.projectToMnemopi(cand.id, "mem_789");
		// Mock mnemopi that records deletes
		const deleted: string[] = [];
		const mockMnemopi = { editScopedMemory: (op: string, id: string) => { deleted.push(`${op}:${id}`); return { status: "deleted" }; } };
		const ok = svc.deleteCandidateWithMnemopi(cand.id, canon, mockMnemopi as any);
		expect(ok).toBe(true);
		expect(svc.getCandidate(cand.id)).toBeNull();
		expect(deleted.length).toBeGreaterThan(0);
		// Rollback should fail because tombstoned
		expect(svc.rollbackCandidateWithMnemopi(cand.id, canon, mockMnemopi as any)).toBe(false);
	});

	it("managed skill creation via hardened path rejects synthetic content", async () => {
		const canon = canonicalProjectIdentity("/tmp/proj3");
		const cand = svc.observeCandidate({ episodeId: "ep5", sessionId: "s1", projectIdentity: canon, toolName: "bash", toolCallId: "tc5", failureMessage: "fail" });
		svc.recordVerifierResult(cand.id, "pytest", { verified: true, summary: "ok", toolCallId: "tc5", expectedCommand: "pytest", failureFingerprint: cand.failureDigest, projectIdentity: canon, sessionId: "s1", episodeId: "ep5" });
		// Try approve with synthetic should fail
		expect(svc.approveCandidate(cand.id, "Verified resolution for fail", canon).success).toBe(false);
		svc.approveCandidate(cand.id, "Concrete procedure: run cargo test with -- --nocapture and check android pidfd fallback", canon);
		// Mock hardened writer that validates name
		const mockWriter = {
			writeManagedSkill: async (input: { name: string; description: string; body: string; action: "create" | "update" }) => {
				if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.name)) throw new Error("bad name");
				if (input.body.length > 64000) throw new Error("too large");
				const skillPath = path.join(dir, input.name, "SKILL.md");
				fs.mkdirSync(path.dirname(skillPath), { recursive: true });
				fs.writeFileSync(skillPath, `---\nname: ${input.name}\ndescription: ${input.description}\n---\n${input.body}\n`);
				return { path: skillPath };
			},
		};
		const res = await svc.createSkillFromApprovedCandidate(cand.id, { name: "android-pidfd-fix", description: "Fix pidfd on bionic" }, mockWriter as any);
		expect(res.ok).toBe(true);
	});

	it("learning_events remain append-only after candidate deletion", () => {
		const canon = canonicalProjectIdentity("/tmp/proj-append");
		const cand = svc.observeCandidate({ episodeId: "ep-append", sessionId: "s-append", projectIdentity: canon, toolName: "bash", toolCallId: "tc-append", failureMessage: "fail append" });
		svc.recordVerifierResult(cand.id, "cargo test", { verified: true, summary: "ok", toolCallId: "tc-append", expectedCommand: "cargo test", failureFingerprint: cand.failureDigest, projectIdentity: canon, sessionId: "s-append", episodeId: "ep-append" });
		// Directly query learning_events before delete
		const db = (svc as unknown as { _db?: unknown }) as unknown;
		// Use service's internal DB via private field access through prepare
		const beforeRows = (svc as unknown as { [k: string]: unknown });
		svc.deleteCandidate(cand.id, canon);
		// After delete, candidate gone but events must survive
		expect(svc.getCandidate(cand.id)).toBeNull();
		// Query via new service instance on same dir to check learning_events still has observed+deleted
		const svc2 = new CustomAutolearnService(dir);
		const events = (svc2 as unknown as { _db?: unknown });
		// Use raw SQL via the service's DB handle accessed via private field hack: use Database directly
		const { Database } = require("bun:sqlite");
		const db2 = new Database(path.join(dir, "learn.db"));
		const rows = db2.prepare("SELECT event_type FROM learning_events WHERE candidate_id = ?").all(cand.id) as { event_type: string }[];
		db2.close();
		const types = rows.map(r => r.event_type);
		expect(types).toContain("observed");
		expect(types).toContain("deleted");
		svc2.close();
	});

	it("deleteCandidateWithMnemopi keeps projection on uncertain backend failure", () => {
		const canon = canonicalProjectIdentity("/tmp/proj-conservative");
		const cand = svc.observeCandidate({ episodeId: "ep-cons", sessionId: "s-cons", projectIdentity: canon, toolName: "bash", toolCallId: "tc-cons", failureMessage: "fail cons" });
		svc.recordVerifierResult(cand.id, "cargo test", { verified: true, summary: "ok", toolCallId: "tc-cons", expectedCommand: "cargo test", failureFingerprint: cand.failureDigest, projectIdentity: canon, sessionId: "s-cons", episodeId: "ep-cons" });
		svc.approveCandidate(cand.id, "Conservative fix content", canon);
		svc.projectToMnemopi(cand.id, "mem_cons");
		const failingMnemopi = { editScopedMemory: () => { throw new Error("backend down"); } };
		const ok = svc.deleteCandidateWithMnemopi(cand.id, canon, failingMnemopi as unknown as { editScopedMemory: (op: string, id: string) => unknown });
		expect(ok).toBe(false);
		// Candidate must still exist and be needs_review, projection must remain
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");
		expect(svc.getProjection(cand.id)).not.toBeNull();
	});
});
