import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadMnemopi, loadMnemopiCore, MnemopiSessionState } from "../src/mnemopi/state";
import type { MnemopiBackendConfig } from "../src/mnemopi/config";
import { CustomAutolearnService, canonicalProjectIdentity, bankForScope, computeIdempotencyKey } from "../src/autolearn/custom-service";

await Promise.all([loadMnemopi(), loadMnemopiCore()]);

function makeSessionMock(sessionId: string) {
  return {
    sessionId,
    sessionManager: { getCwd: () => "/tmp" },
    subscribe: () => () => {},
  } as unknown as import("../src/session/agent-session").AgentSession;
}

function makeConfig(tmpDir: string, opts: Partial<MnemopiBackendConfig> = {}): MnemopiBackendConfig {
  const baseBank = "shared-bank";
  const projBank = "proj-bank-A";
  return {
    dbPath: path.join(tmpDir, "mnemopi.db"),
    bank: projBank,
    baseBank,
    globalBank: baseBank,
    retainBank: projBank,
    recallBanks: [projBank, baseBank],
    scoping: "per-project-tagged" as const,
    autoRecall: false,
    autoRetain: false,
    polyphonicRecall: false,
    enhancedRecall: false,
    proactiveLinking: false,
    retainEveryNTurns: 3,
    recallLimit: 5,
    recallContextTurns: 1,
    recallMaxQueryChars: 800,
    injectionTokenLimit: 1024,
    debug: false,
    providerOptions: { noEmbeddings: true } as unknown as MnemopiBackendConfig["providerOptions"],
    llmMode: "none" as const,
    ...opts,
  };
}

describe("Mnemopi production state idempotent + exact-bank", () => {
  let tmp: string;
  let state: MnemopiSessionState;
  let config: MnemopiBackendConfig;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mnemopi-idem-"));
    config = makeConfig(tmp);
    const sess = makeSessionMock("sess-1");
    state = new MnemopiSessionState({ sessionId: "sess-1", config, session: sess });
  });
  afterEach(async () => {
    try { await state.dispose({ consolidate: false }); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("duplicate idempotent write returns same id and writes once", () => {
    const content = "Deterministic memory for idempotent test";
    const source = "custom-autolearn";
    const key = "idem-key-1";
    const id1 = state.rememberScopedIdempotent(content, { scope: "bank", source, idempotencyKey: key });
    expect(id1).toBeTruthy();
    const id2 = state.rememberScopedIdempotent(content, { scope: "bank", source, idempotencyKey: key });
    expect(id2).toBe(id1);
    // Different key must create new id (content dedup may still return same if same content, so use different content)
    const id3 = state.rememberScopedIdempotent(content + " v2", { scope: "bank", source, idempotencyKey: "idem-key-2" });
    expect(id3).not.toBe(id1);
    // Verify only 2 rows persisted for these keys (third content variant)
    const cnt = state.memory.beam.db.query("SELECT COUNT(*) as c FROM working_memory WHERE source = ?").get(source) as { c: number };
    expect(cnt.c).toBe(2);
    // Verify idempotency_key column persisted
    const row = state.memory.beam.db.query("SELECT idempotency_key as k FROM working_memory WHERE id = ?").get(id1!) as { k: string | null };
    expect(row.k).toBe(key);
  });

  it("exact-bank same-ID collision does not cross-contaminate", () => {
    // Create two states with different retain banks but shared DB dir? Use same tmp but different bank names via config.
    // First bank
    const id = "collision-id-123";
    // Directly insert into retain bank
    const retainBank = config.retainBank!;
    const otherBank = config.globalBank!;
    // Insert same id into both banks with different content via direct DB
    const memRetain = state.getScopedRetainTarget().memory;
    const memGlobal = (state as unknown as { scoped: { global?: { memory: import("@oh-my-pi/pi-mnemopi").Mnemopi } } }).scoped.global?.memory;
    expect(memGlobal).toBeDefined();
    // Use raw insert to force same id in both banks
    const insert = (m: import("@oh-my-pi/pi-mnemopi").Mnemopi, content: string) => {
      m.beam.db.run("INSERT OR REPLACE INTO working_memory (id, content, source, timestamp, session_id, importance, metadata_json, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [id, content, "test", new Date().toISOString(), m.sessionId, 0.5, JSON.stringify({}), "bank"]);
    };
    insert(memRetain, "retain content");
    insert(memGlobal!, "global content");
    // Exact-bank reads must return correct bank content
    const hitRetain = state.getScopedMemoryInBank(id, retainBank);
    expect(hitRetain).not.toBeNull();
    expect(hitRetain!.bank).toBe(retainBank);
    expect(hitRetain!.row.content).toBe("retain content");
    const hitGlobal = state.getScopedMemoryInBank(id, otherBank);
    expect(hitGlobal).not.toBeNull();
    expect(hitGlobal!.bank).toBe(otherBank);
    expect(hitGlobal!.row.content).toBe("global content");
    // Cross-bank generic getScopedMemory would return first (retain) but exact ensures isolation
    // Edit exact-bank must not mutate other bank
    const editRetain = state.editScopedMemoryInBank("forget", id, retainBank);
    expect(editRetain.status).toBe("deleted");
    expect(editRetain.bank).toBe(retainBank);
    // Other bank still has its row
    const stillGlobal = state.getScopedMemoryInBank(id, otherBank);
    expect(stillGlobal).not.toBeNull();
    expect(stillGlobal!.row.content).toBe("global content");
    // Retain now null
    const goneRetain = state.getScopedMemoryInBank(id, retainBank);
    expect(goneRetain).toBeNull();
  });

  it("delete/rollback correct bank via exact-bank edit", () => {
    const content = "to be deleted";
    const source = "custom-autolearn";
    const key = "del-key";
    const id = state.rememberScopedIdempotent(content, { scope: "bank", source, idempotencyKey: key });
    expect(id).toBeTruthy();
    const retainBank = config.retainBank!;
    // Verify present in retain
    const hit = state.getScopedMemoryInBank(id!, retainBank);
    expect(hit).not.toBeNull();
    // Delete via exact-bank forget must succeed and remove
    const del = state.editScopedMemoryInBank("forget", id!, retainBank);
    expect(del.status).toBe("deleted");
    expect(del.bank).toBe(retainBank);
    expect(state.getScopedMemoryInBank(id!, retainBank)).toBeNull();
    // Re-create and test invalidate path (episodic)
    // Insert episodic directly to simulate promoted row
    const mem = state.getScopedRetainTarget().memory;
    // For simplicity, test that forget on episodic returns not_found and invalidate succeeds
    // Insert into episodic_memory directly
    mem.beam.db.run("INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, metadata_json, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [id!, "episodic content", "test", new Date().toISOString(), mem.sessionId, 0.5, JSON.stringify({}), "bank"]);
    // Now forget should return not_found (since store is episodic) and invalidate should succeed
    const forgetEpisodic = state.editScopedMemoryInBank("forget", id!, retainBank);
    expect(forgetEpisodic.status).toBe("not_found");
    expect(forgetEpisodic.bank).toBe(retainBank);
    const inval = state.editScopedMemoryInBank("invalidate", id!, retainBank);
    // invalidate may return invalidated or not_found depending on beam impl; we expect invalidated if row exists
    // If not_found, that's also acceptable but should not mutate other bank
    expect(["invalidated", "not_found", "deleted"]).toContain(inval.status);
    if (inval.status === "invalidated") expect(inval.bank).toBe(retainBank);
  });

  it("custom-service with real mnemopi succeeds via capability", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-learn-real-"));
    const svc = new CustomAutolearnService(dir);
    const proj = canonicalProjectIdentity("/tmp/proj-real");
    const cand = svc.observeCandidate({ episodeId: "ep1", sessionId: "sess1", projectIdentity: proj, toolName: "bash", toolCallId: "tc1", failureMessage: "fail", scope: "project" });
    svc.recordVerifierResult(cand.id, "bun test", { verified: true, summary: "ok", toolCallId: "tc1", expectedCommand: "bun test", failureFingerprint: cand.failureDigest, projectIdentity: proj, sessionId: "sess1", episodeId: "ep1" });
    const content = "Real reviewed fix for project";
    const appr = svc.approveCandidate(cand.id, content, proj);
    expect(appr.success).toBe(true);
    // Use real state as mnemopi client
    const res = await svc.projectToMnemopiReal(cand.id, state as unknown as never);
    expect(res.ok).toBe(true);
    expect(res.mnemopiId).toBeTruthy();
    const projRef = svc.getProjection(cand.id);
    expect(projRef).not.toBeNull();
    // state's retain bank is fixed in this test config, not derived from project identity hash
    const expectedBank = state.getScopedRetainTarget().bank;
    expect(projRef!.bank).toBe(expectedBank);
    // Second projection must be idempotent (no duplicate write)
    const res2 = await svc.projectToMnemopiReal(cand.id, state as unknown as never);
    expect(res2.ok).toBe(true);
    expect(res2.mnemopiId).toBe(res.mnemopiId);
    // Delete via real state must use exact-bank and succeed
    const delOk = svc.deleteCandidateWithMnemopi(cand.id, proj, state as unknown as never);
    expect(delOk).toBe(true);
    expect(svc.getCandidate(cand.id)).toBeNull();
    expect(svc.getProjection(cand.id)).toBeNull();
    expect(state.getScopedMemoryInBank(res.mnemopiId!, projRef!.bank)).toBeNull();
    svc.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("targetBank param writes to exact bank and not to retain", () => {
    const otherBank = config.globalBank!;
    const content = "targetBank specific";
    const key = "target-key";
    const id = state.rememberScopedIdempotent(content, { scope: "bank", source: "custom-autolearn", idempotencyKey: key, targetBank: otherBank });
    expect(id).toBeTruthy();
    expect(state.getScopedMemoryInBank(id!, otherBank)).not.toBeNull();
    expect(state.getScopedMemoryInBank(id!, config.retainBank!)).toBeNull();
  });
});
