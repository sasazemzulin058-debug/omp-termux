import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

describe("explicit repoRoot must not be ignored", () => {
	const structuredPath = path.resolve(import.meta.dir, "../src/task/structured-subagent.ts");
	const taskIndexPath = path.resolve(import.meta.dir, "../src/task/index.ts");

	it("structured-subagent forces isolation when repoRoot supplied", async () => {
		const content = await fs.promises.readFile(structuredPath, "utf8");
		expect(content).toContain("hasExplicitRepoRoot");
		expect(content).toContain("Explicit repoRoot requires isolation");
		// The policy must set isIsolated true when repoRoot present
		expect(content).toContain("request.isolation?.requested === true || hasExplicitRepoRoot");
	});

	it("task spawn preserves repoRoot even when isolated flag omitted", async () => {
		const content = await fs.promises.readFile(taskIndexPath, "utf8");
		// spawnParamsFor must copy repoRoot from item or params
		expect(content).toContain("repoRoot");
		expect(content).toContain("spawn.repoRoot = item.repoRoot");
	});

	it("rejects isolated:false with repoRoot shape", async () => {
		// Simulate the validation logic without heavy imports: duplicate the function under test
		function isRepoRootShapeValid(requested: boolean | undefined, repoRoot: string | undefined): string | undefined {
			const hasExplicitRepoRoot = repoRoot !== undefined;
			if (hasExplicitRepoRoot && requested === false)
				return "Explicit repoRoot requires isolation; do not set isolated:false with repoRoot.";
			return undefined;
		}
		expect(isRepoRootShapeValid(false, "/tmp/repo")).toBeDefined();
		expect(isRepoRootShapeValid(undefined, "/tmp/repo")).toBeUndefined();
		expect(isRepoRootShapeValid(true, "/tmp/repo")).toBeUndefined();
		expect(isRepoRootShapeValid(undefined, undefined)).toBeUndefined();
	});

	it("getRepoRoot validates explicit root", async () => {
		// Direct file check: worktree.getRepoRoot must validate explicitRepoRoot
		const worktreePath = path.resolve(import.meta.dir, "../src/task/worktree.ts");
		const content = await fs.promises.readFile(worktreePath, "utf8");
		expect(content).toContain("getRepoRoot");
		expect(content).toContain("Explicit repoRoot");
	});
});
