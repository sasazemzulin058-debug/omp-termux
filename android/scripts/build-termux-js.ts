#!/usr/bin/env bun
/**
 * Build Termux arm64 JS package without loading host (linux-x64) pi-natives.
 * Upstream gen:bundle pulls @oh-my-pi/pi-utils main export → natives → fails on CI.
 * Full arm64 package still ships: docs-embedded CLI + natives loader stubs.
 * Android .node is attached later by package-release.
 */
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { Glob } from "bun";

const repoRoot = path.resolve(import.meta.dir, "../..");
const packageDir = path.join(repoRoot, "packages/coding-agent");
const docsDir = path.join(repoRoot, "docs");
const outDir = path.join(repoRoot, "termux-build");
const bundleDir = path.join(repoRoot, "termux-bundle");

async function buildDocsPayload(): Promise<string> {
	const glob = new Glob("**/*.md");
	const files: string[] = [];
	for await (const relativePath of glob.scan(docsDir)) {
		files.push(relativePath.split(path.sep).join("/"));
	}
	files.sort();
	const bodies = await Promise.all(files.map(file => Bun.file(path.join(docsDir, file)).text()));
	const bodiesB64 = Buffer.from(gzipSync(Buffer.from(JSON.stringify(bodies)), { level: 9 })).toString(
		"base64",
	);
	return `${JSON.stringify(files)}\n${bodiesB64}`;
}

async function main(): Promise<void> {
	const docsPayload = await buildDocsPayload();
	await Bun.$`rm -rf ${outDir} ${bundleDir}`.quiet();
	await Bun.$`mkdir -p ${outDir} ${bundleDir}/node_modules/@oh-my-pi/pi-natives/native`.quiet();

	const output = await Bun.build({
		entrypoints: [path.join(packageDir, "src/cli.ts")],
		outdir: outDir,
		target: "bun",
		splitting: true,
		// Keep runtime natives external — Android .node is injected into the tarball.
		external: [
			"@oh-my-pi/pi-natives",
			"@huggingface/transformers",
			"fastembed",
			"onnxruntime-node",
			"omp-legacy-pi-modules",
		],
		define: {
			"process.env.PI_BUNDLED": JSON.stringify("true"),
			"process.env.PI_DOCS_EMBED": JSON.stringify(docsPayload),
		},
		minify: {
			whitespace: true,
			syntax: true,
			identifiers: true,
			keepNames: true,
		},
		throw: false,
	});
	if (!output.success) {
		throw new Error(`Termux CLI bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
	}

	await Bun.$`cp -R ${outDir}/. ${bundleDir}/`.quiet();
	const cliDst = path.join(bundleDir, "cli.js");
	const cli = await Bun.file(cliDst).text();
	const shebang = cli.startsWith("#!") ? cli : `#!/usr/bin/env bun\n${cli}`;
	await Bun.write(cliDst, shebang);

	const nativesPkg = path.join(repoRoot, "packages/natives/package.json");
	const nativesNative = path.join(repoRoot, "packages/natives/native");
	await Bun.$`cp ${nativesPkg} ${bundleDir}/node_modules/@oh-my-pi/pi-natives/`.quiet();
	for (const name of ["index.js", "loader-state.js", "embedded-addon.js", "clipboard.js", "desktop.js"]) {
		await Bun.$`cp ${path.join(nativesNative, name)} ${bundleDir}/node_modules/@oh-my-pi/pi-natives/native/`.quiet();
	}

	const tarPath = path.join(repoRoot, "termux-js.tar.gz");
	await Bun.$`tar -czf ${tarPath} -C ${bundleDir} .`.quiet();
	const size = (await Bun.file(tarPath).size) / 1024 / 1024;
	console.log(`Termux JS bundle: ${tarPath} (${size.toFixed(1)} MiB), docs files=${docsPayload.split("\n")[0].length > 2 ? "yes" : "no"}`);
}

await main();
