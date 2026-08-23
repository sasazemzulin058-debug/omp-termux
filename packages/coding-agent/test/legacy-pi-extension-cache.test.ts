import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const probePath = path.resolve(import.meta.dir, "fixtures", "legacy-pi-extension-cache-probe.ts");
const tempDirs: TempDir[] = [];

async function runProbe(cacheRoot: string): Promise<string> {
	const env: Record<string, string | undefined> = { ...process.env, XDG_CACHE_HOME: cacheRoot };
	for (const key of ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR"]) {
		delete env[key];
	}
	const proc = Bun.spawn([process.execPath, probePath], {
		cwd: path.resolve(import.meta.dir, "../.."),
		env,
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return stdout;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await dir.remove();
});

test("legacy extension analysis persists and reads its SQLite parse cache", async () => {
	const tempDir = TempDir.createSync("@legacy-pi-extension-cache-");
	tempDirs.push(tempDir);
	const cacheRoot = tempDir.path();
	await fs.mkdir(path.join(cacheRoot, "omp"), { recursive: true });

	expect(await runProbe(cacheRoot)).toBe('import value from "./dependency.js?mtime=7";\n');

	const cachePath = path.join(cacheRoot, "omp", "cache", "legacy-pi-extension-cache.db");
	const db = new Database(cachePath);
	const result = db.run(
		"UPDATE extension_parse_cache SET [references] = '[]' WHERE [references] LIKE '%dependency.js%'",
	);
	expect(result.changes).toBeGreaterThan(0);
	db.close();

	// A fresh process has no memory cache. The unchanged output proves it read
	// the deliberately altered persisted row instead of parsing the source again.
	expect(await runProbe(cacheRoot)).toBe('import value from "./dependency.js";\n');
});
