import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CustomAutolearnService,
	computeOpaqueDigest,
	redactSensitiveText,
	resolveAutolearnMode,
} from "../src/autolearn/custom-service";

describe("custom autolearn termux slice", () => {
	let dir: string;
	let svc: CustomAutolearnService;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-learn-test-"));
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

	it("redacts secrets before persistence", () => {
		const red = redactSensitiveText("token abc ghp_1234567890123456789012345678901234567890 Bearer xyz");
		expect(red).not.toContain("ghp_");
		expect(red).toContain("[REDACTED]");
	});

	it("computes opaque digest", () => {
		expect(computeOpaqueDigest("hello")).toHaveLength(16);
	});

	it("resolves mode with explicit mode winning", () => {
		expect(resolveAutolearnMode({ get: (k: string) => (k === "autolearn.mode" ? "custom" : true) } as any)).toBe(
			"custom",
		);
		expect(resolveAutolearnMode({ get: (k: string) => (k === "autolearn.enabled" ? true : undefined) } as any)).toBe(
			"builtin",
		);
		expect(resolveAutolearnMode({ get: () => undefined } as any)).toBe("off");
	});

	it("observe -> verifier -> approve lifecycle with CAS", () => {
		const cand = svc.observeCandidate({
			episodeId: "ep1",
			sessionId: "sess1",
			projectIdentity: "/repo/a",
			toolName: "bash",
			toolCallId: "tc1",
			failureMessage: "fail x",
		});
		expect(cand.status).toBe("pending");
		const strict = (summary: string) => ({
			verified: true as const,
			summary,
			toolCallId: "tc1",
			expectedCommand: "cargo test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: "/repo/a",
			sessionId: "sess1",
			episodeId: "ep1",
		});
		// Unallowlisted verifier should not promote
		expect(
			svc.recordVerifierResult(cand.id, "unknown-verifier", {
				verified: true,
				summary: "ok",
				toolCallId: "tc1",
				expectedCommand: "unknown-verifier",
				failureFingerprint: cand.failureDigest,
				projectIdentity: "/repo/a",
				sessionId: "sess1",
				episodeId: "ep1",
			} as any),
		).toBe(false);
		expect(svc.getCandidate(cand.id)?.status).toBe("pending");
		// Mismatched toolCallId must not promote
		expect(svc.recordVerifierResult(cand.id, "cargo test", { ...strict("passed 1"), toolCallId: "wrong" })).toBe(
			false,
		);
		expect(svc.getCandidate(cand.id)?.status).toBe("pending");
		// Mismatched fingerprint must not promote
		expect(
			svc.recordVerifierResult(cand.id, "cargo test", { ...strict("passed 1"), failureFingerprint: "bad" }),
		).toBe(false);
		// Allowlisted verifier with exact linkage promotes to needs_review
		expect(svc.recordVerifierResult(cand.id, "cargo test", strict("passed 1"))).toBe(true);
		expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");
		// Synthetic content rejected
		expect(svc.approveCandidate(cand.id, "Verified resolution for x", "/repo/a").success).toBe(false);
		// Meaningful content approved
		const ok = svc.approveCandidate(cand.id, "Fix: ensure pidfd fallback handles android bionic", "/repo/a");
		expect(ok.success).toBe(true);
		expect(svc.getCandidate(cand.id)?.status).toBe("approved");
	});

	it("enforces project scope", () => {
		const cand = svc.observeCandidate({
			episodeId: "ep2",
			sessionId: "sess1",
			projectIdentity: "/repo/a",
			toolName: "bash",
			toolCallId: "tc2",
			failureMessage: "fail",
		});
		const strict = {
			verified: true as const,
			summary: "ok",
			toolCallId: "tc2",
			expectedCommand: "cargo test",
			failureFingerprint: cand.failureDigest,
			projectIdentity: "/repo/a",
			sessionId: "sess1",
			episodeId: "ep2",
		};
		svc.recordVerifierResult(cand.id, "cargo test", strict);
		expect(svc.approveCandidate(cand.id, "real content", "/repo/b").success).toBe(false);
	});

	it("tombstone prevents resurrection via rollback", () => {
		const cand = svc.observeCandidate({
			episodeId: "ep3",
			sessionId: "sess1",
			projectIdentity: "/repo/a",
			toolName: "bash",
			toolCallId: "tc3",
			failureMessage: "fail",
		});
		svc.deleteCandidate(cand.id, "/repo/a");
		expect(svc.getCandidate(cand.id)).toBeNull();
		expect(svc.approveCandidate(cand.id, "new content", "/repo/a").success).toBe(false);
	});

	it("sweepExpires respects TTL", () => {
		svc.observeCandidate({
			episodeId: "ep4",
			sessionId: "sess1",
			projectIdentity: "/repo/a",
			toolName: "bash",
			toolCallId: "tc4",
			failureMessage: "fail",
			ttlMs: 1,
		});
		// wait a bit
		const start = Date.now();
		while (Date.now() - start < 5) {}
		const n = svc.sweepExpired();
		expect(n).toBe(1);
	});

	it("stores with WAL and restrictive perms", () => {
		const dbPath = path.join(dir, "learn.db");
		expect(fs.existsSync(dbPath)).toBe(true);
		const stat = fs.statSync(dbPath);
		expect((stat.mode & 0o777).toString(8)).toBe("600");
	});
});
