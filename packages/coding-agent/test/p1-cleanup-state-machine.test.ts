import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CustomAutolearnController } from "../src/autolearn/custom-controller";
import { CustomAutolearnService, canonicalProjectIdentity } from "../src/autolearn/custom-service";
import type { MnemopiProjectionClient } from "../src/autolearn/custom-service";
import { handleLearnCommand } from "../src/autolearn/learn-commands";
import type { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";

describe("P1 cleanup state machine", () => {
	let dir: string;
	let cwdDir: string;
	let pid: string;
	let svc: CustomAutolearnService;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "p1-cleanup-"));
		cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "p1-cleanup-cwd-"));
		pid = canonicalProjectIdentity(cwdDir);
		svc = new CustomAutolearnService(dir);
	});
	afterEach(() => {
		try {
			svc.close();
		} catch {}
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwdDir, { recursive: true, force: true });
		} catch {}
	});
	function makeProjectedCandidate(): { id: string; bank: string } {
		const cand = svc.observeCandidate({
			episodeId: "ep1",
			sessionId: "sess1",
			projectIdentity: pid,
			toolName: "bash",
			toolCallId: "tc1",
			failureMessage: "fail1",
			scope: "project",
		});
		svc.recordVerifierResult(cand.id, "bun test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc1",
			expectedCommand: "bun test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: pid,
			sessionId: "sess1",
			episodeId: "ep1",
		});
		svc.approveCandidate(cand.id, "reviewed fix", pid);
		svc.projectToMnemopi(cand.id, "mem1");
		const proj = svc.getProjection(cand.id);
		const actualBank = proj?.bank ?? "default";
		return { id: cand.id, bank: actualBank };
	}

	it("working forget deleted with correct bank confirms without calling invalidate", () => {
		const { id, bank } = makeProjectedCandidate();
		const calls: string[] = [];
		const mock = {
			getScopedMemoryInBank: (mid: string, b: string) => (mid && b === bank ? { bank } : null),
			editScopedMemoryInBank: (op: string, _mid: string, _bank: string) => {
				calls.push(op);
				if (op === "forget") return { status: "deleted", bank, store: "working" };
				// should not be called; if called return bankless to make failure visible
				return { status: "not_found" };
			},
		} as unknown as { editScopedMemoryInBank: (op: string, id: string, _bank: string) => unknown };
		const ok = svc.deleteCandidateWithMnemopi(id, pid, mock);
		expect(ok).toBe(true);
		expect(calls).toEqual(["forget"]);
		expect(svc.getProjection(id)).toBeNull();
		expect(svc.getCandidate(id)).toBeNull();
	});

	it("episodic not_found -> invalidate success", () => {
		const { id, bank } = makeProjectedCandidate();
		const calls: string[] = [];
		const mock = {
			getScopedMemoryInBank: (mid: string, b: string) => (mid && b === bank ? { bank } : null),
			editScopedMemoryInBank: (op: string, _mid: string, _bank: string) => {
				calls.push(op);
				if (op === "forget") return { status: "not_found", bank, store: "episodic" };
				if (op === "invalidate") return { status: "invalidated", bank, store: "episodic" };
				return { status: "not_found" };
			},
		} as unknown as { editScopedMemoryInBank: (op: string, id: string, _bank: string) => unknown };
		const ok = svc.deleteCandidateWithMnemopi(id, pid, mock);
		expect(ok).toBe(true);
		expect(calls).toEqual(["forget", "invalidate"]);
		expect(svc.getProjection(id)).toBeNull();
	});

	it("bankless not_found after forget fails closed and preserves projection", () => {
		const { id, bank } = makeProjectedCandidate();
		const beforeProj = svc.getProjection(id);
		expect(beforeProj).not.toBeNull();
		const mock: MnemopiProjectionClient = {
			getScopedMemoryInBank: (mid: string, b: string) => (mid && b === bank ? { bank } : null),
			editScopedMemoryInBank: () => ({ status: "not_found" }),
		};
		const ok = svc.deleteCandidateWithMnemopi(id, pid, mock);
		expect(ok).toBe(false);
		expect(svc.getProjection(id)).not.toBeNull();
		expect(svc.getCandidate(id)?.status).toBe("needs_review");
	});

	it("bankless invalidate after not_found fails closed", () => {
		const { id, bank } = makeProjectedCandidate();
		const mock = {
			getScopedMemoryInBank: (mid: string, b: string) => (mid && b === bank ? { bank } : null),
			editScopedMemoryInBank: (op: string, _id: string, _bank: string) =>
				op === "forget" ? { status: "not_found", bank, store: "episodic" } : { status: "not_found" },
		};
		const ok = svc.rollbackCandidateWithMnemopi(id, pid, mock);
		expect(ok).toBe(false);
		expect(svc.getProjection(id)).not.toBeNull();
	});

	it("forget bank mismatch fails closed even on deleted", () => {
		const { id, bank } = makeProjectedCandidate();
		const mock = {
			getScopedMemoryInBank: (mid: string, b: string) => (mid && b === bank ? { bank } : null),
			editScopedMemoryInBank: (op: string, _id: string, _bank: string) =>
				op === "forget" ? { status: "deleted", bank: "other-bank", store: "working" } : { status: "not_found" },
		};
		const ok = svc.deleteCandidateWithMnemopi(id, pid, mock);
		expect(ok).toBe(false);
		expect(svc.getProjection(id)).not.toBeNull();
	});

	it("forget not_editable fails without calling invalidate", () => {
		const { id, bank } = makeProjectedCandidate();
		const calls: string[] = [];
		const mock = {
			getScopedMemoryInBank: (mid: string, b: string) => (mid && b === bank ? { bank } : null),
			editScopedMemoryInBank: (op: string, _mid: string, _bank: string) => {
				calls.push(op);
				if (op === "forget") return { status: "not_editable", bank, store: "fact" };
				return { status: "invalidated", bank };
			},
		} as unknown as { editScopedMemoryInBank: (op: string, id: string, _bank: string) => unknown };
		const ok = svc.deleteCandidateWithMnemopi(id, pid, mock);
		expect(ok).toBe(false);
		expect(calls).toEqual(["forget"]);
		expect(svc.getProjection(id)).not.toBeNull();
	});

	it("bankless forget does not fallback to banked invalidate - mixed response regression", () => {
		const { id, bank } = makeProjectedCandidate();
		const calls: string[] = [];
		const mock = {
			getScopedMemoryInBank: (mid: string, b: string) => (mid && b === bank ? { bank } : null),
			editScopedMemoryInBank: (op: string, _mid: string, _bank: string) => {
				calls.push(op);
				if (op === "forget") return { status: "not_found" };
				if (op === "invalidate") return { status: "invalidated", bank, store: "episodic" };
				return { status: "not_found" };
			},
		} as unknown as { editScopedMemoryInBank: (op: string, id: string, _bank: string) => unknown };
		const ok = svc.deleteCandidateWithMnemopi(id, pid, mock);
		expect(ok).toBe(false);
		expect(calls).toEqual(["forget"]);
		expect(svc.getProjection(id)).not.toBeNull();
		expect(svc.getCandidate(id)?.status).toBe("needs_review");
		expect(svc.getCandidate(id)).not.toBeNull();
		// ensure invalidate was never invoked even though it would have succeeded banked
		expect(calls.includes("invalidate")).toBe(false);
	});
});

describe("controller DB scope isolated agentDir", () => {
	it("controller writes to injected agentDir, /learn reads same DB, global untouched", async () => {
		const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "p1-ctrl-isolated-"));
		const globalDir = path.join(os.tmpdir(), "p1-ctrl-global-" + Date.now());
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p1-ctrl-cwd-"));
		const globalDbPath = path.join(globalDir, "learn.db");
		let capturedAgentDir: string | undefined;
		const svcFactory = (dir: string) => {
			capturedAgentDir = dir;
			return new CustomAutolearnService(dir);
		};
		const fakeSession = {
			sessionId: "sess-iso",
			cwd,
			taskDepth: 0,
			subscribe: (cb: (e: unknown) => void) => {
				(fakeSession as unknown as { _cb: (e: unknown) => void })._cb = cb;
				return () => {};
			},
			emit: (e: unknown) => {
				const holder = fakeSession as unknown as { _cb?: (e: unknown) => void };
				if (holder._cb) holder._cb(e);
			},
		} as unknown as AgentSession;
		const settings = { get: (k: string) => (k === "autolearn.mode" ? "custom" : undefined) } as unknown as Settings;
		const ctrl = new CustomAutolearnController({ session: fakeSession, settings, agentDir: isolated, svcFactory });
		(fakeSession as unknown as { emit: (e: unknown) => void }).emit({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "tc-iso-1",
			isError: true,
			result: "failure iso",
		});
		expect(capturedAgentDir).toBe(isolated);
		expect(fs.existsSync(path.join(isolated, "learn.db"))).toBe(true);
		expect(fs.existsSync(globalDbPath)).toBe(false);
		const res = await handleLearnCommand(["status"], settings as unknown as { get(key: string): unknown }, cwd, {
			agentDir: isolated,
			mnemopi: null,
		});
		expect(res.ok).toBe(true);
		const svc2 = new CustomAutolearnService(isolated);
		const cands = svc2.listCandidates(canonicalProjectIdentity(cwd));
		expect(cands.length).toBeGreaterThan(0);
		svc2.close();
		ctrl.close();
		try {
			fs.rmSync(isolated, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
		} catch {}
		try {
			fs.rmSync(globalDir, { recursive: true, force: true });
		} catch {}
	});

	it("sdk wires agentDir into CustomAutolearnController", async () => {
		const sdkPath = path.resolve(import.meta.dir, "../src/sdk.ts");
		const txt = await fs.promises.readFile(sdkPath, "utf8");
		expect(txt).toContain("new CustomAutolearnController({ session, settings, agentDir })");
	});
});
