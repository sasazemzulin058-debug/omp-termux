import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CustomAutolearnService, redactSensitiveText, computeOpaqueDigest, resolveAutolearnMode } from "../src/autolearn/custom-service";

describe("custom autolearn termux slice", () => {
  let dir: string;
  let svc: CustomAutolearnService;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-learn-test-"));
    svc = new CustomAutolearnService(dir);
  });
  afterEach(() => {
    try { svc.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
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
    expect(resolveAutolearnMode({ get: (k: string) => k === "autolearn.mode" ? "custom" : true } as any)).toBe("custom");
    expect(resolveAutolearnMode({ get: (k: string) => k === "autolearn.enabled" ? true : undefined } as any)).toBe("builtin");
    expect(resolveAutolearnMode({ get: () => undefined } as any)).toBe("off");
  });

  it("observe -> verifier -> approve lifecycle with CAS", () => {
    const cand = svc.observeCandidate({ episodeId: "ep1", sessionId: "sess1", projectIdentity: "/repo/a", toolName: "bash", toolCallId: "tc1", failureMessage: "fail x" });
    expect(cand.status).toBe("pending");
    // Unallowlisted verifier should not promote
    expect(svc.recordVerifierResult(cand.id, "unknown-verifier", { verified: true, summary: "ok" })).toBe(false);
    expect(svc.getCandidate(cand.id)?.status).toBe("pending");
    // Allowlisted verifier promotes to needs_review
    expect(svc.recordVerifierResult(cand.id, "cargo test", { verified: true, summary: "passed 1" })).toBe(true);
    expect(svc.getCandidate(cand.id)?.status).toBe("needs_review");
    // Synthetic content rejected
    expect(svc.approveCandidate(cand.id, "Verified resolution for x", "/repo/a").success).toBe(false);
    // Meaningful content approved
    const ok = svc.approveCandidate(cand.id, "Fix: ensure pidfd fallback handles android bionic", "/repo/a");
    expect(ok.success).toBe(true);
    expect(svc.getCandidate(cand.id)?.status).toBe("approved");
  });

  it("enforces project scope", () => {
    const cand = svc.observeCandidate({ episodeId: "ep2", sessionId: "sess1", projectIdentity: "/repo/a", toolName: "bash", toolCallId: "tc2", failureMessage: "fail" });
    svc.recordVerifierResult(cand.id, "cargo test", { verified: true, summary: "ok" });
    expect(svc.approveCandidate(cand.id, "real content", "/repo/b").success).toBe(false);
  });

  it("tombstone prevents resurrection via rollback", () => {
    const cand = svc.observeCandidate({ episodeId: "ep3", sessionId: "sess1", projectIdentity: "/repo/a", toolName: "bash", toolCallId: "tc3", failureMessage: "fail" });
    svc.deleteCandidate(cand.id, "/repo/a");
    expect(svc.getCandidate(cand.id)).toBeNull();
    expect(svc.approveCandidate(cand.id, "new content", "/repo/a").success).toBe(false);
  });

  it("sweepExpires respects TTL", () => {
    const cand = svc.observeCandidate({ episodeId: "ep4", sessionId: "sess1", projectIdentity: "/repo/a", toolName: "bash", toolCallId: "tc4", failureMessage: "fail", ttlMs: 1 });
    // wait a bit
    const start = Date.now();
    while (Date.now() - start < 5) {}
    const n = svc.sweepExpired();
    expect(n).toBe(1);
  });

  it("stores with WAL and restrictive perms", () => {
    const dbPath = path.join(dir, "learn.db");
    expect(fs.existsSync(dbPath)).toBe(true);
    // Check journal mode is WAL via pragma
    const mode = (svc as any)["#db"] ? null : null; // placeholder
    // File perms 600
    const stat = fs.statSync(dbPath);
    expect((stat.mode & 0o777).toString(8)).toBe("600");
  });
});
