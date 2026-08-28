import { describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { BrowserTool } from "@oh-my-pi/pi-coding-agent/tools/browser";
import * as launch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import {
	androidChromiumCandidates,
	getChromeProfileBaseDir,
	getTermuxPrefix,
	isAndroidEnvironment,
	resolveHeadlessExecutable,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import * as registry from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { browserKeyForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { sharedBrowserDaemonName } from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

const PREFIX = "/data/data/com.termux/files/usr";

function androidEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		PREFIX,
		ANDROID_ROOT: "/system",
		TERMUX_VERSION: "0.119",
		...overrides,
	};
}

function linuxEnv(): Record<string, string | undefined> {
	return {};
}

describe("android environment detection", () => {
	it("detects android via platform android", () => {
		expect(isAndroidEnvironment("android", {})).toBe(true);
	});

	it("detects termux via PREFIX containing com.termux", () => {
		expect(isAndroidEnvironment("linux", { PREFIX })).toBe(true);
	});

	it("detects termux via TERMUX_VERSION", () => {
		expect(isAndroidEnvironment("linux", { TERMUX_VERSION: "0.118" })).toBe(true);
	});

	it("detects termux via ANDROID_ROOT", () => {
		expect(isAndroidEnvironment("linux", { ANDROID_ROOT: "/system" })).toBe(true);
	});

	it("does not flag plain linux", () => {
		expect(isAndroidEnvironment("linux", {})).toBe(false);
		expect(isAndroidEnvironment("darwin", {})).toBe(false);
		expect(isAndroidEnvironment("win32", {})).toBe(false);
	});
});

describe("termux prefix and candidates", () => {
	it("uses $PREFIX when set", () => {
		expect(getTermuxPrefix({ PREFIX: "/custom/prefix" })).toBe("/custom/prefix");
	});

	it("falls back to default prefix", () => {
		expect(getTermuxPrefix({})).toBe("/data/data/com.termux/files/usr");
	});

	it("produces candidates in contract order", () => {
		const cands = androidChromiumCandidates(PREFIX);
		expect(cands).toEqual([
			path.join(PREFIX, "lib/chromium/chrome"),
			path.join(PREFIX, "bin/chromium"),
			path.join(PREFIX, "bin/chromium-browser"),
			path.join(PREFIX, "bin/chrome"),
		]);
	});
});

describe("chrome profile base dir", () => {
	it("uses $PREFIX/tmp on Android", () => {
		expect(getChromeProfileBaseDir("linux", androidEnv())).toBe(path.join(PREFIX, "tmp"));
		expect(getChromeProfileBaseDir("android", {})).toBe(path.join("/data/data/com.termux/files/usr", "tmp"));
	});

	it("respects TMPDIR inside PREFIX on Android", () => {
		const env = androidEnv({ TMPDIR: path.join(PREFIX, "tmp") });
		expect(getChromeProfileBaseDir("linux", env)).toBe(path.join(PREFIX, "tmp"));
	});

	it("uses os.tmpdir on desktop", () => {
		expect(getChromeProfileBaseDir("linux", linuxEnv())).toBe(os.tmpdir());
		expect(getChromeProfileBaseDir("darwin", {})).toBe(os.tmpdir());
	});
});

describe("resolveHeadlessExecutable precedence", () => {
	const valid = async () => true;
	const invalid = async () => false;

	it("browser.executablePath wins over env and candidates", async () => {
		const setting = "/custom/chrome";
		const env = androidEnv({ PUPPETEER_EXECUTABLE_PATH: "/env/chrome" });
		const candidates = [path.join(PREFIX, "lib/chromium/chrome")];
		const mockExec = (p: string) => p === setting || p === "/env/chrome" || p === candidates[0];
		const result = await resolveHeadlessExecutable({
			executablePathSetting: setting,
			env,
			platform: "linux",
			prefix: PREFIX,
			isExecutableFile: mockExec,
			isChromiumExecutable: valid,
			candidates,
		});
		expect(result).toBe(setting);
	});

	it("env wins over candidates when setting absent", async () => {
		const envPath = "/env/chrome";
		const env = androidEnv({ PUPPETEER_EXECUTABLE_PATH: envPath });
		const candidates = [path.join(PREFIX, "lib/chromium/chrome")];
		const mockExec = (_p: string) => true;
		const result = await resolveHeadlessExecutable({
			env,
			platform: "linux",
			prefix: PREFIX,
			isExecutableFile: mockExec,
			isChromiumExecutable: valid,
			candidates,
		});
		expect(result).toBe(envPath);
	});

	it("first valid candidate wins in order", async () => {
		const cands = androidChromiumCandidates(PREFIX);
		// Make second candidate valid, first invalid
		const mockExec = (p: string) => p === cands[1];
		const result = await resolveHeadlessExecutable({
			env: androidEnv(),
			platform: "linux",
			prefix: PREFIX,
			isExecutableFile: mockExec,
			isChromiumExecutable: valid,
			candidates: cands,
		});
		expect(result).toBe(cands[1]);
	});

	it("prefers $PREFIX/lib/chromium/chrome over fallback bins", async () => {
		const cands = androidChromiumCandidates(PREFIX);
		const mockExec = (_p: string) => true;
		const result = await resolveHeadlessExecutable({
			env: androidEnv(),
			platform: "linux",
			prefix: PREFIX,
			isExecutableFile: mockExec,
			isChromiumExecutable: valid,
			candidates: cands,
		});
		expect(result).toBe(cands[0]);
	});

	it("returns undefined on desktop when no explicit set (allows managed download)", async () => {
		const result = await resolveHeadlessExecutable({
			env: linuxEnv(),
			platform: "linux",
			isExecutableFile: () => false,
			isChromiumExecutable: invalid,
		});
		expect(result).toBeUndefined();
	});
});

describe("resolveHeadlessExecutable fail-closed", () => {
	it("throws for invalid browser.executablePath instead of falling through", async () => {
		const bad = "/bad/chrome";
		await expect(
			resolveHeadlessExecutable({
				executablePathSetting: bad,
				env: androidEnv(),
				platform: "linux",
				prefix: PREFIX,
				isExecutableFile: () => false,
				isChromiumExecutable: async () => false,
			}),
		).rejects.toBeInstanceOf(ToolError);
		let threw = false;
		try {
			await resolveHeadlessExecutable({
				executablePathSetting: bad,
				env: androidEnv({ PUPPETEER_EXECUTABLE_PATH: "/tmp/valid" }),
				platform: "linux",
				prefix: PREFIX,
				isExecutableFile: (p) => p === "/tmp/valid",
				isChromiumExecutable: async () => true,
			});
		} catch (e) {
			threw = true;
			expect((e as Error).message).toContain("browser.executablePath");
		}
		expect(threw).toBe(true);
	});

	it("throws for invalid PUPPETEER_EXECUTABLE_PATH instead of falling back to candidates", async () => {
		const env = androidEnv({ PUPPETEER_EXECUTABLE_PATH: "/bad/env/chrome" });
		const cands = androidChromiumCandidates(PREFIX);
		await expect(
			resolveHeadlessExecutable({
				env,
				platform: "linux",
				prefix: PREFIX,
				isExecutableFile: (p) => p === cands[0],
				isChromiumExecutable: async () => true,
			}),
		).rejects.toThrow(/PUPPETEER_EXECUTABLE_PATH/);
	});

	it("throws with install hint when no Android candidate valid", async () => {
		await expect(
			resolveHeadlessExecutable({
				env: androidEnv(),
				platform: "linux",
				prefix: PREFIX,
				isExecutableFile: () => false,
				isChromiumExecutable: async () => false,
			}),
		).rejects.toThrow(/pkg install/);
	});
});

describe("no managed download on Android", () => {
	it("does not return undefined on Android — always validated or threw", async () => {
		// On Android, resolveHeadlessExecutable never returns undefined; it either returns a candidate or throws.
		// This ensures ensureChromiumExecutable will not fall through to managed download.
		const cands = androidChromiumCandidates(PREFIX);
		const result = await resolveHeadlessExecutable({
			env: androidEnv(),
			platform: "linux",
			prefix: PREFIX,
			isExecutableFile: (p) => p === cands[2],
			isChromiumExecutable: async () => true,
		});
		expect(result).toBe(cands[2]);
		// Desktop with no explicit returns undefined, allowing download path
		const desktop = await resolveHeadlessExecutable({
			env: linuxEnv(),
			platform: "linux",
			isExecutableFile: () => false,
			isChromiumExecutable: async () => false,
		});
		expect(desktop).toBeUndefined();
	});
});

describe("threading executable through registry and daemon", () => {
	it("browserKey includes executablePath", () => {
		const base = browserKeyForTest({ kind: "headless", headless: true });
		const withExe = browserKeyForTest({ kind: "headless", headless: true, executablePath: "/data/data/com.termux/files/usr/lib/chromium/chrome" });
		const withOther = browserKeyForTest({ kind: "headless", headless: true, executablePath: "/other/chrome" });
		expect(withExe).not.toBe(base);
		expect(withExe).not.toBe(withOther);
		expect(withExe).toContain("headless:1:");
		expect(withExe).toContain("/data/data/com.termux/files/usr/lib/chromium/chrome");
	});

	it("daemon name includes executable and spec hash", () => {
		const base = sharedBrowserDaemonName(true);
		const withExe = sharedBrowserDaemonName(true, "/data/data/com.termux/files/usr/lib/chromium/chrome");
		const withExeAndSpec = sharedBrowserDaemonName(true, "/data/data/com.termux/files/usr/lib/chromium/chrome", "spec123");
		const withDifferentExe = sharedBrowserDaemonName(true, "/other/chrome");
		expect(base).toBe("omp.browser.headless");
		expect(withExe).not.toBe(base);
		expect(withExeAndSpec).not.toBe(withExe);
		expect(withExe).not.toBe(withDifferentExe);
		expect(withExe.startsWith("omp.browser.headless-")).toBe(true);
	});

	it("different viewports produce different daemon identities via spec hash", () => {
		const exe = "/data/data/com.termux/files/usr/lib/chromium/chrome";
		const argsA = ["--window-size=1365,768", "--no-sandbox"];
		const argsB = ["--window-size=800,600", "--no-sandbox"];
		const hashA = Bun.hash(argsA.join("|")).toString(16).padStart(16, "0").slice(-7);
		const hashB = Bun.hash(argsB.join("|")).toString(16).padStart(16, "0").slice(-7);
		const nameA = sharedBrowserDaemonName(true, exe, hashA);
		const nameB = sharedBrowserDaemonName(true, exe, hashB);
		expect(nameA).not.toBe(nameB);
	});

	it("headless true vs false are distinct even with same executable", () => {
		const exe = "/data/data/com.termux/files/usr/lib/chromium/chrome";
		const headed = browserKeyForTest({ kind: "headless", headless: false, executablePath: exe });
		const headless = browserKeyForTest({ kind: "headless", headless: true, executablePath: exe });
		expect(headed).not.toBe(headless);
	});

	it("app path and relay take precedence over headless executable", async () => {
		const makeSession = (settings: Record<string, unknown>): ToolSession =>
			({
				cwd: "/tmp",
				hasUI: true,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated(settings as never),
				getSessionId: () => "test",
			}) as unknown as ToolSession;

		const session = makeSession({ "browser.executablePath": "/tmp/chrome" });
		const tool = new BrowserTool(session);
		let capturedKind: registry.BrowserKind | null = null;
		const spy = spyOn(registry, "acquireBrowser").mockImplementation(async (kind) => {
			capturedKind = kind;
			throw new ToolError("stop");
		});
		try {
			await tool.execute("id", { action: "open", app: { cdp_url: "http://127.0.0.1:9222" } } as never);
		} catch {}
		if (capturedKind && typeof capturedKind === "object" && "kind" in capturedKind) {
			expect(capturedKind.kind).toBe("connected");
		} else {
			throw new Error("kind not captured");
		}
		spy.mockRestore();

		capturedKind = null;
		const spy2 = spyOn(registry, "acquireBrowser").mockImplementation(async (kind) => {
			capturedKind = kind;
			throw new ToolError("stop");
		});
		const resolveSpy = spyOn(launch, "resolveHeadlessExecutable").mockResolvedValue(
			"/data/data/com.termux/files/usr/lib/chromium/chrome",
		);
		try {
			await tool.execute("id", { action: "open" } as never);
		} catch {}
		if (capturedKind && typeof capturedKind === "object" && "kind" in capturedKind) {
			expect(capturedKind.kind).toBe("headless");
			const headlessKind = capturedKind as Extract<registry.BrowserKind, { kind: "headless" }>;
			expect(headlessKind.executablePath).toBe("/data/data/com.termux/files/usr/lib/chromium/chrome");
		} else {
			throw new Error("headless kind not captured");
		}
		resolveSpy.mockRestore();
		spy2.mockRestore();
	});
});
