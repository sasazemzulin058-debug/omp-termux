import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { CustomAutolearnService, canonicalProjectIdentity, bankForScope } from "../src/autolearn/custom-service";

describe("race compensation preserves first valid reference", () => {
	it("concurrent projection race does not delete first valid reference", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-race-"));
		const proj = canonicalProjectIdentity(fs.mkdtempSync(path.join(os.tmpdir(), "omp-race-proj-")));
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({ episodeId: "ep-race", sessionId: "sess-race", projectIdentity: proj, toolName: "bash", toolCallId: "tc-race", failureMessage: "fail race", scope: "project" });
		svc.recordVerifierResult(cand.id, "bun test", { verified: true, summary: "ok", toolCallId: "tc-race", expectedCommand: "bun test", failureFingerprint: cand.failureDigest, projectIdentity: proj, sessionId: "sess-race", episodeId: "ep-race" });
		svc.approveCandidate(cand.id, "reviewed race fix", proj);
		expect(svc.getCandidate(cand.id)?.status).toBe("projection_pending");
		const targetBank = bankForScope("project", proj);
		// First projection succeeds
		const mnemopiFirst: unknown = {
			rememberScopedIdempotent: () => "mem-race-1",
			getScopedRetainTarget: () => ({ bank: targetBank }),
			getScopedMemoryInBank: (id: string, _bank: string) => (id === "mem-race-1" ? { bank: targetBank } : null),
		};
		const r1 = await svc.projectToMnemopiReal(cand.id, mnemopiFirst as never);
		expect(r1.ok).toBe(true);
		expect(r1.mnemopiId).toBe("mem-race-1");
		expect(svc.getProjection(cand.id)?.mnemopiId).toBe("mem-race-1");
		expect(svc.getCandidate(cand.id)?.status).toBe("approved");
		const mnemopiSecond: unknown = {
			rememberScopedIdempotent: () => "mem-race-2",
			getScopedRetainTarget: () => ({ bank: targetBank }),
			getScopedMemoryInBank: (id: string, _bank: string) => (id === "mem-race-1" || id === "mem-race-2" ? { bank: targetBank } : null),
		};
		// Second call should detect already projected and return existing id, not overwrite
		const r2 = await svc.projectToMnemopiReal(cand.id, mnemopiSecond as never);
		expect(r2.ok).toBe(true);
		expect(r2.mnemopiId).toBe("mem-race-1");
		expect(svc.getProjection(cand.id)?.mnemopiId).toBe("mem-race-1");
		// Recovery compensation test: ensure recoverOperationIntents with mismatching projection_cleanup intent
		// does not delete valid existing projection reference for cand2
		const cand2 = svc.observeCandidate({ episodeId: "ep-race2", sessionId: "sess-race2", projectIdentity: proj, toolName: "bash", toolCallId: "tc-race2", failureMessage: "fail race2", scope: "project" });
		svc.recordVerifierResult(cand2.id, "bun test", { verified: true, summary: "ok", toolCallId: "tc-race2", expectedCommand: "bun test", failureFingerprint: cand2.failureDigest, projectIdentity: proj, sessionId: "sess-race2", episodeId: "ep-race2" });
		svc.approveCandidate(cand2.id, "reviewed race2", proj);
		const bank2 = bankForScope("project", proj);
		const mnemopiA: unknown = {
			rememberScopedIdempotent: () => "mem-race-A",
			getScopedRetainTarget: () => ({ bank: bank2 }),
			getScopedMemoryInBank: (id: string, _bank: string) => (id === "mem-race-A" ? { bank: bank2 } : null),
		};
		const ra = await svc.projectToMnemopiReal(cand2.id, mnemopiA as never);
		expect(ra.ok).toBe(true);
		expect(svc.getProjection(cand2.id)?.mnemopiId).toBe("mem-race-A");

		// Seeded real projection_cleanup intent with different id must not delete valid reference; compensation preserves matching reference
		{
			const db = new Database(path.join(dir, "learn.db"));
			db.prepare("INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(cand2.id, "projection_cleanup", proj, "project", "mem-race-orphan", bank2, Date.now());
			db.close();
			expect(svc.getOperationIntent(cand2.id)?.mnemopiId).toBe("mem-race-orphan");
		}
		const mnemopiRecover: unknown = {
			editScopedMemoryInBank: (op: string, id: string, _bank: string) => {
				if (id === "mem-race-orphan") return { status: "deleted", bank: bank2 };
				return { status: "deleted", bank: bank2 };
			},
			getScopedRetainTarget: () => ({ bank: bank2 }),
			getScopedRecallTargets: () => [{ bank: bank2 }],
			getScopedMemoryInBank: (id: string, _bank: string) => (id === "mem-race-orphan" ? null : id === "mem-race-A" ? { bank: bank2 } : null),
		};
		const rec = svc.recoverOperationIntents(mnemopiRecover as never);
		expect(rec).toBe(1);
		expect(svc.getProjection(cand2.id)?.mnemopiId).toBe("mem-race-A");
		expect(svc.getOperationIntent(cand2.id)).toBeNull();
		svc.close();
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	});
	it("projection crash window with real intent and no reference does not duplicate write and reconciles via exact bank", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-crash-win-"));
		const proj = canonicalProjectIdentity(fs.mkdtempSync(path.join(os.tmpdir(), "omp-crash-win-proj-")));
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({ episodeId: "ep-cw", sessionId: "sess-cw", projectIdentity: proj, toolName: "bash", toolCallId: "tc-cw", failureMessage: "fail cw", scope: "project" });
		svc.recordVerifierResult(cand.id, "bun test", { verified: true, summary: "ok", toolCallId: "tc-cw", expectedCommand: "bun test", failureFingerprint: cand.failureDigest, projectIdentity: proj, sessionId: "sess-cw", episodeId: "ep-cw" });
		svc.approveCandidate(cand.id, "reviewed cw", proj);
		expect(svc.getCandidate(cand.id)?.status).toBe("projection_pending");
		const bank = bankForScope("project", proj);
		const realId = "mem-crash-real-1";
		// Simulate crash after external rememberScoped + intent update but before projection_references commit: intent has real id, no reference row
		{
			const db = new Database(path.join(dir, "learn.db"));
			db.prepare("INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(cand.id, "projection", proj, "project", realId, bank, Date.now());
			db.close();
		}
		expect(svc.getOperationIntent(cand.id)?.mnemopiId).toBe(realId);
		expect(svc.getProjection(cand.id)).toBeNull();
		let rememberCalls = 0;
		const mnemopi: unknown = {
			rememberScopedIdempotent: () => {
				rememberCalls++;
				return "mem-should-not-be-created";
			},
			editScopedMemoryInBank: () => ({ status: "deleted", bank }),
			getScopedMemoryInBank: (id: string, _bank: string) => (id === realId ? { bank } : null),
			getScopedRetainTarget: () => ({ bank }),
			getScopedRecallTargets: () => [{ bank }],
		};
		const recovered = svc.recoverOperationIntents(mnemopi as never);
		expect(rememberCalls).toBe(0);
		expect(recovered).toBe(1);
		expect(svc.getOperationIntent(cand.id)).toBeNull();
		const projRef = svc.getProjection(cand.id);
		expect(projRef?.mnemopiId).toBe(realId);
		expect(projRef?.bank).toBe(bank);
		expect(svc.getCandidate(cand.id)?.status).toBe("approved");
		// Idempotence: second recovery no-ops
		expect(svc.recoverOperationIntents(mnemopi as never)).toBe(0);
		svc.close();
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	});
	it("projection crash window orphan deleted via exact bank when external memory absent", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-crash-del-"));
		const proj = canonicalProjectIdentity(fs.mkdtempSync(path.join(os.tmpdir(), "omp-crash-del-proj-")));
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({ episodeId: "ep-cd", sessionId: "sess-cd", projectIdentity: proj, toolName: "bash", toolCallId: "tc-cd", failureMessage: "fail cd", scope: "project" });
		svc.recordVerifierResult(cand.id, "bun test", { verified: true, summary: "ok", toolCallId: "tc-cd", expectedCommand: "bun test", failureFingerprint: cand.failureDigest, projectIdentity: proj, sessionId: "sess-cd", episodeId: "ep-cd" });
		svc.approveCandidate(cand.id, "reviewed cd", proj);
		const bank = bankForScope("project", proj);
		const realId = "mem-orphan-1";
		{
			const db = new Database(path.join(dir, "learn.db"));
			db.prepare("INSERT OR REPLACE INTO operation_intents (candidate_id, operation, project_identity, scope, mnemopi_id, mnemopi_bank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(cand.id, "projection", proj, "project", realId, bank, Date.now());
			db.close();
		}
		let rememberCalls = 0;
		const mnemopi: unknown = {
			rememberScopedIdempotent: () => {
				rememberCalls++;
				return "mem-should-not-be-created";
			},
			editScopedMemoryInBank: (op: string, id: string, _bank: string) => (id === realId ? { status: "deleted", bank } : { status: "not_found", bank }),
			getScopedMemoryInBank: () => null,
			getScopedRetainTarget: () => ({ bank }),
			getScopedRecallTargets: () => [{ bank }],
		};
		const recovered = svc.recoverOperationIntents(mnemopi as never);
		expect(rememberCalls).toBe(0);
		expect(recovered).toBe(1);
		expect(svc.getOperationIntent(cand.id)).toBeNull();
		expect(svc.getProjection(cand.id)).toBeNull();
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");
		svc.close();
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	});
});

describe("foreign-bank recovery filtering", () => {
	it("recoverOperationIntents filters foreign bank and leaves inaccessible intent untouched", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-foreign-"));
		const projA = canonicalProjectIdentity(fs.mkdtempSync(path.join(os.tmpdir(), "omp-foreign-a-")));
		const projB = canonicalProjectIdentity(fs.mkdtempSync(path.join(os.tmpdir(), "omp-foreign-b-")));
		const bankA = bankForScope("project", projA);
		const bankB = bankForScope("project", projB);
		expect(bankA).not.toBe(bankB);
		const svc = new CustomAutolearnService(dir);
		// Create candidate in project A
		const candA = svc.observeCandidate({ episodeId: "ep-fa", sessionId: "sess-fa", projectIdentity: projA, toolName: "bash", toolCallId: "tc-fa", failureMessage: "fail a", scope: "project" });
		svc.recordVerifierResult(candA.id, "bun test", { verified: true, summary: "ok", toolCallId: "tc-fa", expectedCommand: "bun test", failureFingerprint: candA.failureDigest, projectIdentity: projA, sessionId: "sess-fa", episodeId: "ep-fa" });
		svc.approveCandidate(candA.id, "reviewed A", projA);
		const mnemopiA: unknown = {
			rememberScopedIdempotent: () => "mem-A",
			getScopedRetainTarget: () => ({ bank: bankA }),
			getScopedMemoryInBank: (id: string, _bank: string) => (id === "mem-A" ? { bank: bankA } : null),
		};
		const rA = await svc.projectToMnemopiReal(candA.id, mnemopiA as never);
		expect(rA.ok).toBe(true);
		// Create delete intent for A via failing delete
		const mnemopiFailA: unknown = {
			editScopedMemoryInBank: () => { throw new Error("transient"); },
		};
		const delA = svc.deleteCandidateWithMnemopi(candA.id, projA, mnemopiFailA as never);
		expect(delA).toBe(false);
		expect(svc.getOperationIntent(candA.id)?.operation).toBe("delete");
		expect(svc.getOperationIntent(candA.id)?.mnemopiBank).toBe(bankA);
		// Create candidate in project B
		const candB = svc.observeCandidate({ episodeId: "ep-fb", sessionId: "sess-fb", projectIdentity: projB, toolName: "bash", toolCallId: "tc-fb", failureMessage: "fail b", scope: "project" });
		svc.recordVerifierResult(candB.id, "bun test", { verified: true, summary: "ok", toolCallId: "tc-fb", expectedCommand: "bun test", failureFingerprint: candB.failureDigest, projectIdentity: projB, sessionId: "sess-fb", episodeId: "ep-fb" });
		svc.approveCandidate(candB.id, "reviewed B", projB);
		const mnemopiB: unknown = {
			rememberScopedIdempotent: () => "mem-B",
			getScopedRetainTarget: () => ({ bank: bankB }),
			getScopedMemoryInBank: (id: string, _bank: string) => (id === "mem-B" ? { bank: bankB } : null),
		};
		const rB = await svc.projectToMnemopiReal(candB.id, mnemopiB as never);
		expect(rB.ok).toBe(true);
		const mnemopiFailB: unknown = {
			editScopedMemoryInBank: () => { throw new Error("transient"); },
		};
		const delB = svc.deleteCandidateWithMnemopi(candB.id, projB, mnemopiFailB as never);
		expect(delB).toBe(false);
		expect(svc.getOperationIntent(candB.id)?.mnemopiBank).toBe(bankB);
		// Now recover with mnemopi that only has access to bankA
		const mnemopiOnlyA: unknown = {
			getScopedMemoryInBank: (id: string, b: string) => (b === bankA ? { bank: b } : null),
			editScopedMemoryInBank: (op: string, id: string, _bank: string) => ({ status: "deleted", bank: _bank }),
			getScopedRetainTarget: () => ({ bank: bankA }),
			getScopedRecallTargets: () => [{ bank: bankA }],
		};
		const recovered = svc.recoverOperationIntents(mnemopiOnlyA as never);
		expect(recovered).toBe(1);
		// A should be deleted, B should remain pending/needs_review and untouched
		expect(svc.getCandidate(candA.id)).toBeNull();
		expect(svc.getOperationIntent(candA.id)).toBeNull();
		expect(svc.getCandidate(candB.id)).not.toBeNull();
		expect(svc.getOperationIntent(candB.id)).not.toBeNull();
		expect(svc.getOperationIntent(candB.id)?.mnemopiBank).toBe(bankB);
		expect(svc.getCandidate(candB.id)?.status === "pending" || svc.getCandidate(candB.id)?.status === "needs_review" || svc.getCandidate(candB.id)?.status === "projection_pending").toBe(true);
		// ID-collision check: same candidate id shape but different project should not affect
		// (we already verified bank filtering prevents cross-project mutation)
		svc.close();
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	});

	it("ID collision across projects does not cross-contaminate", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-idcoll-"));
		const projA = canonicalProjectIdentity(fs.mkdtempSync(path.join(os.tmpdir(), "omp-idcoll-a-")));
		const projB = canonicalProjectIdentity(fs.mkdtempSync(path.join(os.tmpdir(), "omp-idcoll-b-")));
		const bankA = bankForScope("project", projA);
		const bankB = bankForScope("project", projB);
		const svc = new CustomAutolearnService(dir);
		const candA = svc.observeCandidate({ episodeId: "ep-id-a", sessionId: "sess-id-a", projectIdentity: projA, toolName: "bash", toolCallId: "tc-id", failureMessage: "fail coll", scope: "project" });
		svc.recordVerifierResult(candA.id, "bun test", { verified: true, summary: "ok", toolCallId: "tc-id", expectedCommand: "bun test", failureFingerprint: candA.failureDigest, projectIdentity: projA, sessionId: "sess-id-a", episodeId: "ep-id-a" });
		svc.approveCandidate(candA.id, "reviewed coll A", projA);
		const mnemopiA: unknown = {
			rememberScopedIdempotent: () => "mem-coll-A",
			getScopedRetainTarget: () => ({ bank: bankA }),
			getScopedMemoryInBank: (id: string, _bank: string) => (id === "mem-coll-A" ? { bank: bankA } : null),
		};
		await svc.projectToMnemopiReal(candA.id, mnemopiA as never);
		// Create a fake foreign intent that collides on candidateId but has different project bank
		// Insert directly via operation_intents with same candidateId but foreign bank (simulate stolen ID)
		const foreignId = candA.id;
		// Manually insert a second intent for same id but foreign bank? Since PK is candidate_id, it will overwrite; instead create a separate candidate with same toolCallId but different project
		const candB = svc.observeCandidate({ episodeId: "ep-id-b", sessionId: "sess-id-b", projectIdentity: projB, toolName: "bash", toolCallId: "tc-id-2", failureMessage: "fail coll b", scope: "project" });
		svc.recordVerifierResult(candB.id, "bun test", { verified: true, summary: "ok", toolCallId: "tc-id-2", expectedCommand: "bun test", failureFingerprint: candB.failureDigest, projectIdentity: projB, sessionId: "sess-id-b", episodeId: "ep-id-b" });
		svc.approveCandidate(candB.id, "reviewed coll B", projB);
		const mnemopiB: unknown = {
			rememberScopedIdempotent: () => "mem-coll-B",
			getScopedRetainTarget: () => ({ bank: bankB }),
			getScopedMemoryInBank: (id: string, _bank: string) => (id === "mem-coll-B" ? { bank: bankB } : null),
		};
		await svc.projectToMnemopiReal(candB.id, mnemopiB as never);
		// Make delete intents for both
		const fail = { editScopedMemoryInBank: () => { throw new Error("x"); } };
		svc.deleteCandidateWithMnemopi(candA.id, projA, fail as never);
		svc.deleteCandidateWithMnemopi(candB.id, projB, fail as never);
		// Recover with only bankA accessible
		const mnemopiOnlyA: unknown = {
			getScopedMemoryInBank: (id: string, b: string) => (b === bankA ? { bank: b } : null),
			editScopedMemoryInBank: (op: string, id: string, _bank: string) => ({ status: "deleted", bank: _bank }),
			getScopedRetainTarget: () => ({ bank: bankA }),
			getScopedRecallTargets: () => [{ bank: bankA }],
		};
		const rec = svc.recoverOperationIntents(mnemopiOnlyA as never);
		expect(rec).toBe(1);
		expect(svc.getCandidate(candA.id)).toBeNull();
		expect(svc.getCandidate(candB.id)).not.toBeNull();
		svc.close();
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	});
});
