import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	bankForScope,
	CustomAutolearnService,
	canonicalProjectIdentity,
	computeIdempotencyKey,
	redactSensitiveText,
} from "../src/autolearn/custom-service";

describe("final projection recovery — P1 fixes", () => {
	it("sentinel crash recovers via deterministic idempotent write and persists reference without non-idempotent fallback", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sentinel-retry-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sentinel-cwd-"));
		const proj = canonicalProjectIdentity(cwd);
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({
			episodeId: "ep-sentinel",
			sessionId: "sess-sentinel",
			projectIdentity: proj,
			toolName: "bash",
			toolCallId: "tc-sentinel",
			failureMessage: "fail sentinel",
			scope: "project",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-sentinel",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-sentinel",
			episodeId: "ep-sentinel",
		});
		svc.approveCandidate(cand.id, "reviewed sentinel", proj);
		const targetBank = bankForScope("project", proj);
		{
			const db = new Database(path.join(dir, "learn.db"));
			db.prepare("UPDATE candidates SET status = 'projection_pending' WHERE id = ?").run(cand.id);
			db.prepare(
				"INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(cand.id, "projection", proj, "project", "__pending_projection__", targetBank, Date.now());
			db.close();
		}
		expect(svc.getOperationIntent(cand.id)?.mnemopiId).toBe("__pending_projection__");
		expect(svc.getCandidate(cand.id)?.status).toBe("projection_pending");
		const expectedRedacted = redactSensitiveText("reviewed sentinel");
		const expectedKey = computeIdempotencyKey(cand.id, expectedRedacted, "project", proj);
		let rememberCalls = 0;
		let observedKey: string | undefined;
		let nonIdempotentCalls = 0;
		const mnemopiSentinel: unknown = {
			rememberScopedIdempotent: (
				_content: string,
				opts: { scope: string; source: string; idempotencyKey: string },
			) => {
				rememberCalls++;
				observedKey = opts.idempotencyKey;
				expect(opts.source).toBe("custom-autolearn");
				expect(opts.scope).toBe("bank");
				return "mem-recovered-sentinel-1";
			},
			rememberScoped: () => {
				nonIdempotentCalls++;
				return "mem-should-not-be-used";
			},
			getScopedMemoryInBank: (id: string, bank: string) =>
				id === "mem-recovered-sentinel-1" && bank === targetBank ? { bank: targetBank } : null,
			getScopedRetainTarget: () => ({ bank: targetBank }),
		};
		const res = await svc.projectToMnemopiReal(cand.id, mnemopiSentinel as never);
		expect(rememberCalls).toBe(1);
		expect(observedKey).toBe(expectedKey);
		expect(nonIdempotentCalls).toBe(0);
		expect(res.ok).toBe(true);
		expect(res.mnemopiId).toBe("mem-recovered-sentinel-1");
		expect(svc.getProjection(cand.id)?.mnemopiId).toBe("mem-recovered-sentinel-1");
		expect(svc.getProjection(cand.id)?.bank).toBe(targetBank);
		expect(svc.getCandidate(cand.id)?.status).toBe("approved");
		expect(svc.getOperationIntent(cand.id)).toBeNull();
		// Second call is idempotent via existing projection — no second external write
		let rememberCalls2 = 0;
		const mnemopiSecond: unknown = {
			rememberScopedIdempotent: () => {
				rememberCalls2++;
				return "mem-second-orphan-should-not-be-used";
			},
			rememberScoped: () => {
				nonIdempotentCalls++;
				return "mem-non-idem-2";
			},
			getScopedMemoryInBank: (id: string, bank: string) =>
				id === "mem-recovered-sentinel-1" && bank === targetBank ? { bank: targetBank } : null,
			getScopedRetainTarget: () => ({ bank: targetBank }),
		};
		const res2 = await svc.projectToMnemopiReal(cand.id, mnemopiSecond as never);
		expect(rememberCalls2).toBe(0);
		expect(nonIdempotentCalls).toBe(0);
		expect(res2.ok).toBe(true);
		expect(res2.mnemopiId).toBe("mem-recovered-sentinel-1");
		// Capability-missing sentinel preserves intent without non-idempotent mutation
		const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sentinel-no-cap-"));
		const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sentinel-no-cap-cwd-"));
		const proj2 = canonicalProjectIdentity(cwd2);
		const svc2 = new CustomAutolearnService(dir2);
		const cand2 = svc2.observeCandidate({
			episodeId: "ep-sentinel2",
			sessionId: "sess-sentinel2",
			projectIdentity: proj2,
			toolName: "bash",
			toolCallId: "tc-sentinel2",
			failureMessage: "fail sentinel2",
			scope: "project",
		});
		svc2.recordVerifierResult(cand2.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-sentinel2",
			expectedCommand: "bun test",
			failureFingerprint: cand2.failureDigest,
			projectIdentity: proj2,
			sessionId: "sess-sentinel2",
			episodeId: "ep-sentinel2",
		});
		svc2.approveCandidate(cand2.id, "reviewed sentinel2", proj2);
		const targetBank2 = bankForScope("project", proj2);
		{
			const db = new Database(path.join(dir2, "learn.db"));
			db.prepare("UPDATE candidates SET status = 'projection_pending' WHERE id = ?").run(cand2.id);
			db.prepare(
				"INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(cand2.id, "projection", proj2, "project", "__pending_projection__", targetBank2, Date.now());
			db.close();
		}
		let nonIdemCalls3 = 0;
		const mnemopiNoCap: unknown = {
			rememberScoped: () => {
				nonIdemCalls3++;
				return "mem-non-idem";
			},
			getScopedMemoryInBank: () => null,
			getScopedRetainTarget: () => ({ bank: targetBank2 }),
		};
		const res3 = await svc2.projectToMnemopiReal(cand2.id, mnemopiNoCap as never);
		expect(nonIdemCalls3).toBe(0);
		expect(res3.ok).toBe(false);
		expect(res3.error).toContain("sentinel recovery requires idempotent");
		expect(svc2.getOperationIntent(cand2.id)?.mnemopiId).toBe("__pending_projection__");
		expect(svc2.getProjection(cand2.id)).toBeNull();
		// recoverOperationIntents also recovers sentinel via idempotent write
		const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sentinel-rec-"));
		const cwd3 = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sentinel-rec-cwd-"));
		const proj3 = canonicalProjectIdentity(cwd3);
		const svc3 = new CustomAutolearnService(dir3);
		const cand3 = svc3.observeCandidate({
			episodeId: "ep-sentinel3",
			sessionId: "sess-sentinel3",
			projectIdentity: proj3,
			toolName: "bash",
			toolCallId: "tc-sentinel3",
			failureMessage: "fail sentinel3",
			scope: "project",
		});
		svc3.recordVerifierResult(cand3.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-sentinel3",
			expectedCommand: "bun test",
			failureFingerprint: cand3.failureDigest,
			projectIdentity: proj3,
			sessionId: "sess-sentinel3",
			episodeId: "ep-sentinel3",
		});
		svc3.approveCandidate(cand3.id, "reviewed sentinel3", proj3);
		const targetBank3 = bankForScope("project", proj3);
		{
			const db = new Database(path.join(dir3, "learn.db"));
			db.prepare("UPDATE candidates SET status = 'projection_pending' WHERE id = ?").run(cand3.id);
			db.prepare(
				"INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(cand3.id, "projection", proj3, "project", "__pending_projection__", targetBank3, Date.now());
			db.close();
		}
		let recoverCalls = 0;
		const mnemopiRec: unknown = {
			rememberScopedIdempotent: () => {
				recoverCalls++;
				return "mem-recovered-via-recover-1";
			},
			getScopedMemoryInBank: (id: string, bank: string) =>
				id === "mem-recovered-via-recover-1" && bank === targetBank3 ? { bank: targetBank3 } : null,
			getScopedRetainTarget: () => ({ bank: targetBank3 }),
			getScopedRecallTargets: () => [{ bank: targetBank3 }],
			editScopedMemoryInBank: () => ({ status: "deleted", bank: targetBank3 }),
		};
		const recovered = svc3.recoverOperationIntents(mnemopiRec as never);
		expect(recoverCalls).toBe(1);
		expect(recovered).toBe(1);
		expect(svc3.getProjection(cand3.id)?.mnemopiId).toBe("mem-recovered-via-recover-1");
		expect(svc3.getOperationIntent(cand3.id)).toBeNull();
		expect(svc3.getCandidate(cand3.id)?.status).toBe("approved");
		svc.close();
		svc2.close();
		svc3.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(dir2, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd2, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(dir3, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd3, { recursive: true, force: true });
		} catch {}
	});

	it("unexpected bank preserves actual intent/reference and marks needs_review for reconciliation", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-unexpected-bank-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-unexpected-bank-cwd-"));
		const proj = canonicalProjectIdentity(cwd);
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({
			episodeId: "ep-ub",
			sessionId: "sess-ub",
			projectIdentity: proj,
			toolName: "bash",
			toolCallId: "tc-ub",
			failureMessage: "fail ub",
			scope: "project",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-ub",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-ub",
			episodeId: "ep-ub",
		});
		svc.approveCandidate(cand.id, "reviewed ub", proj);
		const targetBank = bankForScope("project", proj);
		const actualBank = targetBank + "_actual";
		expect(targetBank).not.toBe(actualBank);
		const mnemopiMismatch: unknown = {
			rememberScopedIdempotent: () => "mem-ub-1",
			getScopedRetainTarget: () => ({ bank: targetBank }),
			getScopedMemoryInBank: (id: string, _bank: string) => (id === "mem-ub-1" ? { bank: actualBank } : null),
		};
		const res = await svc.projectToMnemopiReal(cand.id, mnemopiMismatch as never);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("actual write bank");
		expect(svc.getProjection(cand.id)?.mnemopiId).toBe("mem-ub-1");
		expect(svc.getProjection(cand.id)?.bank).toBe(actualBank);
		expect(svc.getOperationIntent(cand.id)?.mnemopiBank).toBe(actualBank);
		expect(svc.getOperationIntent(cand.id)?.mnemopiId).toBe("mem-ub-1");
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");

		// Recovery with exact actual bank should be able to reconcile (confirm via getScopedMemory)
		const mnemopiRecovery: unknown = {
			getScopedMemoryInBank: (id: string, _bank: string) => (id === "mem-ub-1" ? { bank: actualBank } : null),
			getScopedRetainTarget: () => ({ bank: actualBank }),
			getScopedRecallTargets: () => [{ bank: actualBank }],
			editScopedMemoryInBank: () => ({ status: "deleted", bank: actualBank }),
		};
		// Since projection already exists with actual bank, recovery should not need to do anything but could clear stale intent after manual review
		// Simulate that candidate is still needs_review with projection existing; recover should leave it for manual but not orphan
		const recovered = svc.recoverOperationIntents(mnemopiRecovery as never);
		// After our mismatch fix, projection reference is actual bank, so no further recovery needed; intent may be cleared by next successful approve or manual rollback
		// Just ensure we didn't lose actual bank reference
		expect(svc.getProjection(cand.id)?.bank).toBe(actualBank);

		svc.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {}
	});

	it("same-ID cross-bank getScopedMemory does not clear intent as absent", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cross-bank-"));
		const proj = canonicalProjectIdentity(fs.mkdtempSync(path.join(os.tmpdir(), "omp-cross-bank-proj-")));
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({
			episodeId: "ep-cb",
			sessionId: "sess-cb",
			projectIdentity: proj,
			toolName: "bash",
			toolCallId: "tc-cb",
			failureMessage: "fail cb",
			scope: "project",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-cb",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-cb",
			episodeId: "ep-cb",
		});
		svc.approveCandidate(cand.id, "reviewed cb", proj);
		const bankA = bankForScope("project", proj);
		const bankB = bankA + "-foreign";
		expect(bankA).not.toBe(bankB);
		const realId = "mem-cross-same-id";
		{
			const db = new Database(path.join(dir, "learn.db"));
			db.prepare(
				"INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(cand.id, "projection", proj, "project", realId, bankA, Date.now());
			db.close();
		}
		expect(svc.getOperationIntent(cand.id)?.mnemopiId).toBe(realId);
		expect(svc.getOperationIntent(cand.id)?.mnemopiBank).toBe(bankA);
		expect(svc.getProjection(cand.id)).toBeNull();
		expect(svc.getCandidate(cand.id)?.status).toBe("projection_pending");

		let editCalls = 0;
		const mnemopiCross: unknown = {
			getScopedRetainTarget: () => ({ bank: bankA }),
			getScopedRecallTargets: () => [{ bank: bankA }, { bank: bankB }],
			// Simulate getScopedMemory returning same ID but from foreign bankB — accessible, but not proof of absence in bankA
			getScopedMemoryInBank: (id: string, _bank: string) => {
				if (id === realId) return { bank: bankB };
				return null;
			},
			editScopedMemoryInBank: (op: string, id: string, _bank: string) => {
				editCalls++;
				// Simulate bankless not_found (exact bank lookup unavailable) -> should preserve projection/intent
				return { status: "not_found", bank: undefined };
			},
		};
		const recovered = svc.recoverOperationIntents(mnemopiCross as never);
		// Must NOT have cleared intent as "absent" based on cross-bank mismatch; should retain for exact-bank reconciliation
		// Previous buggy code would have set absent=true for bankB != bankA and cleared intent; fixed code retains
		expect(recovered).toBe(0);
		expect(svc.getOperationIntent(cand.id)?.mnemopiId).toBe(realId);
		expect(svc.getOperationIntent(cand.id)?.mnemopiBank).toBe(bankA);
		expect(svc.getProjection(cand.id)).toBeNull();
		// Status should remain projection_pending or needs_review but not approved, and not deleted
		expect(["projection_pending", "needs_review"]).toContain(svc.getCandidate(cand.id)?.status);
		// Edit should NOT be called when exact read shows foreign bank (capability-gated, no foreign mutation)
		expect(editCalls).toBe(0);

		svc.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	});

	it("real-ID crash window reconciles via exact bank without duplicate write", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-real-reconcile-"));
		const proj = canonicalProjectIdentity(fs.mkdtempSync(path.join(os.tmpdir(), "omp-real-reconcile-proj-")));
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({
			episodeId: "ep-rr",
			sessionId: "sess-rr",
			projectIdentity: proj,
			toolName: "bash",
			toolCallId: "tc-rr",
			failureMessage: "fail rr",
			scope: "project",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-rr",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-rr",
			episodeId: "ep-rr",
		});
		svc.approveCandidate(cand.id, "reviewed rr", proj);
		const bank = bankForScope("project", proj);
		const realId = "mem-real-reconcile-1";
		{
			const db = new Database(path.join(dir, "learn.db"));
			db.prepare(
				"INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(cand.id, "projection", proj, "project", realId, bank, Date.now());
			db.close();
		}
		let rememberCalls = 0;
		const mnemopi: unknown = {
			rememberScopedIdempotent: () => {
				rememberCalls++;
				return "mem-should-not-be-created-rr";
			},
			getScopedMemoryInBank: (id: string, _bank: string) => (id === realId ? { bank } : null),
			getScopedRetainTarget: () => ({ bank }),
			getScopedRecallTargets: () => [{ bank }],
			editScopedMemoryInBank: () => ({ status: "deleted", bank }),
		};
		// Direct retry via projectToMnemopiReal should reconcile without duplicate write
		const res = await svc.projectToMnemopiReal(cand.id, mnemopi as never);
		expect(rememberCalls).toBe(0);
		expect(res.ok).toBe(true);
		expect(res.mnemopiId).toBe(realId);
		expect(svc.getProjection(cand.id)?.mnemopiId).toBe(realId);
		expect(svc.getCandidate(cand.id)?.status).toBe("approved");
		expect(svc.getOperationIntent(cand.id)).toBeNull();

		svc.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	});
	it("missing idempotent capability blocks external write without mutation", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-missing-idem-"));
		const proj = canonicalProjectIdentity(fs.mkdtempSync(path.join(os.tmpdir(), "omp-missing-idem-proj-")));
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({
			episodeId: "ep-miss",
			sessionId: "sess-miss",
			projectIdentity: proj,
			toolName: "bash",
			toolCallId: "tc-miss",
			failureMessage: "fail miss",
			scope: "project",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-miss",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-miss",
			episodeId: "ep-miss",
		});
		svc.approveCandidate(cand.id, "reviewed miss", proj);
		expect(svc.getCandidate(cand.id)?.status).toBe("projection_pending");
		// Mock with only non-idempotent rememberScoped (no idempotent) should not be called
		let rememberCalls = 0;
		const mnemopiNoCap: unknown = {
			rememberScoped: () => {
				rememberCalls++;
				return "mem-should-not-be-created";
			},
			getScopedMemoryInBank: () => null,
			getScopedRetainTarget: () => ({ bank: bankForScope("project", proj) }),
		};
		const res = await svc.projectToMnemopiReal(cand.id, mnemopiNoCap as never);
		expect(rememberCalls).toBe(0);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("missing idempotent");
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");
		expect(svc.getProjection(cand.id)).toBeNull();
		expect(svc.getOperationIntent(cand.id)).toBeNull(); // no sentinel created when capability missing
		svc.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	});

	it("missing exact-bank capability preserves intent without foreign mutation", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-missing-exact-"));
		const proj = canonicalProjectIdentity(fs.mkdtempSync(path.join(os.tmpdir(), "omp-missing-exact-proj-")));
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({
			episodeId: "ep-exact",
			sessionId: "sess-exact",
			projectIdentity: proj,
			toolName: "bash",
			toolCallId: "tc-exact",
			failureMessage: "fail exact",
			scope: "project",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-exact",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-exact",
			episodeId: "ep-exact",
		});
		svc.approveCandidate(cand.id, "reviewed exact", proj);
		const bank = bankForScope("project", proj);
		const memId = "mem-exact-1";
		// First project succeeds with full capabilities
		const okMnemopi: unknown = {
			rememberScopedIdempotent: () => memId,
			getScopedMemoryInBank: (id: string, b: string) => (id === memId && b === bank ? { bank } : null),
			getScopedRetainTarget: () => ({ bank }),
		};
		const projRes = await svc.projectToMnemopiReal(cand.id, okMnemopi as never);
		expect(projRes.ok).toBe(true);
		expect(svc.getProjection(cand.id)?.mnemopiId).toBe(memId);
		// Now attempt delete with cross-bank edit only (no exact capability) - should preserve without calling edit
		let editCalls = 0;
		const crossOnly: unknown = {
			editScopedMemory: () => {
				editCalls++;
				return { status: "deleted", bank };
			},
			getScopedMemory: () => ({ bank }),
		};
		const delOk = svc.deleteCandidateWithMnemopi(cand.id, proj, crossOnly as never);
		expect(editCalls).toBe(0);
		expect(delOk).toBe(false);
		expect(svc.getProjection(cand.id)).not.toBeNull();
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");
		svc.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	});
});
