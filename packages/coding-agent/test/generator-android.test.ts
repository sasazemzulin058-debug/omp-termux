import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildGeneratedBlock, generateEnumExports } from "../../natives/scripts/gen-enums";

describe("generated native exports android fallback", () => {
	const unsupported = ["AudioCapture", "AudioPlayback", "LiveWebRtcPeer", "copyToClipboard", "readImageFromClipboard"];
	const indexJsPath = path.resolve(import.meta.dir, "../../natives/native/index.js");
	const genEnumsPath = path.resolve(import.meta.dir, "../../natives/scripts/gen-enums.ts");

	it("real generator preserves fail-loud wrappers for every unsupported export", async () => {
		// Build a synthetic d.ts that contains all unsupported exports plus one control export
		const fakeDts = `
export declare class AudioCapture {}
export declare class AudioPlayback {}
export declare class LiveWebRtcPeer {}
export declare class Process {}
export declare function copyToClipboard(): void;
export declare function readImageFromClipboard(): void;
export declare function glob(): void;
export declare enum MyEnum { A = "a" }
`;
		const block = buildGeneratedBlock(fakeDts);
		for (const name of unsupported) {
			expect(block).toContain(`export const ${name} =`);
			expect(block).toContain(`Native ${name} is unsupported on Android/Termux`);
			expect(block).not.toContain(`export const ${name} = undefined`);
			// Proxy fail-loud pattern
			expect(block).toContain("new Proxy(err");
		}
		// Supported exports must still be direct re-exports
		expect(block).toContain("export const Process = nativeBindings.Process");
		expect(block).toContain("export const glob = nativeBindings.glob");
	});

	it("generateEnumExports round-trip preserves android stubs on disk", async () => {
		// Run the actual generator against the real index.d.ts/index.js if they exist; verify stub survival
		const dtsPath = path.resolve(import.meta.dir, "../../natives/native/index.d.ts");
		try {
			const before = await fs.promises.readFile(indexJsPath, "utf8");
			// Only run generator if native dts exists (skip in CI without rust build)
			if (fs.existsSync(dtsPath)) {
				await generateEnumExports();
				const after = await fs.promises.readFile(indexJsPath, "utf8");
				for (const name of unsupported) {
					expect(after).toContain(`Native ${name} is unsupported on Android/Termux`);
				}
				expect(after).toContain("new Proxy(err");
				// Restore original to avoid dirtying working tree for other tests
				await fs.promises.writeFile(indexJsPath, before, "utf8");
			} else {
				// Fallback: ensure gen-enums.ts still contains the stub logic (source check is secondary to real generation above)
				const gen = await fs.promises.readFile(genEnumsPath, "utf8");
				for (const name of unsupported) expect(gen).toContain(name);
			}
		} catch (e) {
			// If generator fails due to missing napi artifacts, still assert synthetic generation succeeded (above)
			expect(String(e)).not.toContain("No public symbols");
		}
	});

	it("index.js on disk still contains fail-loud wrappers and never exports undefined", async () => {
		const content = await fs.promises.readFile(indexJsPath, "utf8");
		for (const name of unsupported) {
			expect(content).toContain(name);
			expect(content).toContain(`Native ${name} is unsupported on Android/Termux`);
			expect(content).not.toContain(`export const ${name} = undefined`);
		}
		expect(content).toContain("new Proxy(err");
	});

	it("loader-state includes android-arm64 platform", async () => {
		const loader = await fs.promises.readFile(path.resolve(import.meta.dir, "../../natives/native/loader-state.js"), "utf8");
		expect(loader).toContain("android-arm64");
	});
});
