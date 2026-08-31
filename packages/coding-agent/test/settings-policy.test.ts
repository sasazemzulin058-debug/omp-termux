import { describe, it, expect } from "bun:test";
function isProjectAutolearnModeWeakening(globalMode: string | undefined, projectMode: string | undefined): boolean {
	if (typeof globalMode !== "string" || typeof projectMode !== "string" || globalMode === projectMode) return false;
	const rank = (m: string) => (m === "off" ? 0 : m === "builtin" ? 1 : m === "custom" ? 2 : 99);
	return rank(projectMode) > rank(globalMode);
}

describe("project config cannot weaken stricter user policy", () => {
	it("global off blocks project custom and builtin", () => {
		expect(isProjectAutolearnModeWeakening("off", "custom")).toBe(true);
		expect(isProjectAutolearnModeWeakening("off", "builtin")).toBe(true);
		expect(isProjectAutolearnModeWeakening("off", "off")).toBe(false);
	});
	it("global builtin blocks custom but allows off", () => {
		expect(isProjectAutolearnModeWeakening("builtin", "custom")).toBe(true);
		expect(isProjectAutolearnModeWeakening("builtin", "off")).toBe(false);
		expect(isProjectAutolearnModeWeakening("builtin", "builtin")).toBe(false);
	});
	it("global custom allows anything stricter", () => {
		expect(isProjectAutolearnModeWeakening("custom", "off")).toBe(false);
		expect(isProjectAutolearnModeWeakening("custom", "builtin")).toBe(false);
	});
	it("undefined global allows project", () => {
		expect(isProjectAutolearnModeWeakening(undefined, "custom")).toBe(false);
		expect(isProjectAutolearnModeWeakening(undefined, "off")).toBe(false);
	});
});
