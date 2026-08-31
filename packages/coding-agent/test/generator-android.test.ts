import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

describe("generated native exports android fallback", () => {
	const unsupported = ["AudioCapture", "AudioPlayback", "LiveWebRtcPeer", "copyToClipboard", "readImageFromClipboard"];
	const indexJsPath = path.resolve(import.meta.dir, "../../natives/native/index.js");
	const genEnumsPath = path.resolve(import.meta.dir, "../../natives/scripts/gen-enums.ts");

	it("index.js contains fail-loud wrappers for every unsupported export and never exports undefined", async () => {
		const content = await fs.promises.readFile(indexJsPath, "utf8");
		for (const name of unsupported) {
			expect(content).toContain(name);
			// Should contain error message pattern
			expect(content).toContain(`Native ${name} is unsupported on Android/Termux`);
			// Should use Proxy fallback that throws, not undefined
			expect(content).not.toContain(`export const ${name} = undefined`);
		}
		// Also check AudioCapture wrapper uses Proxy
		expect(content).toContain("new Proxy(err");
	});

	it("gen-enums.ts preserves androidUnsupported set and stub generation", async () => {
		const gen = await fs.promises.readFile(genEnumsPath, "utf8");
		for (const name of unsupported) {
			expect(gen).toContain(name);
		}
		expect(gen).toContain("androidUnsupported");
		expect(gen).toContain("androidStub");
		// Must preserve fail-loud fallback, not delete it on regeneration
		expect(gen).toContain("throw new Error");
	});

	it("loader-state includes android-arm64 platform", async () => {
		const loader = await fs.promises.readFile(path.resolve(import.meta.dir, "../../natives/native/loader-state.js"), "utf8");
		expect(loader).toContain("android-arm64");
	});
});
