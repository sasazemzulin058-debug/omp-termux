import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CustomAutolearnService, canonicalProjectIdentity } from "../src/autolearn/custom-service";

describe("approval idempotent / projection orphan regression", () => {
	let dir: string;
	let svc: CustomAutolearnService;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-learn-idem-"));
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

	it("approve/project then duplicate approve with same content is idempotent, one projection, one memory write", async () => {
		const canon = canonicalProjectIdentity("/tmp/proj-idem");
		const cand = svc.observeCandidate({
			episodeId: "ep-idem",
			sessionId: "s1",
			projectIdentity: canon,
			toolName: "bash",
			toolCallId: "tc-idem",
			failureMessage: "fail idem",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-idem",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: canon,
			sessionId: "s1",
			episodeId: "ep-idem",
		});
		const content = "Real fix: handle android pidfd fallback for retry";
		const firstApprove = svc.approveCandidate(cand.id, content, canon);
		expect(firstApprove.success).toBe(true);

		let writes = 0;
		const fakeMnemopi = {
			rememberScopedIdempotent: (c: string, _o: { scope: string; source: string; idempotencyKey: string }) => {
				writes++;
				expect(c).toContain("android pidfd");
				return "mem_dup_1";
			},
			getScopedMemoryInBank: (_id: string, _bank: string) => ({
				bank: svc.getProjection(cand.id)?.bank ?? "unknown",
			}),
			getScopedRetainTarget: () => ({ bank: svc.getProjection(cand.id)?.bank ?? "unknown" }),
		} as unknown as {
			rememberScopedIdempotent: (
				c: string,
				o: { scope: string; source: string; idempotencyKey: string },
			) => string | undefined;
			getScopedMemoryInBank: (id: string, bank: string) => { bank: string } | null | undefined;
			getScopedRetainTarget: () => { bank: string } | null | undefined;
		};

		// First projection should create one write and one reference
		const firstProj = await svc.projectToMnemopiReal(cand.id, fakeMnemopi as any);
		expect(firstProj.ok).toBe(true);
		expect(firstProj.mnemopiId).toBe("mem_dup_1");
		expect(writes).toBe(1);
		const proj1 = svc.getProjection(cand.id);
		expect(proj1).not.toBeNull();
		expect(proj1?.mnemopiId).toBe("mem_dup_1");

		// Duplicate approve with same reviewed content must be idempotent (success/no-op), preserve reference
		const secondApprove = svc.approveCandidate(cand.id, content, canon);
		expect(secondApprove.success).toBe(true);
		const candAfter = svc.getCandidate(cand.id);
		expect(candAfter?.status).toBe("approved");
		expect(candAfter?.reviewedContent).toBeDefined();

		// Duplicate projection must not create second memory write and must return same id
		let secondWrites = 0;
		const fakeMnemopi2 = {
			rememberScopedIdempotent: () => {
				secondWrites++;
				return "mem_dup_2";
			},
			getScopedMemoryInBank: (id: string, bank: string) => {
				// Return bank for existing mem id, to confirm reconciliation
				if (id === "mem_dup_1") return { bank: proj1!.bank };
				return null;
			},
			getScopedRetainTarget: () => ({ bank: proj1!.bank }),
		} as any;

		const secondProj = await svc.projectToMnemopiReal(cand.id, fakeMnemopi2);
		expect(secondProj.ok).toBe(true);
		expect(secondProj.mnemopiId).toBe("mem_dup_1");
		expect(secondWrites).toBe(0);

		const proj2 = svc.getProjection(cand.id);
		expect(proj2?.mnemopiId).toBe("mem_dup_1");
		expect(proj2?.bank).toBe(proj1?.bank);

		// Direct stageForRetry with same content must remain idempotent and not demote to projection_pending
		const staged = svc.stageForRetry(cand.id, content, canon);
		expect(staged.success).toBe(true);
		expect(svc.getCandidate(cand.id)?.status).toBe("approved");
		expect(svc.getProjection(cand.id)?.mnemopiId).toBe("mem_dup_1");

		// projectToMnemopi direct with different id must be rejected (fail-closed, preserve old reference)
		const overwriteAttempt = svc.projectToMnemopi(cand.id, "mem_dup_2", proj1!.bank);
		expect(overwriteAttempt).toBe(false);
		expect(svc.getProjection(cand.id)?.mnemopiId).toBe("mem_dup_1");
	});

	it("duplicate approve with changed content is rejected and requires rollback", async () => {
		const canon = canonicalProjectIdentity("/tmp/proj-idem2");
		const cand = svc.observeCandidate({
			episodeId: "ep-idem2",
			sessionId: "s1",
			projectIdentity: canon,
			toolName: "bash",
			toolCallId: "tc-idem2",
			failureMessage: "fail2",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-idem2",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: canon,
			sessionId: "s1",
			episodeId: "ep-idem2",
		});
		const contentA = "Real fix: handle android pidfd fallback";
		svc.approveCandidate(cand.id, contentA, canon);
		const firstProj = await svc.projectToMnemopiReal(cand.id, {
			rememberScopedIdempotent: () => "mem_change_1",
		} as unknown as {
			rememberScopedIdempotent: (
				c: string,
				o: { scope: string; source: string; idempotencyKey: string },
			) => string | undefined;
		});
		expect(firstProj.ok).toBe(true);
		expect(svc.getProjection(cand.id)?.mnemopiId).toBe("mem_change_1");

		// Changed content must be rejected for approved+projected
		const changed = "Different fix: unrelated change";
		const res = svc.approveCandidate(cand.id, changed, canon);
		expect(res.success).toBe(false);
		expect(res.error).toContain("requires rollback");

		// stageForRetry with changed content also rejected
		const staged = svc.stageForRetry(cand.id, changed, canon);
		expect(staged.success).toBe(false);
		expect(staged.error).toContain("requires rollback");

		// Projection still preserved
		const proj = svc.getProjection(cand.id);
		expect(proj?.mnemopiId).toBe("mem_change_1");
		expect(svc.getCandidate(cand.id)?.status).toBe("approved");

		// After explicit rollback, re-approval with new content succeeds
		const bank = proj!.bank;
		const mockMnemopi = {
			getScopedMemoryInBank: (mid: string, b: string) => (mid && b === bank ? { bank } : null),
			editScopedMemoryInBank: () => ({ status: "deleted", bank }),
		} as any;
		const rolled = svc.rollbackCandidateWithMnemopi(cand.id, canon, mockMnemopi);
		expect(rolled).toBe(true);
		expect(svc.getProjection(cand.id)).toBeNull();
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");

		// Re-verify then approve with new content
		// Need to re-record verifier? Candidate still needs_review, can approve directly (status needs_review)
		// ApproveCandidate gates only needs_review/projection_pending, so needs_review OK
		const res2 = svc.approveCandidate(cand.id, changed, canon);
		expect(res2.success).toBe(true);
	});

	it("projection_pending with existing projection preserves reference on same-content stageForRetry", () => {
		const canon = canonicalProjectIdentity("/tmp/proj-pending");
		const cand = svc.observeCandidate({
			episodeId: "ep-pend",
			sessionId: "s1",
			projectIdentity: canon,
			toolName: "bash",
			toolCallId: "tc-pend",
			failureMessage: "fail pend",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-pend",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: canon,
			sessionId: "s1",
			episodeId: "ep-pend",
		});
		const content = "Real fix: pending retry handling";
		// Simulate Mnemopi unavailable path -> projection_pending
		const staged = svc.stageForRetry(cand.id, content, canon);
		expect(staged.success).toBe(true);
		expect(svc.getCandidate(cand.id)?.status).toBe("projection_pending");
		// Simulate that a projection reference somehow exists while still pending (legacy orphan case) -> insert directly
		// Use approve path to get to approved then stage? Simpler: manually project while pending
		svc.approveCandidate(cand.id, content, canon);
		// Now approved; stage again with same content while pending would be after rollback? Simulate pending+proj:
		// Re-stage to pending then project
		svc.stageForRetry(cand.id, content, canon);
		// Now candidate is projection_pending, manually insert projection to simulate legacy
		(svc as any).projectToMnemopi(cand.id, "mem_pending_1");
		const proj = svc.getProjection(cand.id);
		expect(proj).not.toBeNull();

		// Duplicate stageForRetry with same content must be idempotent
		const staged2 = svc.stageForRetry(cand.id, content, canon);
		expect(staged2.success).toBe(true);
		expect(svc.getProjection(cand.id)?.mnemopiId).toBe("mem_pending_1");

		// Changed content must be rejected
		const stagedChanged = svc.stageForRetry(cand.id, "Different content for pending", canon);
		expect(stagedChanged.success).toBe(false);
		expect(stagedChanged.error).toContain("requires rollback");
	});
});
