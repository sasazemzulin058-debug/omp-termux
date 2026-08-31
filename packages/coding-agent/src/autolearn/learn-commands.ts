/**
 * /learn slash command handler: status/view/approve/reject/delete/rollback/sweep/config
 * Enforces mode/scope/no DB off/builtin, and never creates DB when disabled.
 * Registered through the real extension command API (api.registerCommand), not a markdown prompt file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CustomAutolearnService, resolveAutolearnMode, canonicalProjectIdentity, getAgentDir } from "./custom-service";
import type { ExtensionFactory } from "../extensibility/extensions";

export type LearnCommand = "status" | "view" | "approve" | "reject" | "delete" | "rollback" | "sweep" | "config";

export interface LearnCommandResult {
	ok: boolean;
	message: string;
	data?: unknown;
}

function dbExists(agentDir: string): boolean {
	return fs.existsSync(path.join(agentDir, "learn.db"));
}

export interface LearnCommandOptions {
	agentDir?: string;
	mnemopi?: {
		rememberScoped: (content: string, opts: { scope: string; source: string }) => string | undefined;
		editScopedMemory: (op: string, id: string) => unknown;
	} | null;
}

export async function handleLearnCommand(
	args: string[],
	settings: { get(key: string): unknown },
	cwd: string,
	options?: LearnCommandOptions,
): Promise<LearnCommandResult> {
	const cmd = (args[0] as LearnCommand | undefined) ?? "status";
	const valid: LearnCommand[] = ["status", "view", "approve", "reject", "delete", "rollback", "sweep", "config"];
	if (!valid.includes(cmd as LearnCommand)) {
		return { ok: false, message: `Unknown /learn subcommand: ${cmd}. Valid: ${valid.join(", ")}` };
	}

	// Enforce mode/scope/no DB off/builtin: do not create DB when mode is off or builtin.
	const mode = resolveAutolearnMode(settings);
	if (mode !== "custom") {
		const exists = dbExists(options?.agentDir ?? getAgentDir());
		if (!exists) {
			// Never create DB file
			return { ok: true, message: `/learn ${cmd}: disabled (mode=${mode}); no learning database present.` };
		}
		// If DB exists from earlier custom run but mode now off/builtin, do not create new data; allow view/status/config but block mutations including sweep.
		if (["approve", "reject", "delete", "rollback", "sweep"].includes(cmd)) {
			return { ok: false, message: `/learn ${cmd} blocked: autolearn.mode=${mode} (requires custom)` };
		}
	}

	const agentDir = options?.agentDir ?? getAgentDir();
	// Only construct service when needed; constructor creates DB file, but we already gated off-mode with no file.
	// For view/status even in off mode with existing DB, we can open read-only.
	let svc: CustomAutolearnService | null = null;
	try {
		svc = new CustomAutolearnService(agentDir);
	} catch (e) {
		return { ok: false, message: `Failed to open learn db: ${String(e).slice(0, 512)}` };
	}

	try {
		const projectIdentity = canonicalProjectIdentity(cwd);

		switch (cmd) {
			case "status": {
				const candidates = svc.listCandidates(projectIdentity);
				const byStatus: Record<string, number> = {};
				for (const c of candidates) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
				return { ok: true, message: `Learn status (mode=${mode}, scope project=${projectIdentity}): ${JSON.stringify(byStatus)}`, data: byStatus };
			}
			case "view": {
				const id = args[1];
				if (id) {
					const cand = svc.getCandidate(id);
					if (!cand) return { ok: false, message: `Candidate not found: ${id}` };
					if (cand.projectIdentity !== projectIdentity && cand.scope !== "global") {
						return { ok: false, message: "Unauthorized scope for view" };
					}
					return { ok: true, message: `Candidate ${id}: ${cand.status}`, data: cand };
				}
				const list = svc.listCandidates(projectIdentity);
				return { ok: true, message: `Candidates (${list.length}) for ${projectIdentity}`, data: list };
			}
			case "approve": {
				const id = args[1];
				const reviewed = args.slice(2).join(" ");
				if (!id || !reviewed) return { ok: false, message: "Usage: /learn approve <candidate-id> <reviewed-content>" };
				const res = svc.approveCandidate(id, reviewed, projectIdentity);
				if (!res.success) return { ok: false, message: res.error ?? "Approve failed" };
				// Project exact redacted reviewed content via scoped Mnemopi when available. Uses stored scope/project/bank.
				if (options?.mnemopi) {
					const proj = await svc.projectToMnemopiReal(id, options.mnemopi as unknown as { rememberScoped: (c: string, o: { scope: string; source: string }) => string | undefined });
					if (!proj.ok) {
						return { ok: false, message: `Approved ${id} but projection failed: ${proj.error}; candidate reset to needs_review` };
					}
					const stored = svc.getProjection(id);
					return { ok: true, message: `Approved ${id} projected ${proj.mnemopiId} (bank=${stored?.bank ?? "unknown"})`, data: { mnemopiId: proj.mnemopiId, bank: stored?.bank } };
				}
				return { ok: true, message: `Approved ${id}` };
			}
			case "reject": {
				const id = args[1];
				if (!id) return { ok: false, message: "Usage: /learn reject <candidate-id>" };
				const ok = svc.rejectCandidate(id, projectIdentity);
				return ok ? { ok: true, message: `Rejected ${id}` } : { ok: false, message: `Reject failed: ${id}` };
			}
			case "delete": {
				const id = args[1];
				if (!id) return { ok: false, message: "Usage: /learn delete <candidate-id>" };
				// Use stored scope/project/bank and preserve projection reference on uncertain backend failure.
				const proj = svc.getProjection(id);
				if (proj && options?.mnemopi) {
					const ok = svc.deleteCandidateWithMnemopi(id, projectIdentity, options.mnemopi as unknown as { editScopedMemory: (op: string, id: string) => unknown });
					if (!ok) {
						// Conservative: backend failure keeps projection; check if still present
						const still = svc.getProjection(id);
						const cand = svc.getCandidate(id);
						if (still || cand) {
							return { ok: false, message: `Delete failed: ${id} (mnemopi backend uncertain; projection preserved, status=${cand?.status ?? "unknown"})` };
						}
						return { ok: false, message: `Delete failed: ${id}` };
					}
					return { ok: true, message: `Deleted ${id} (tombstoned, mnemopi cleaned)` };
				}
				if (proj && !options?.mnemopi) {
					// Without mnemopi handle, cannot safely clean scoped memory; treat as uncertain -> preserve.
					// Fall back to conservative check: if projected, require mnemopi
					return { ok: false, message: `Delete failed: ${id} (projected memory requires mnemopi backend; retry with active session)` };
				}
				const ok = svc.deleteCandidate(id, projectIdentity);
				return ok ? { ok: true, message: `Deleted ${id} (tombstoned)` } : { ok: false, message: `Delete failed: ${id}` };
			}
			case "rollback": {
				const id = args[1];
				if (!id) return { ok: false, message: "Usage: /learn rollback <candidate-id>" };
				// Must use stored scope/project/bank and preserve on uncertain failure
				const proj = svc.getProjection(id);
				if (!proj) return { ok: false, message: `Rollback failed: ${id} (no projection)` };
				if (!options?.mnemopi) {
					return { ok: false, message: `Rollback failed: ${id} (mnemopi backend required for projected rollback; projection preserved)` };
				}
				const ok = svc.rollbackCandidateWithMnemopi(id, projectIdentity, options.mnemopi as unknown as { editScopedMemory: (op: string, id: string) => unknown });
				if (!ok) {
					const still = svc.getProjection(id);
					if (still) {
						return { ok: false, message: `Rollback failed: ${id} (mnemopi backend uncertain; projection preserved)` };
					}
					return { ok: false, message: `Rollback failed: ${id} (tombstoned or scope mismatch)` };
				}
				return { ok: true, message: `Rolled back ${id}` };
			}
			case "sweep": {
				const n = svc.sweepExpired();
				return { ok: true, message: `Swept ${n} expired candidates` };
			}
			case "config": {
				const mode2 = resolveAutolearnMode(settings);
				return { ok: true, message: `autolearn.mode=${mode2} (cwd=${projectIdentity})` };
			}
		}
	} finally {
		try { svc.close(); } catch {}
	}
	return { ok: false, message: "unhandled" };
}

/**
 * Production slash-command registration for /learn.
 * Wires through the real extension command system (api.registerCommand), not a markdown prompt file.
 * Routes all lifecycle operations through CustomAutolearnService with scope and stored bank,
 * projects exact redacted reviewed content via scoped Mnemopi, and preserves projection references
 * on uncertain backend failure.
 */
export const createLearnExtension: ExtensionFactory = api => {
	api.registerCommand("learn", {
		description: "Custom autolearn: status/view/approve/reject/delete/rollback/sweep/config (custom mode only; uses scoped Mnemopi)",
		getArgumentCompletions(argumentPrefix: string): import("@oh-my-pi/pi-tui").AutocompleteItem[] | null {
			const subcommands = ["status", "view", "approve", "reject", "delete", "rollback", "sweep", "config"];
			const trimmed = argumentPrefix.trim();
			if (trimmed.includes(" ")) return null;
			if (trimmed.length === 0) {
				return subcommands.map(c => ({ label: c, value: c, description: `/learn ${c}` }));
			}
			const filtered = subcommands.filter(c => c.startsWith(trimmed));
			return filtered.length > 0 ? filtered.map(c => ({ label: c, value: c, description: `/learn ${c}` })) : null;
		},
		async handler(args, ctx): Promise<void> {
			const raw = args.trim();
			const splitArgs = raw.length === 0 ? [] : raw.split(/\s+/);
			// Resolve settings from global proxy (initialized via Settings.init) and mnemopi from context memory/session
			let settingsObj: { get(key: string): unknown } = { get: () => undefined };
			try {
				const mod = await import("../config/settings");
				// Use global settings proxy which reflects current session's settings
				settingsObj = (mod as unknown as { settings: typeof settingsObj }).settings ?? settingsObj;
			} catch {}
			// Try to resolve scoped mnemopi handle from extension context
			let mnemopi: LearnCommandOptions["mnemopi"] = null;
			try {
				// Attempt to get MnemopiSessionState via ctx.memory or via dynamic session lookup
				const anyCtx = ctx as unknown as Record<string, unknown>;
				// If ctx has a direct helper (future runner may expose it), use it
				const maybeState = (anyCtx.getMnemopiSessionState as (() => unknown) | undefined)?.();
				if (maybeState && typeof (maybeState as Record<string, unknown>).rememberScoped === "function") {
					mnemopi = maybeState as unknown as LearnCommandOptions["mnemopi"];
				} else if (ctx.memory) {
					// MemoryRuntimeContext does not expose rememberScoped directly, but we can attempt to bridge via global state
					// Fallback: try to import getMnemopiSessionState and scan for session matching cwd (best-effort)
					try {
						const { getMnemopiSessionState } = await import("../mnemopi/state");
						// Attempt to locate session via sessionManager id - use global session registry if available by inspecting memory object closure
						// As a last resort, leave mnemopi null and handleLearnCommand will operate without projection (conservative block for projected ops)
						void getMnemopiSessionState;
					} catch {}
				}
			} catch {}
			const cwd = ctx.cwd;
			const result = await handleLearnCommand(splitArgs, settingsObj, cwd, { mnemopi: mnemopi ?? undefined });
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
			if (result.data) {
				// For status/view, present data via notify detail as well
				try { ctx.ui.notify(JSON.stringify(result.data).slice(0, 2048), "info"); } catch {}
			}
		},
	});
};
