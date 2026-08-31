/**
 * /learn slash command handler: status/view/approve/reject/delete/rollback/sweep/config
 * Enforces mode/scope/no DB off/builtin, and never creates DB when disabled.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CustomAutolearnService, resolveAutolearnMode, canonicalProjectIdentity, getAgentDir } from "./custom-service";

export type LearnCommand = "status" | "view" | "approve" | "reject" | "delete" | "rollback" | "sweep" | "config";

export interface LearnCommandResult {
	ok: boolean;
	message: string;
	data?: unknown;
}

function dbExists(agentDir: string): boolean {
	return fs.existsSync(path.join(agentDir, "learn.db"));
}

export async function handleLearnCommand(
	args: string[],
	settings: { get(key: string): unknown },
	cwd: string,
	options?: { agentDir?: string },
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
		// If DB exists from earlier custom run but mode now off/builtin, do not create new data; allow view but block mutations.
		if (["approve", "reject", "delete", "rollback"].includes(cmd)) {
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
				const ok = svc.deleteCandidate(id, projectIdentity);
				return ok ? { ok: true, message: `Deleted ${id} (tombstoned)` } : { ok: false, message: `Delete failed: ${id}` };
			}
			case "rollback": {
				const id = args[1];
				if (!id) return { ok: false, message: "Usage: /learn rollback <candidate-id>" };
				const ok = svc.rollbackCandidate(id, projectIdentity);
				return ok ? { ok: true, message: `Rolled back ${id}` } : { ok: false, message: `Rollback failed: ${id} (tombstoned or no projection)` };
			}
			case "sweep": {
				const n = svc.sweepExpired();
				return { ok: true, message: `Swept ${n} expired candidates` };
			}
			case "config": {
				const mode = resolveAutolearnMode(settings);
				return { ok: true, message: `autolearn.mode=${mode} (cwd=${projectIdentity})` };
			}
		}
	} finally {
		try { svc.close(); } catch {}
	}
	return { ok: false, message: "unhandled" };
}
