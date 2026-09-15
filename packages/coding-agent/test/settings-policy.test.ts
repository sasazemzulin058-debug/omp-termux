import { describe, expect, it } from "bun:test";

function isProjectAutolearnModeWeakening(globalMode: string | undefined, projectMode: string | undefined): boolean {
	if (typeof globalMode !== "string" || typeof projectMode !== "string" || globalMode === projectMode) return false;
	// Privacy ordering: off (strictest) < custom (verifier-gated, no transcript) < builtin (least strict)
	const rank = (m: string) => (m === "off" ? 0 : m === "custom" ? 1 : m === "builtin" ? 2 : 99);
	return rank(projectMode) > rank(globalMode);
}

describe("project config cannot weaken stricter user policy", () => {
	it("global off blocks project custom and builtin", () => {
		expect(isProjectAutolearnModeWeakening("off", "custom")).toBe(true);
		expect(isProjectAutolearnModeWeakening("off", "builtin")).toBe(true);
		expect(isProjectAutolearnModeWeakening("off", "off")).toBe(false);
	});
	it("global custom blocks builtin but allows off", () => {
		expect(isProjectAutolearnModeWeakening("custom", "builtin")).toBe(true);
		expect(isProjectAutolearnModeWeakening("custom", "off")).toBe(false);
		expect(isProjectAutolearnModeWeakening("custom", "custom")).toBe(false);
	});
	it("global builtin allows anything stricter", () => {
		expect(isProjectAutolearnModeWeakening("builtin", "off")).toBe(false);
		expect(isProjectAutolearnModeWeakening("builtin", "custom")).toBe(false);
	});
	it("undefined global allows project", () => {
		expect(isProjectAutolearnModeWeakening(undefined, "custom")).toBe(false);
		expect(isProjectAutolearnModeWeakening(undefined, "off")).toBe(false);
	});
});
