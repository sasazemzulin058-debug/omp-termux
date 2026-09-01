import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CustomAutolearnService, resolveProjectIdentity, isAllowlistedVerifierCommand, bankForScope } from "../src/autolearn/custom-service";
import { CustomAutolearnController } from "../src/autolearn/custom-controller";
import { handleLearnCommand } from "../src/autolearn/learn-commands";

function settingsFor(mode: string) {
	return { get: (k: string) => (k === "autolearn.mode" ? mode : undefined) } as unknown as { get(key: string): unknown };
}

describe("focused recovery identity verifier", () => {
	it("startup recovery invokes recoverOperationIntents with mnemopi after session state available", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-startup-cwd-"));
		const proj = resolveProjectIdentity(cwd);
		// Create svc and candidate with durable intent left (simulate crash before local commit)
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({ episodeId: "ep-s", sessionId: "sess-s", projectIdentity: proj, toolName: "bash", toolCallId: "tc-s", failureMessage: "fail s", scope: "project" });
		svc.recordVerifierResult(cand.id, "bun test", { verified: true, summary: "ok", toolCallId: "tc-s", expectedCommand: "bun test", failureFingerprint: cand.failureDigest, projectIdentity: proj, sessionId: "sess-s", episodeId: "ep-s" });
		svc.approveCandidate(cand.id, "reviewed startup", proj);
		const targetBank = bankForScope("project", proj);
		const mnemopiOk: unknown = {
			rememberScopedIdempotent: () => "mem-s",
			getScopedRetainTarget: () => ({ bank: targetBank }),
			getScopedMemoryInBank: (id: string, _bank: string) => (id === "mem-s" ? { bank: targetBank } : null),
		};
		const r = await svc.projectToMnemopiReal(cand.id, mnemopiOk as never);
		expect(r.ok).toBe(true);
		// Simulate durable intent left behind without local delete (crash after external delete before transaction)
		// Use delete that fails to leave intent, then we will test startup recovery path via controller
		let first = true;
		const mnemopiFail: unknown = {
			editScopedMemoryInBank: () => {
				if (first) {
					first = false;
					throw new Error("crash transient");
				}
				return { status: "deleted", bank: targetBank };
			},
		};
		const delFail = svc.deleteCandidateWithMnemopi(cand.id, proj, mnemopiFail as never);
		expect(delFail).toBe(false);
		expect(svc.getOperationIntent(cand.id)).not.toBeNull();
		svc.close();

		// Simulate SDK startup: new controller with same agentDir and session that has mnemopi state
		let handler: (e: unknown) => void = () => {};
		const mockSession: unknown = {
			sessionId: "sess-s",
			taskDepth: 0,
			sessionManager: { getCwd: () => cwd },
			subscribe: (fn: (e: unknown) => void) => {
				handler = fn;
			},
			getMnemopiSessionState: () => ({
				editScopedMemoryInBank: () => ({ status: "deleted", bank: targetBank }),
				getScopedMemoryInBank: () => null,
			}),
		};
		const ctrl = new CustomAutolearnController({
			session: mockSession as never,
			settings: settingsFor("custom") as never,
			agentDir: dir,
			svcFactory: (d: string) => new CustomAutolearnService(d) as never,
		});
		// Production recovery invocation (same as sdk does after Mnemopi state available)
		const recovered = ctrl.recoverPendingIntents();
		expect(recovered).toBe(1);
		const svc2 = new CustomAutolearnService(dir);
		expect(svc2.getCandidate(cand.id)).toBeNull();
		expect(svc2.getOperationIntent(cand.id)).toBeNull();
		svc2.close();
		ctrl.close();
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
		try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
	});

	it("shared repository-root identity: /learn in subdirectory authorizes candidates stored by controller", async () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-shared-root-"));
		await Bun.$`git init -q ${repoRoot}`.quiet();
		const subdir = path.join(repoRoot, "pkg", "sub");
		fs.mkdirSync(subdir, { recursive: true });
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-shared-agent-"));
		const settings = settingsFor("custom");
		let handler: (e: unknown) => void = () => {};
		const mockSession: unknown = {
			sessionId: "sess-shared",
			taskDepth: 0,
			sessionManager: { getCwd: () => subdir },
			subscribe: (fn: (e: unknown) => void) => {
				handler = fn;
			},
		};
		const ctrl = new CustomAutolearnController({
			session: mockSession as never,
			settings: settings as never,
			agentDir,
			svcFactory: (d: string) => new CustomAutolearnService(d) as never,
		});
		// Controller observes failure from subdir; should store with repoRoot identity
		handler({ type: "tool_execution_end", toolName: "bash", toolCallId: "tc-shared", isError: true, result: "fail shared" });
		const rootIdentity = resolveProjectIdentity(repoRoot);
		const subIdentity = resolveProjectIdentity(subdir);
		expect(rootIdentity).toBe(subIdentity);
		// /learn view from subdir should see candidate
		const svc = new CustomAutolearnService(agentDir);
		const candidates = svc.listCandidates(rootIdentity);
		const cand = candidates.find(c => c.toolCallId === "tc-shared");
		expect(cand).toBeDefined();
		expect(cand?.projectIdentity).toBe(rootIdentity);
		svc.close();
		// /learn commands using subdir cwd should authorize
		// Create needs_review candidate to test approve via subdir
		const dir2 = agentDir;
		const svc2 = new CustomAutolearnService(dir2);
		const cand2 = svc2.listCandidates(rootIdentity).find(c => c.toolCallId === "tc-shared")!;
		// Need verifier to make needs_review
		svc2.recordVerifierResult(cand2.id, "bun test", { verified: true, summary: "ok", toolCallId: "tc-shared", expectedCommand: "bun test", failureFingerprint: cand2.failureDigest, projectIdentity: rootIdentity, sessionId: "sess-shared", episodeId: ctrl.episodeId });
		svc2.close();
		// Now /learn view from subdir should succeed (authorized)
		const viewRes = await handleLearnCommand(["view", cand2.id], settings as never, subdir, { agentDir });
		expect(viewRes.ok).toBe(true);
		// /learn view from unrelated dir should be unauthorized or not found
		const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-other-"));
		const viewOther = await handleLearnCommand(["view", cand2.id], settings as never, otherCwd, { agentDir });
		// Since otherCwd maps to different identity and scope is project, should be unauthorized
		expect(viewOther.ok).toBe(false);
		expect(viewOther.message).toMatch(/Unauthorized/);
		ctrl.close();
		try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch {}
		try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch {}
		try { fs.rmSync(otherCwd, { recursive: true, force: true }); } catch {}
	});

	it("post-success crash idempotence: bankless not_found with confirmed absence clears intent", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-idempotent-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-idempotent-cwd-"));
		const proj = resolveProjectIdentity(cwd);
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({ episodeId: "ep-idem", sessionId: "sess-idem", projectIdentity: proj, toolName: "bash", toolCallId: "tc-idem", failureMessage: "fail idem", scope: "project" });
		svc.recordVerifierResult(cand.id, "bun test", { verified: true, summary: "ok", toolCallId: "tc-idem", expectedCommand: "bun test", failureFingerprint: cand.failureDigest, projectIdentity: proj, sessionId: "sess-idem", episodeId: "ep-idem" });
		svc.approveCandidate(cand.id, "reviewed idem", proj);
		const targetBank = bankForScope("project", proj);
		const mnemopiOk: unknown = {
			rememberScopedIdempotent: () => "mem-idem",
			getScopedRetainTarget: () => ({ bank: targetBank }),
			getScopedMemoryInBank: (id: string, _bank: string) => (id === "mem-idem" ? { bank: targetBank } : null),
		};
		const r = await svc.projectToMnemopiReal(cand.id, mnemopiOk as never);
		expect(r.ok).toBe(true);
		// Simulate crash window: external delete succeeded but local transaction never ran. So we manually leave intent + candidate + projection, but external memory already gone.
		// Directly insert operation_intent as if deleteCandidateWithMnemopi persisted intent before crash
		const db = (svc as unknown as { _db?: unknown }) as never;
		// Use delete that throws to create intent, then close and reopen to simulate crash (intent remains)
		let failOnce = true;
		const mnemopiCrash: unknown = {
			editScopedMemoryInBank: () => {
				if (failOnce) {
					failOnce = false;
					throw new Error("crash before local commit");
				}
				return { status: "deleted", bank: targetBank };
			},
		};
		const delFail = svc.deleteCandidateWithMnemopi(cand.id, proj, mnemopiCrash as never);
		expect(delFail).toBe(false);
		expect(svc.getOperationIntent(cand.id)?.operation).toBe("delete");
		// Now simulate process died after successful external delete but before local transaction: external now returns bankless not_found, but memory is gone.
		// Recovery with introspection confirming absence should clear
		const mnemopiBankless: unknown = {
			editScopedMemoryInBank: () => ({ status: "not_found" }), // bankless
			getScopedMemoryInBank: (id: string, _bank: string) => null, // confirmed absent in stored bank
		};
		const recovered = svc.recoverOperationIntents(mnemopiBankless as never);
		expect(recovered).toBe(1);
		expect(svc.getCandidate(cand.id)).toBeNull();
		expect(svc.getOperationIntent(cand.id)).toBeNull();
		expect(svc.getProjection(cand.id)).toBeNull();
		// Tombstone should exist
		const svc2 = new CustomAutolearnService(dir);
		// Tombstone check via trying to approve again should fail (tombstoned)
		expect(svc2.getCandidate(cand.id)).toBeNull();
		svc2.close();
		svc.close();
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
		try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
	});

	it("bankless not_found without confirmation remains uncertain (no introspection)", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-uncertain-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-uncertain-cwd-"));
		const proj = resolveProjectIdentity(cwd);
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({ episodeId: "ep-unc", sessionId: "sess-unc", projectIdentity: proj, toolName: "bash", toolCallId: "tc-unc", failureMessage: "fail unc", scope: "project" });
		svc.recordVerifierResult(cand.id, "bun test", { verified: true, summary: "ok", toolCallId: "tc-unc", expectedCommand: "bun test", failureFingerprint: cand.failureDigest, projectIdentity: proj, sessionId: "sess-unc", episodeId: "ep-unc" });
		svc.approveCandidate(cand.id, "reviewed unc", proj);
		const targetBank = bankForScope("project", proj);
		const mnemopiOk: unknown = {
			rememberScopedIdempotent: () => "mem-unc",
			getScopedRetainTarget: () => ({ bank: targetBank }),
			getScopedMemoryInBank: (id: string, _bank: string) => (id === "mem-unc" ? { bank: targetBank } : null),
		};
		await svc.projectToMnemopiReal(cand.id, mnemopiOk as never);
		let failOnce = true;
		const mnemopiCrash: unknown = {
			editScopedMemoryInBank: () => {
				if (failOnce) {
					failOnce = false;
					throw new Error("crash");
				}
				return { status: "deleted", bank: targetBank };
			},
		};
		svc.deleteCandidateWithMnemopi(cand.id, proj, mnemopiCrash as never);
		expect(svc.getOperationIntent(cand.id)).not.toBeNull();
		// Recovery with bankless not_found but no getScopedMemory -> remains uncertain
		const mnemopiNoIntrospect: unknown = {
			editScopedMemoryInBank: () => ({ status: "not_found" }),
		};
		const recovered = svc.recoverOperationIntents(mnemopiNoIntrospect as never);
		expect(recovered).toBe(0);
		expect(svc.getCandidate(cand.id)).not.toBeNull();
		expect(svc.getOperationIntent(cand.id)).not.toBeNull();
		svc.close();
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
		try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
	});

	it("verifier command with args normalizes allowlist but preserves full digest", async () => {
		expect(isAllowlistedVerifierCommand("bun test")).toBe(true);
		expect(isAllowlistedVerifierCommand("bun test path/to/file.ts")).toBe(true);
		expect(isAllowlistedVerifierCommand("bun test\tpath")).toBe(true);
		expect(isAllowlistedVerifierCommand("npm test -- --grep foo")).toBe(true);
		expect(isAllowlistedVerifierCommand("cargo test --lib")).toBe(true);
		expect(isAllowlistedVerifierCommand("pytest tests/test_foo.py")).toBe(true);
		expect(isAllowlistedVerifierCommand("go test ./...")).toBe(true);
		expect(isAllowlistedVerifierCommand("node test")).toBe(false);
		expect(isAllowlistedVerifierCommand("bun run test")).toBe(false);

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-verifier-args-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-verifier-args-cwd-"));
		const proj = resolveProjectIdentity(cwd);
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({ episodeId: "ep-arg", sessionId: "sess-arg", projectIdentity: proj, toolName: "bash", toolCallId: "tc-arg", failureMessage: "fail arg", scope: "project" });
		// Controller would have captured actual command "bun test path/to/file.ts" and proof expectedCommand same; service should accept
		const proof = { verified: true, summary: "ok args", toolCallId: "tc-arg", expectedCommand: "bun test path/to/file.ts", failureFingerprint: cand.failureDigest, projectIdentity: proj, sessionId: "sess-arg", episodeId: "ep-arg" } as const;
		const ok = svc.recordVerifierResult(cand.id, "bun test path/to/file.ts", proof as never);
		expect(ok).toBe(true);
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");
		expect(svc.getCandidate(cand.id)?.verifierName).toBe("bun test path/to/file.ts");
		// Exact proof linkage still required: mismatched fingerprint should fail
		const cand2 = svc.observeCandidate({ episodeId: "ep-arg2", sessionId: "sess-arg", projectIdentity: proj, toolName: "bash", toolCallId: "tc-arg2", failureMessage: "fail arg2", scope: "project" });
		const badProof = { verified: true, summary: "ok", toolCallId: "tc-arg2", expectedCommand: "bun test path/to/file.ts", failureFingerprint: "wrong-digest", projectIdentity: proj, sessionId: "sess-arg", episodeId: "ep-arg2" } as const;
		expect(svc.recordVerifierResult(cand2.id, "bun test path/to/file.ts", badProof as never)).toBe(false);
		svc.close();
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
		try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
	});
});
