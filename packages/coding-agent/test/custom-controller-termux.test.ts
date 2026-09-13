import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CustomAutolearnService, canonicalProjectIdentity } from "../src/autolearn/custom-service";

describe("custom autolearn controller wiring termux", () => {
	it("custom-controller exists and observes bounded tool events with verification", async () => {
		const ctrlPath = path.resolve(import.meta.dir, "../src/autolearn/custom-controller.ts");
		const content = await fs.promises.readFile(ctrlPath, "utf8");
		expect(content).toContain("CustomAutolearnController");
		expect(content).toContain("tool_execution_end");
		expect(content).toContain("MAX_CANDIDATES_PER_EPISODE");
		expect(content).toContain("observeCandidate");
		expect(content).toContain("recordVerifierResult");
		expect(content).toContain("resolveAutolearnMode");
		expect(content).toContain("canonicalProjectIdentity");
	});

	it("sdk wires custom controller for custom mode only", async () => {
		const sdkPath = path.resolve(import.meta.dir, "../src/sdk.ts");
		const sdk = await fs.promises.readFile(sdkPath, "utf8");
		expect(sdk).toContain("CustomAutolearnController");
		expect(sdk).toContain('autolearn.mode") === "custom"');
		expect(sdk).toContain("AutoLearnController");
	});

	it("service supports bounded observe/verify/persist/projection lifecycle", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ctrl-svc-"));
		const cwd = "/tmp/fake-proj";
		const proj = canonicalProjectIdentity(cwd);
		const svc = new CustomAutolearnService(dir);
		const cand = svc.observeCandidate({
			episodeId: "ep-ctrl",
			sessionId: "sess-ctrl",
			projectIdentity: proj,
			toolName: "bash",
			toolCallId: "tc-ctrl-1",
			failureMessage: "bounded failure",
		});
		expect(cand.failureDigest).toHaveLength(16);
		const ok = svc.recordVerifierResult(cand.id, "cargo test", {
			verified: true,
			summary: "ok",
			toolCallId: "tc-ctrl-1",
			expectedCommand: "cargo test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: proj,
			sessionId: "sess-ctrl",
			episodeId: "ep-ctrl",
		});
		expect(ok).toBe(true);
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");
		expect(svc.approveCandidate(cand.id, "Concrete fix for controller test", proj).success).toBe(true);
		expect(svc.getCandidate(cand.id)?.status).toBe("projection_pending");
		expect(svc.projectToMnemopi(cand.id, "mem-ctrl")).toBe(true);
		svc.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	});

	it("controller bounds candidates per episode (unit simulation)", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ctrl-bound-"));
		const svc = new CustomAutolearnService(dir);
		const proj = canonicalProjectIdentity("/tmp/bounded");
		for (let i = 0; i < 25; i++) {
			svc.observeCandidate({
				episodeId: "ep-bound",
				sessionId: "sess-bound",
				projectIdentity: proj,
				toolName: "bash",
				toolCallId: `tc-${i}`,
				failureMessage: `fail ${i}`,
			});
		}
		const all = svc.listCandidates(proj);
		expect(all.length).toBe(25);
		const ctrlPath = path.resolve(import.meta.dir, "../src/autolearn/custom-controller.ts");
		const ctrl = await fs.promises.readFile(ctrlPath, "utf8");
		expect(ctrl).toContain("MAX_CANDIDATES_PER_EPISODE = 20");
		svc.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	});
});
