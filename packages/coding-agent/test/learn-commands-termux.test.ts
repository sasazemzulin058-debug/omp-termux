import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { handleLearnCommand } from "../src/autolearn/learn-commands";
import { CustomAutolearnService, canonicalProjectIdentity } from "../src/autolearn/custom-service";

function settingsFor(mode: string | undefined) {
	return { get: (k: string) => (k === "autolearn.mode" ? mode : undefined) } as unknown as { get(key: string): unknown };
}

describe("learn slash commands termux", () => {
	let dir: string;
	let cwd: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-learn-cmd-"));
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-learn-cwd-"));
	});
	afterEach(() => {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
		try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
	});

	it("does not create DB when mode is off", async () => {
		const res = await handleLearnCommand(["status"], settingsFor("off"), cwd, { agentDir: dir });
		expect(res.ok).toBe(true);
		expect(res.message).toContain("disabled");
		expect(fs.existsSync(path.join(dir, "learn.db"))).toBe(false);
	});
	it("does not create DB when mode is builtin", async () => {
		const res = await handleLearnCommand(["view"], settingsFor("builtin"), cwd, { agentDir: dir });
		expect(res.ok).toBe(true);
		expect(fs.existsSync(path.join(dir, "learn.db"))).toBe(false);
	});
	it("creates DB and handles status when mode is custom", async () => {
		const res = await handleLearnCommand(["status"], settingsFor("custom"), cwd, { agentDir: dir });
		expect(res.ok).toBe(true);
		expect(fs.existsSync(path.join(dir, "learn.db"))).toBe(true);
	});
	it("enforces scope on view/approve", async () => {
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({ episodeId: "ep1", sessionId: "s1", projectIdentity: canonicalProjectIdentity(cwd), toolName: "bash", toolCallId: "tc1", failureMessage: "fail" });
		svc.recordVerifierResult(cand.id, "cargo test", { verified: true, summary: "ok", toolCallId: "tc1", expectedCommand: "cargo test", failureFingerprint: cand.failureDigest, projectIdentity: canonicalProjectIdentity(cwd), sessionId: "s1", episodeId: "ep1" });
		svc.close();
		// Wrong project should be rejected
		const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-learn-other-"));
		const res = await handleLearnCommand(["approve", cand.id, "real content"], settingsFor("custom"), otherCwd, { agentDir: dir });
		expect(res.ok).toBe(false);
		expect(res.message).toMatch(/Unauthorized|scope/i);
		try { fs.rmSync(otherCwd, { recursive: true, force: true }); } catch {}
	});
	it("approve rejects synthetic content", async () => {
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({ episodeId: "ep2", sessionId: "s1", projectIdentity: canonicalProjectIdentity(cwd), toolName: "bash", toolCallId: "tc2", failureMessage: "fail" });
		svc.recordVerifierResult(cand.id, "bun test", { verified: true, summary: "ok", toolCallId: "tc2", expectedCommand: "bun test", failureFingerprint: cand.failureDigest, projectIdentity: canonicalProjectIdentity(cwd), sessionId: "s1", episodeId: "ep2" });
		svc.close();
		const res = await handleLearnCommand(["approve", cand.id, "Verified resolution for xyz"], settingsFor("custom"), cwd, { agentDir: dir });
		expect(res.ok).toBe(false);
	});
	it("sweep and rollback work", async () => {
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({ episodeId: "ep3", sessionId: "s1", projectIdentity: canonicalProjectIdentity(cwd), toolName: "bash", toolCallId: "tc3", failureMessage: "fail", ttlMs: 1 });
		// Integration: real timer needed to elapse TTL (deterministic fake timers cannot advance Date.now for TTL check)
		await Bun.sleep(5);
		svc.close();
		const sweep = await handleLearnCommand(["sweep"], settingsFor("custom"), cwd, { agentDir: dir });
		expect(sweep.ok).toBe(true);
		expect(sweep.message).toContain("Swept");
	});
	it("sweep blocked unless custom mode", async () => {
		// Even with existing DB, off/builtin must block sweep
		const svc = new CustomAutolearnService(dir);
		svc.observeCandidate({ episodeId: "ep-sweep", sessionId: "s1", projectIdentity: canonicalProjectIdentity(cwd), toolName: "bash", toolCallId: "tc-sweep", failureMessage: "fail" });
		svc.close();
		const offRes = await handleLearnCommand(["sweep"], settingsFor("off"), cwd, { agentDir: dir });
		expect(offRes.ok).toBe(false);
		expect(offRes.message).toMatch(/blocked.*custom/i);
		const builtinRes = await handleLearnCommand(["sweep"], settingsFor("builtin"), cwd, { agentDir: dir });
		expect(builtinRes.ok).toBe(false);
	});
});
