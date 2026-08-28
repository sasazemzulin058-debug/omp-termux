import { spawn } from "node:child_process";
import fs from "node:fs";

export function isAndroidEnvironment(
	platform: NodeJS.Platform = process.platform,
	env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): boolean {
	if (platform === "android") return true;
	if (env.TERMUX_VERSION !== undefined) return true;
	if (env.PREFIX?.includes("com.termux")) return true;
	return false;
}

let wakeLockRefCount = 0;

async function runTermuxCommand(cmd: string, args: string[]): Promise<boolean> {
	if (!isAndroidEnvironment()) return false;
	return await new Promise<boolean>(resolve => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(cmd, args, { stdio: "ignore", detached: true });
		} catch {
			resolve(false);
			return;
		}
		let settled = false;
		const done = (ok: boolean) => {
			if (settled) return;
			settled = true;
			resolve(ok);
		};
		child.on("error", () => done(false));
		child.on("close", code => done(code === 0));
		// Do not claim success merely because spawn() succeeded; wait for exit code.
		try {
			child.unref();
		} catch {}
		const t = setTimeout(() => done(false), 5000);
		// @ts-ignore - unref may not exist on Timeout in some runtimes
		t.unref?.();
	});
}

export async function acquireWakeLock(): Promise<boolean> {
	if (!isAndroidEnvironment()) return false;
	wakeLockRefCount++;
	if (wakeLockRefCount > 1) {
		return true;
	}
	const ok = await runTermuxCommand("termux-wake-lock", []);
	if (!ok) {
		wakeLockRefCount = Math.max(0, wakeLockRefCount - 1);
		return false;
	}
	return true;
}

export async function releaseWakeLock(): Promise<boolean> {
	if (!isAndroidEnvironment()) return false;
	if (wakeLockRefCount <= 0) return false;
	wakeLockRefCount--;
	if (wakeLockRefCount > 0) {
		return true;
	}
	const ok = await runTermuxCommand("termux-wake-unlock", []);
	return ok;
}

/**
 * Best-effort OOM score adjustment. Returns true only if the write succeeded.
 * Callers must not assume protection if this returns false.
 */
export function adjustOomScore(score: number | null = -500): boolean {
	if (!isAndroidEnvironment()) return false;
	if (score === null || score === undefined) return false;
	try {
		const clamped = Math.max(-1000, Math.min(1000, Math.round(score)));
		fs.writeFileSync("/proc/self/oom_score_adj", String(clamped));
		return true;
	} catch {
		return false;
	}
}

export function getWakeLockRefCountForTest(): number {
	return wakeLockRefCount;
}

export function resetWakeLockForTest(): void {
	wakeLockRefCount = 0;
}

export interface AndroidNotificationOptions {
	id?: string;
	title: string;
	body: string;
	channel?: string;
	priority?: "high" | "low" | "default";
}

export async function sendAndroidNotification(options: AndroidNotificationOptions): Promise<boolean> {
	if (!isAndroidEnvironment()) return false;
	// Notifications are best-effort: do not claim success unless termux-notification exits 0.
	const args: string[] = [];
	if (options.id) args.push("--id", options.id);
	args.push("--title", options.title);
	args.push("--content", options.body);
	if (options.priority) args.push("--priority", options.priority);
	// channel is optional, default channel used if omitted
	if (options.channel) args.push("--channel", options.channel);
	return await runTermuxCommand("termux-notification", args);
}

/**
 * Fire-and-forget wrapper that never throws and does not claim success synchronously.
 * Useful for lifecycle hooks where awaiting the notification would block teardown.
 */
export function sendAndroidNotificationFireAndForget(options: AndroidNotificationOptions): void {
	void sendAndroidNotification(options).catch(() => {});
}

