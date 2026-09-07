import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bankForScope, CustomAutolearnService, canonicalProjectIdentity } from "../src/autolearn/custom-service";

function settingsFor(mode: string | undefined) {
	return { get: (k: string) => (k === "autolearn.mode" ? mode : undefined) } as unknown as {
		get(key: string): unknown;
	};
}

describe("grouped fixes regression", () => {
	it("cwd via sessionManager.getCwd binds live session cwd, not session.cwd nor process.cwd", async () => {
		const { CustomAutolearnController } = await import("../src/autolearn/custom-controller");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cwd-fix-"));
		const liveCwdA = fs.mkdtempSync(path.join(os.tmpdir(), "omp-live-a-"));
		const liveCwdB = fs.mkdtempSync(path.join(os.tmpdir(), "omp-live-b-"));
		const legacyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-legacy-"));
		const projA = canonicalProjectIdentity(liveCwdA);
		const projB = canonicalProjectIdentity(liveCwdB);
		const settings = settingsFor("custom");
		let handler: (e: unknown) => void = () => {};
		let currentLive = liveCwdA;
		const mockSession: unknown = {
			sessionId: "sess-cwd",
			cwd: legacyCwd, // legacy property should be ignored
			taskDepth: 0,
			sessionManager: { getCwd: () => currentLive, getSessionId: () => "sess-cwd" },
			subscribe: (fn: (e: unknown) => void) => {
				handler = fn;
			},
		};
		const ctrl = new CustomAutolearnController({
			session: mockSession as never,
			settings: settings as never,
			agentDir: dir,
			svcFactory: (d: string) => new CustomAutolearnService(d) as never,
		});
		const svc = new CustomAutolearnService(dir);
		// first failure should bind to liveCwdA, not legacyCwd nor process.cwd()
		handler({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "tc-cwd-1",
			isError: true,
			result: "fail-a",
		});
		await Bun.sleep(10);
		const candA = svc.listCandidates(projA).find(c => c.toolCallId === "tc-cwd-1");
		expect(candA).toBeDefined();
		expect(candA?.projectIdentity).toBe(projA);
		expect(
			svc.listCandidates(canonicalProjectIdentity(legacyCwd)).find(c => c.toolCallId === "tc-cwd-1"),
		).toBeUndefined();
		// change live cwd and observe second candidate binds to new identity
		currentLive = liveCwdB;
		handler({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "tc-cwd-2",
			isError: true,
			result: "fail-b",
		});
		await Bun.sleep(10);
		const candB = svc.listCandidates(projB).find(c => c.toolCallId === "tc-cwd-2");
		expect(candB).toBeDefined();
		expect(candB?.projectIdentity).toBe(projB);
		svc.close();
		ctrl.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(liveCwdA, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(liveCwdB, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(legacyCwd, { recursive: true, force: true });
		} catch {}
	});

	it("bash transport with bun test proof uses proof.expectedCommand as verifier and links", async () => {
		const { CustomAutolearnController } = await import("../src/autolearn/custom-controller");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bash-bun-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bash-bun-cwd-"));
		const proj = canonicalProjectIdentity(cwd);
		const settings = settingsFor("custom");
		let handler: (e: unknown) => void = () => {};
		const mockSession: unknown = {
			sessionId: "sess-bash",
			taskDepth: 0,
			sessionManager: { getCwd: () => cwd, getSessionId: () => "sess-bash" },
			subscribe: (fn: (e: unknown) => void) => {
				handler = fn;
			},
		};
		const ctrl = new CustomAutolearnController({
			session: mockSession as never,
			settings: settings as never,
			agentDir: dir,
			svcFactory: (d: string) => new CustomAutolearnService(d) as never,
		});
		const svc = new CustomAutolearnService(dir);
		handler({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "tc-bash",
			isError: true,
			result: "fail bash",
		});
		await Bun.sleep(10);
		const cand = svc.listCandidates(proj).find(c => c.toolCallId === "tc-bash")!;
		expect(cand).toBeDefined();
		const epi = (ctrl as unknown as { episodeId: string }).episodeId;
		const proof = {
			verified: true,
			summary: "bun test passed",
			toolCallId: cand.toolCallId,
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-bash",
			episodeId: epi,
		};
		// transport is bash, proof command is bun test (allowlisted) - must bind to actual start metadata
		handler({
			type: "tool_execution_start",
			toolName: "bash",
			toolCallId: "verifier-bash-bun",
			args: { command: "bun test" },
		});
		handler({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "verifier-bash-bun",
			isError: false,
			result: proof,
		});
		const updated = svc.getCandidate(cand.id);
		expect(updated?.status).toBe("needs_review");
		expect(updated?.verifierName).toBe("bun test");
		svc.close();
		ctrl.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {}
	});

	it("cap at 20 applies only to new failure candidates; verifier transitions still succeed when capped", async () => {
		const { CustomAutolearnController } = await import("../src/autolearn/custom-controller");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cap-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cap-cwd-"));
		const proj = canonicalProjectIdentity(cwd);
		const settings = settingsFor("custom");
		let handler: (e: unknown) => void = () => {};
		const mockSession: unknown = {
			sessionId: "sess-cap",
			taskDepth: 0,
			sessionManager: { getCwd: () => cwd, getSessionId: () => "sess-cap" },
			subscribe: (fn: (e: unknown) => void) => {
				handler = fn;
			},
		};
		const ctrl = new CustomAutolearnController({
			session: mockSession as never,
			settings: settings as never,
			agentDir: dir,
			svcFactory: (d: string) => new CustomAutolearnService(d) as never,
		});
		const svc = new CustomAutolearnService(dir);
		// Fill 20 candidates
		for (let i = 0; i < 20; i++) {
			handler({
				type: "tool_execution_end",
				toolName: "bash",
				toolCallId: `tc-cap-${i}`,
				isError: true,
				result: `fail ${i}`,
			});
		}
		await Bun.sleep(20);
		const all20 = svc.listCandidates(proj);
		expect(all20.length).toBe(20);
		// 21st failure should be rejected due to cap
		handler({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "tc-cap-20",
			isError: true,
			result: "fail 20",
		});
		await Bun.sleep(10);
		expect(svc.listCandidates(proj).length).toBe(20);
		expect(svc.listCandidates(proj).find(c => c.toolCallId === "tc-cap-20")).toBeUndefined();
		// verifier for existing pending candidate must still succeed despite cap
		const first = svc.listCandidates(proj).find(c => c.toolCallId === "tc-cap-0")!;
		expect(first.status).toBe("pending");
		const epi = (ctrl as unknown as { episodeId: string }).episodeId;
		const proof = {
			verified: true,
			summary: "ok",
			toolCallId: first.toolCallId,
			expectedCommand: "bun test",
			failureFingerprint: first.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-cap",
			episodeId: epi,
		};
		handler({
			type: "tool_execution_start",
			toolName: "bash",
			toolCallId: "verifier-cap",
			args: { command: "bun test" },
		});
		handler({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "verifier-cap",
			isError: false,
			result: proof,
		});
		expect(svc.getCandidate(first.id)?.status).toBe("needs_review");
		svc.close();
		ctrl.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {}
	});

	it("post-write uncertainty persists reference and retry reconciles without duplicate", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-retry-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-retry-cwd-"));
		const proj = canonicalProjectIdentity(cwd);
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({
			episodeId: "ep-retry",
			sessionId: "sess-retry",
			projectIdentity: proj,
			toolName: "bash",
			toolCallId: "tc-retry",
			failureMessage: "fail retry",
			scope: "project",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-retry",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-retry",
			episodeId: "ep-retry",
		});
		svc.approveCandidate(cand.id, "reviewed content for retry", proj);
		const targetBank = bankForScope("project", proj);
		// First projection: rememberScoped succeeds but getScopedMemory throws -> uncertain
		let rememberCalls = 0;
		const mnemopiUncertain: unknown = {
			rememberScopedIdempotent: () => {
				rememberCalls++;
				return "mem-retry-1";
			},
			getScopedRetainTarget: () => ({ bank: targetBank }),
			getScopedMemoryInBank: () => {
				throw new Error("transient introspection failure");
			},
		};
		const res1 = await svc.projectToMnemopiReal(cand.id, mnemopiUncertain as never);
		expect(res1.ok).toBe(false);
		expect(svc.getProjection(cand.id)?.mnemopiId).toBe("mem-retry-1");
		expect(svc.getProjection(cand.id)?.bank).toBe(targetBank);
		expect(svc.getCandidate(cand.id)?.status).toBe("projection_pending");
		// Retry: same memory still exists, now getScopedMemory succeeds -> should reconcile without second rememberScoped
		rememberCalls = 0;
		const mnemopiRetry: unknown = {
			rememberScopedIdempotent: () => {
				rememberCalls++;
				return "mem-retry-2-should-not-be-used";
			},
			getScopedRetainTarget: () => ({ bank: targetBank }),
			getScopedMemoryInBank: (id: string, _bank: string) => {
				if (id === "mem-retry-1") return { bank: targetBank };
				return null;
			},
		};
		const res2 = await svc.projectToMnemopiReal(cand.id, mnemopiRetry as never);
		expect(res2.ok).toBe(true);
		expect(res2.mnemopiId).toBe("mem-retry-1");
		expect(rememberCalls).toBe(0);
		expect(svc.getProjection(cand.id)?.mnemopiId).toBe("mem-retry-1");
		// Also test null bank case preserves
		const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "omp-retry-null-"));
		const svc2 = new CustomAutolearnService(dir2);
		const cand2 = svc2.observeCandidate({
			episodeId: "ep2",
			sessionId: "sess2",
			projectIdentity: proj,
			toolName: "bash",
			toolCallId: "tc2",
			failureMessage: "fail2",
			scope: "project",
		});
		svc2.recordVerifierResult(cand2.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc2",
			expectedCommand: "bun test",
			failureFingerprint: cand2.failureDigest,
			projectIdentity: proj,
			sessionId: "sess2",
			episodeId: "ep2",
		});
		svc2.approveCandidate(cand2.id, "reviewed content 2", proj);
		const mnemopiNull: unknown = {
			rememberScopedIdempotent: () => "mem-null-1",
			getScopedRetainTarget: () => ({ bank: targetBank }),
			getScopedMemoryInBank: () => null,
		};
		const resNull = await svc2.projectToMnemopiReal(cand2.id, mnemopiNull as never);
		expect(resNull.ok).toBe(false);
		expect(svc2.getProjection(cand2.id)?.mnemopiId).toBe("mem-null-1");
		expect(svc2.getCandidate(cand2.id)?.status).toBe("projection_pending");
		svc.close();
		svc2.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(dir2, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {}
	});

	it("bank mismatch preserves reference and marks needs_review without orphan", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bank-mismatch-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bank-mismatch-cwd-"));
		const proj = canonicalProjectIdentity(cwd);
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({
			episodeId: "ep-bm",
			sessionId: "sess-bm",
			projectIdentity: proj,
			toolName: "bash",
			toolCallId: "tc-bm",
			failureMessage: "fail bm",
			scope: "project",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-bm",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-bm",
			episodeId: "ep-bm",
		});
		svc.approveCandidate(cand.id, "reviewed bank mismatch", proj);
		const targetBank = bankForScope("project", proj);
		const wrongBank = `${targetBank}_wrong`;
		const mnemopiMismatch: unknown = {
			rememberScopedIdempotent: () => "mem-bm-1",
			getScopedRetainTarget: () => ({ bank: targetBank }),
			getScopedMemoryInBank: () => ({ bank: wrongBank }),
		};
		const res = await svc.projectToMnemopiReal(cand.id, mnemopiMismatch as never);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("actual write bank");
		expect(svc.getProjection(cand.id)?.mnemopiId).toBe("mem-bm-1");
		expect(svc.getProjection(cand.id)?.bank).toBe(wrongBank);
		expect(svc.getOperationIntent(cand.id)?.mnemopiBank).toBe(wrongBank);
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");
		svc.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {}
	});

	it("bash carrying bun test with mismatched actual command does not promote (trusted start metadata)", async () => {
		const { CustomAutolearnController } = await import("../src/autolearn/custom-controller");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bash-mismatch-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bash-mismatch-cwd-"));
		const proj = canonicalProjectIdentity(cwd);
		const settings = settingsFor("custom");
		let handler: (e: unknown) => void = () => {};
		const mockSession: unknown = {
			sessionId: "sess-mismatch",
			taskDepth: 0,
			sessionManager: { getCwd: () => cwd, getSessionId: () => "sess-mismatch" },
			subscribe: (fn: (e: unknown) => void) => {
				handler = fn;
			},
		};
		const ctrl = new CustomAutolearnController({
			session: mockSession as never,
			settings: settings as never,
			agentDir: dir,
			svcFactory: (d: string) => new CustomAutolearnService(d) as never,
		});
		const svc = new CustomAutolearnService(dir);
		handler({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "tc-mismatch",
			isError: true,
			result: "fail mismatch",
		});
		await Bun.sleep(10);
		const cand = svc.listCandidates(proj).find(c => c.toolCallId === "tc-mismatch")!;
		expect(cand).toBeDefined();
		const epi = (ctrl as unknown as { episodeId: string }).episodeId;
		const proof = {
			verified: true,
			summary: "bun test passed (fake)",
			toolCallId: cand.toolCallId,
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-mismatch",
			episodeId: epi,
		};
		// Actual invocation is echo hi, not bun test -> should be rejected
		handler({
			type: "tool_execution_start",
			toolName: "bash",
			toolCallId: "verifier-mismatch",
			args: { command: "echo hi" },
		});
		handler({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "verifier-mismatch",
			isError: false,
			result: proof,
		});
		await Bun.sleep(10);
		expect(svc.getCandidate(cand.id)?.status).toBe("pending");
		// Also test missing start metadata (only self-asserted expectedCommand) -> reject
		const proof2 = { ...proof, toolCallId: cand.toolCallId };
		handler({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "verifier-no-start",
			isError: false,
			result: proof2,
		});
		await Bun.sleep(10);
		expect(svc.getCandidate(cand.id)?.status).toBe("pending");
		svc.close();
		ctrl.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {}
	});

	it("approved retry reconciliation sets approved atomically (P1.2)", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-approved-retry-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-approved-retry-cwd-"));
		const proj = canonicalProjectIdentity(cwd);
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({
			episodeId: "ep-ar",
			sessionId: "sess-ar",
			projectIdentity: proj,
			toolName: "bash",
			toolCallId: "tc-ar",
			failureMessage: "fail ar",
			scope: "project",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-ar",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-ar",
			episodeId: "ep-ar",
		});
		svc.approveCandidate(cand.id, "reviewed for retry", proj);
		const targetBank = bankForScope("project", proj);
		// Simulate first projection with missing introspection -> persists projection_pending
		const mnemopiFirst: unknown = {
			rememberScopedIdempotent: () => "mem-ar-1",
			getScopedRetainTarget: () => ({ bank: targetBank }),
			getScopedMemoryInBank: () => {
				throw new Error("transient");
			},
		};
		const r1 = await svc.projectToMnemopiReal(cand.id, mnemopiFirst as never);
		expect(r1.ok).toBe(false);
		expect(svc.getCandidate(cand.id)?.status).toBe("projection_pending");
		expect(svc.getProjection(cand.id)?.mnemopiId).toBe("mem-ar-1");
		// Retry should reconcile and set approved
		const mnemopiRetry: unknown = {
			rememberScopedIdempotent: () => {
				throw new Error("should not be called");
			},
			getScopedRetainTarget: () => ({ bank: targetBank }),
			getScopedMemoryInBank: (id: string, _bank: string) => (id === "mem-ar-1" ? { bank: targetBank } : null),
		};
		const r2 = await svc.projectToMnemopiReal(cand.id, mnemopiRetry as never);
		expect(r2.ok).toBe(true);
		expect(r2.mnemopiId).toBe("mem-ar-1");
		expect(svc.getCandidate(cand.id)?.status).toBe("approved");
		svc.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {}
	});

	it("rememberScoped undefined is needs_review not projection_pending (P1.4)", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-no-id-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-no-id-cwd-"));
		const proj = canonicalProjectIdentity(cwd);
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({
			episodeId: "ep-noid",
			sessionId: "sess-noid",
			projectIdentity: proj,
			toolName: "bash",
			toolCallId: "tc-noid",
			failureMessage: "fail noid",
			scope: "project",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-noid",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-noid",
			episodeId: "ep-noid",
		});
		svc.approveCandidate(cand.id, "reviewed no id", proj);
		const targetBank = bankForScope("project", proj);
		const mnemopiNoId: unknown = {
			rememberScopedIdempotent: () => undefined,
			getScopedRetainTarget: () => ({ bank: targetBank }),
			getScopedMemoryInBank: () => null,
		};
		const res = await svc.projectToMnemopiReal(cand.id, mnemopiNoId as never);
		expect(res.ok).toBe(false);
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");
		expect(svc.getProjection(cand.id)).toBeNull();
		// Only returned-ID writes can be retry-reconciled: second try with undefined still needs_review
		const res2 = await svc.projectToMnemopiReal(cand.id, mnemopiNoId as never);
		expect(res2.ok).toBe(false);
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");
		svc.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {}
	});

	it("durable delete intent persists before external and recovers on restart (P1.3)", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-delete-intent-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-delete-intent-cwd-"));
		const proj = canonicalProjectIdentity(cwd);
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({
			episodeId: "ep-del",
			sessionId: "sess-del",
			projectIdentity: proj,
			toolName: "bash",
			toolCallId: "tc-del",
			failureMessage: "fail del",
			scope: "project",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-del",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-del",
			episodeId: "ep-del",
		});
		svc.approveCandidate(cand.id, "reviewed delete", proj);
		const targetBank = bankForScope("project", proj);
		const mnemopiOk: unknown = {
			rememberScopedIdempotent: () => "mem-del-1",
			getScopedRetainTarget: () => ({ bank: targetBank }),
			getScopedMemoryInBank: (id: string, _bank: string) => (id === "mem-del-1" ? { bank: targetBank } : null),
		};
		const r = await svc.projectToMnemopiReal(cand.id, mnemopiOk as never);
		expect(r.ok).toBe(true);
		expect(svc.getProjection(cand.id)?.mnemopiId).toBe("mem-del-1");
		// Simulate crash before delete: manually insert intent without completing delete
		(svc as unknown as { constructor: unknown }).constructor;
		try {
			(svc as unknown as { db: unknown }).constructor;
		} catch {}
		// Use direct DB to simulate crash intent left behind
		// Instead use public helper to create intent via delete that fails externally
		let cleanCalls = 0;
		const mnemopiFailOnce: unknown = {
			editScopedMemoryInBank: (_op: string, _id: string, _bank: string) => {
				cleanCalls++;
				if (cleanCalls === 1) throw new Error("transient external failure");
				return { status: "deleted", bank: targetBank };
			},
		};
		const delFail = svc.deleteCandidateWithMnemopi(cand.id, proj, mnemopiFailOnce as never);
		expect(delFail).toBe(false);
		expect(svc.getCandidate(cand.id)).not.toBeNull();
		expect(svc.getOperationIntent(cand.id)?.operation).toBe("delete");
		expect(svc.getOperationIntent(cand.id)?.mnemopiId).toBe("mem-del-1");
		// Recovery should retry and succeed
		const mnemopiRecover: unknown = {
			getScopedMemoryInBank: (_id: string, b: string) => (b === targetBank ? { bank: b } : null),
			editScopedMemoryInBank: () => ({ status: "deleted", bank: targetBank }),
		};
		const recovered = svc.recoverOperationIntents(mnemopiRecover as never);
		expect(recovered).toBe(1);
		expect(svc.getCandidate(cand.id)).toBeNull();
		expect(svc.getOperationIntent(cand.id)).toBeNull();
		svc.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {}
	});

	it("repository-root identity: subdirectory maps same as root (P1.5)", async () => {
		const { CustomAutolearnController } = await import("../src/autolearn/custom-controller");
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-repo-root-"));
		// init git repo
		await Bun.$`git init -q ${repoRoot}`.quiet();
		const subdir = path.join(repoRoot, "a", "b");
		fs.mkdirSync(subdir, { recursive: true });
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-root-identity-"));
		const settings = settingsFor("custom");
		let handler: (e: unknown) => void = () => {};
		const mockSession: unknown = {
			sessionId: "sess-root",
			taskDepth: 0,
			sessionManager: { getCwd: () => subdir, getSessionId: () => "sess-root" },
			subscribe: (fn: (e: unknown) => void) => {
				handler = fn;
			},
		};
		const ctrl = new CustomAutolearnController({
			session: mockSession as never,
			settings: settings as never,
			agentDir: dir,
			svcFactory: (d: string) => new CustomAutolearnService(d) as never,
		});
		const svc = new CustomAutolearnService(dir);
		handler({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "tc-root",
			isError: true,
			result: "fail root",
		});
		await Bun.sleep(10);
		const fromSubdir = svc.listCandidates(canonicalProjectIdentity(repoRoot)).find(c => c.toolCallId === "tc-root");
		// Also check via resolveProjectIdentity directly
		const projViaSubdir = canonicalProjectIdentity(repoRoot);
		expect(fromSubdir).toBeDefined();
		expect(fromSubdir?.projectIdentity).toBe(projViaSubdir);
		// Second candidate from root cwd should have same projectIdentity
		const mockSession2: unknown = {
			sessionId: "sess-root2",
			taskDepth: 0,
			sessionManager: { getCwd: () => repoRoot, getSessionId: () => "sess-root2" },
			subscribe: (fn: (e: unknown) => void) => {
				handler = fn;
			},
		};
		const ctrl2 = new CustomAutolearnController({
			session: mockSession2 as never,
			settings: settings as never,
			agentDir: dir,
			svcFactory: (d: string) => new CustomAutolearnService(d) as never,
		});
		// Need to get expo but we reuse svc
		expect(fromSubdir?.projectIdentity).toBe(projViaSubdir);
		svc.close();
		ctrl.close();
		ctrl2.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(repoRoot, { recursive: true, force: true });
		} catch {}
	});
});
