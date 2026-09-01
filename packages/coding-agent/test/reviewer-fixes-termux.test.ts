import { describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CustomAutolearnService, canonicalProjectIdentity } from "../src/autolearn/custom-service";
import { handleLearnCommand } from "../src/autolearn/learn-commands";

mock.module("@oh-my-pi/pi-utils", () => ({
	logger: {
		warn: () => {},
		time: (_: string, fn?: unknown, ...args: unknown[]) => {
			if (typeof fn === "function") return (fn as (...a: unknown[]) => unknown)(...args);
			return undefined;
		},
		debug: () => {},
		info: () => {},
		error: () => {},
	},
	getAgentDir: () => "/tmp",
	getProjectDir: () => "/tmp",
	Snowflake: class {},
	postmortem: { register: () => {} },
	prompt: { render: () => "" },
}));

function settingsFor(mode: string | undefined) {
	return { get: (k: string) => (k === "autolearn.mode" ? mode : undefined) } as unknown as {
		get(key: string): unknown;
	};
}

describe("reviewer fixes termux", () => {
	it("sdk restores createAutoresearchExtension import and wires learn extension", async () => {
		const sdk = await fs.promises.readFile(path.resolve(import.meta.dir, "../src/sdk.ts"), "utf8");
		expect(sdk).toContain("createAutoresearchExtension");
		expect(sdk).toContain('from "./autoresearch"');
		expect(sdk).toContain("createLearnExtension");
		expect(sdk).toContain('from "./autolearn/learn-commands"');
		expect(sdk).toContain("inlineExtensions.push(createAutoresearchExtension)");
		expect(sdk).toContain("inlineExtensions.push(createLearnExtension)");
	});

	it("learn-commands registers via real command API", async () => {
		const src = await fs.promises.readFile(
			path.resolve(import.meta.dir, "../src/autolearn/learn-commands.ts"),
			"utf8",
		);
		expect(src).toContain("createLearnExtension");
		expect(src).toContain('api.registerCommand("learn"');
		expect(src).not.toContain("prompt-only");
	});

	it("custom-controller requires structured proof and does not fabricate verified from exit success", async () => {
		const src = await fs.promises.readFile(
			path.resolve(import.meta.dir, "../src/autolearn/custom-controller.ts"),
			"utf8",
		);
		expect(src).toContain("extractStructuredVerifierProof");
		expect(src).toContain("verified !== true");
		// must not contain the old fabrication loop that backfills candidate linkage with verified:true
		expect(src).not.toContain("for (const cand of pending.slice(0, 5))");
		expect(src).not.toContain("verified: true as const");
	});

	it("proof rejection: controller ignores output keyword and exit success without structured proof", async () => {
		const { CustomAutolearnController } = await import("../src/autolearn/custom-controller");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-proof-reject-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-proof-cwd-"));
		const proj = canonicalProjectIdentity(cwd);
		const settings = settingsFor("custom");
		// Mock session
		let handler: (e: unknown) => void = () => {};
		const mockSession: unknown = {
			sessionId: "sess-proof",
			cwd,
			taskDepth: 0,
			subscribe: (fn: (e: unknown) => void) => {
				handler = fn;
			},
		};
		const svcFactory = (_d: string) => new CustomAutolearnService(dir);
		const ctrl = new CustomAutolearnController({
			session: mockSession as never,
			settings: settings as never,
			agentDir: dir,
			svcFactory: svcFactory as never,
		});
		const svc = new CustomAutolearnService(dir);
		// Observe a candidate via isError true
		handler({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "tc-proof-1",
			isError: true,
			result: "failure x",
		});
		// Wait for observe to persist
		await Bun.sleep(10);
		const candidates = svc.listCandidates(proj).filter(c => c.toolCallId === "tc-proof-1");
		expect(candidates.length).toBe(1);
		const cand = candidates[0];
		expect(cand.status).toBe("pending");
		// Now emit successful verifier with only output keyword, no structured proof -> must stay pending
		handler({
			type: "tool_execution_end",
			toolName: "cargo test",
			toolCallId: "verifier-1",
			isError: false,
			result: "pass",
		});
		handler({
			type: "tool_execution_end",
			toolName: "cargo test",
			toolCallId: "verifier-2",
			isError: false,
			result: "ok success 0 diagnostics",
		});
		handler({
			type: "tool_execution_end",
			toolName: "cargo test",
			toolCallId: "verifier-3",
			isError: false,
			result: { content: "cargo test passed" },
		});
		await Bun.sleep(10);
		expect(svc.getCandidate(cand.id)?.status).toBe("pending");
		// Now emit structured proof with exact linkage -> should promote to needs_review
		const proof = {
			verified: true,
			summary: "cargo test passed 3 tests",
			toolCallId: cand.toolCallId,
			expectedCommand: "cargo test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-proof",
			episodeId: (ctrl as unknown as { episodeId: string }).episodeId,
		};
		handler({
			type: "tool_execution_end",
			toolName: "cargo test",
			toolCallId: "verifier-structured",
			isError: false,
			result: proof,
		});
		await Bun.sleep(10);
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");
		svc.close();
		ctrl.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {}
	});

	it("exact linkage: mismatched fingerprint/project/session/episode must not promote", async () => {
		const { CustomAutolearnController } = await import("../src/autolearn/custom-controller");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-exact-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-exact-cwd-"));
		const proj = canonicalProjectIdentity(cwd);
		const otherProj = canonicalProjectIdentity("/tmp/other-proj");
		const settings = settingsFor("custom");
		let handler: (e: unknown) => void = () => {};
		const mockSession: unknown = {
			sessionId: "sess-exact",
			cwd,
			taskDepth: 0,
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
		handler({ type: "tool_execution_end", toolName: "bash", toolCallId: "tc-exact", isError: true, result: "fail" });
		await Bun.sleep(10);
		const cand = svc.listCandidates(proj).find(c => c.toolCallId === "tc-exact")!;
		expect(cand).toBeDefined();
		const epi = (ctrl as unknown as { episodeId: string }).episodeId;
		const baseProof = {
			verified: true,
			summary: "ok",
			toolCallId: cand.toolCallId,
			expectedCommand: "cargo test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-exact",
			episodeId: epi,
		};
		// Mismatched fingerprint
		handler({
			type: "tool_execution_end",
			toolName: "cargo test",
			toolCallId: "v1",
			isError: false,
			result: { ...baseProof, failureFingerprint: "badbadbadbadbad1" },
		});
		await Bun.sleep(10);
		expect(svc.getCandidate(cand.id)?.status).toBe("pending");
		// Mismatched toolCallId
		handler({
			type: "tool_execution_end",
			toolName: "cargo test",
			toolCallId: "v2",
			isError: false,
			result: { ...baseProof, toolCallId: "other" },
		});
		await Bun.sleep(10);
		expect(svc.getCandidate(cand.id)?.status).toBe("pending");
		// Mismatched project
		handler({
			type: "tool_execution_end",
			toolName: "cargo test",
			toolCallId: "v3",
			isError: false,
			result: { ...baseProof, projectIdentity: otherProj },
		});
		await Bun.sleep(10);
		expect(svc.getCandidate(cand.id)?.status).toBe("pending");
		// Correct should promote
		handler({
			type: "tool_execution_end",
			toolName: "cargo test",
			toolCallId: "v4",
			isError: false,
			result: baseProof,
		});
		await Bun.sleep(10);
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");
		svc.close();
		ctrl.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {}
	});

	it("approve projects exact redacted reviewed content via scoped Mnemopi", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-approve-proj-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-approve-cwd-"));
		const proj = canonicalProjectIdentity(cwd);
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({
			episodeId: "ep-approve",
			sessionId: "s-approve",
			projectIdentity: proj,
			toolName: "bash",
			toolCallId: "tc-approve",
			failureMessage: "fail",
		});
		svc.recordVerifierResult(cand.id, "cargo test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-approve",
			expectedCommand: "cargo test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "s-approve",
			episodeId: "ep-approve",
		});
		svc.close();
		const remembered: { content: string; opts: unknown }[] = [];
		const mockMnemopi = {
			rememberScopedIdempotent: (content: string, opts: { scope: string; source: string; idempotencyKey: string }) => {
				remembered.push({ content, opts });
				return "mem_approve_1";
			},
			editScopedMemoryInBank: () => ({ status: "deleted" }),
		};
		const res = await handleLearnCommand(
			[
				"approve",
				cand.id,
				"Fix handles android bionic pidfd fallback with token ghp_1234567890123456789012345678901234567890",
			],
			settingsFor("custom"),
			cwd,
			{ agentDir: dir, mnemopi: mockMnemopi as unknown as never },
		);
		expect(res.ok).toBe(true);
		expect(remembered.length).toBe(1);
		// Must be redacted, not raw secret
		expect(remembered[0].content).not.toContain("ghp_");
		expect(remembered[0].content).toContain("[REDACTED]");
		// Projection must be stored with correct bank derived from canonical identity
		const svc2 = new CustomAutolearnService(dir);
		const projRef = svc2.getProjection(cand.id);
		expect(projRef).not.toBeNull();
		expect(projRef?.mnemopiId).toBe("mem_approve_1");
		expect(projRef?.bank.length).toBeGreaterThan(0);
		svc2.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {}
	});

	it("delete/rollback preserve projection on uncertain backend failure", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-preserve-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-preserve-cwd-"));
		const proj = canonicalProjectIdentity(cwd);
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({
			episodeId: "ep-pres",
			sessionId: "s-pres",
			projectIdentity: proj,
			toolName: "bash",
			toolCallId: "tc-pres",
			failureMessage: "fail",
		});
		svc.recordVerifierResult(cand.id, "cargo test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-pres",
			expectedCommand: "cargo test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "s-pres",
			episodeId: "ep-pres",
		});
		svc.approveCandidate(cand.id, "Real fix for preserve test", proj);
		svc.projectToMnemopi(cand.id, "mem_pres");
		svc.close();
		const failingMnemopi = {
			rememberScopedIdempotent: () => "x" as string | undefined,
			editScopedMemoryInBank: () => {
				throw new Error("backend down");
			},
		};
		const delRes = await handleLearnCommand(["delete", cand.id], settingsFor("custom"), cwd, {
			agentDir: dir,
			mnemopi: failingMnemopi as unknown as never,
		});
		expect(delRes.ok).toBe(false);
		expect(delRes.message).toMatch(/preserved|uncertain/i);
		const svc2 = new CustomAutolearnService(dir);
		expect(svc2.getCandidate(cand.id)?.status).toBe("needs_review");
		expect(svc2.getProjection(cand.id)).not.toBeNull();
		// Now rollback with failing backend also preserves
		const rollRes = await handleLearnCommand(["rollback", cand.id], settingsFor("custom"), cwd, {
			agentDir: dir,
			mnemopi: failingMnemopi as unknown as never,
		});
		expect(rollRes.ok).toBe(false);
		expect(svc2.getProjection(cand.id)).not.toBeNull();
		svc2.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {}
	});

	it("delete without mnemopi for projected candidate is blocked and preserves", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-del-block-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-del-block-cwd-"));
		const proj = canonicalProjectIdentity(cwd);
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({
			episodeId: "ep-del",
			sessionId: "s-del",
			projectIdentity: proj,
			toolName: "bash",
			toolCallId: "tc-del",
			failureMessage: "fail",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-del",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "s-del",
			episodeId: "ep-del",
		});
		svc.approveCandidate(cand.id, "Content", proj);
		svc.projectToMnemopi(cand.id, "mem_del");
		svc.close();
		const res = await handleLearnCommand(["delete", cand.id], settingsFor("custom"), cwd, { agentDir: dir });
		expect(res.ok).toBe(false);
		expect(res.message).toMatch(/mnemopi/i);
		const svc2 = new CustomAutolearnService(dir);
		expect(svc2.getProjection(cand.id)).not.toBeNull();
		svc2.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {}
	});
});
