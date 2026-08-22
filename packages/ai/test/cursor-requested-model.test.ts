import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AgentRunRequest } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function cursorModel(id: string): Model<"cursor-agent"> {
	return buildModel({
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	});
}

function capture(model: Model<"cursor-agent">): Promise<AgentRunRequest> {
	const { promise, resolve, reject } = Promise.withResolvers<AgentRunRequest>();
	streamCursor(model, { messages: [{ role: "user", content: "pong", timestamp: 0 }] } satisfies Context, {
		apiKey: "test-token",
		onPayload: payload => {
			if (payload && typeof payload === "object" && "$typeName" in payload) {
				resolve(payload as AgentRunRequest);
			} else {
				reject(new Error("Cursor payload was not an AgentRunRequest"));
			}
			throw new Error("stop after capturing Cursor payload");
		},
	});
	return promise;
}

function captureSimple(model: Model<"cursor-agent">, reasoning?: Effort): Promise<AgentRunRequest> {
	const { promise, resolve, reject } = Promise.withResolvers<AgentRunRequest>();
	streamSimple(
		model,
		{ messages: [{ role: "user", content: "pong", timestamp: 0 }] },
		{
			apiKey: "test-token",
			reasoning,
			onPayload: payload => {
				if (payload && typeof payload === "object" && "$typeName" in payload) {
					resolve(payload as AgentRunRequest);
				} else {
					reject(new Error("Cursor payload was not an AgentRunRequest"));
				}
				throw new Error("stop after capturing Cursor payload");
			},
		},
	);
	return promise;
}

function collapsedCursorModel(fast: boolean): Model<"cursor-agent"> {
	const suffix = fast ? "-fast" : "";
	return buildModel({
		id: `gpt-5.6-sol${suffix}`,
		requestModelId: `gpt-5.6-sol-none${suffix}`,
		name: `GPT-5.6 Sol${fast ? " Fast" : ""}`,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			effortRouting: {
				off: `gpt-5.6-sol-none${suffix}`,
				[Effort.Low]: `gpt-5.6-sol-low${suffix}`,
				[Effort.Medium]: `gpt-5.6-sol-medium${suffix}`,
				[Effort.High]: `gpt-5.6-sol-high${suffix}`,
				[Effort.XHigh]: `gpt-5.6-sol-xhigh${suffix}`,
				[Effort.Max]: `gpt-5.6-sol-max${suffix}`,
			},
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	} satisfies ModelSpec<"cursor-agent">);
}

describe("Cursor requestedModel wire shape", () => {
	it("splits a GPT reasoning-sibling slug into base id + reasoning parameter", async () => {
		const payload = await capture(cursorModel("gpt-5.4-mini-low"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.4-mini");
		expect(payload.requestedModel?.parameters).toEqual([expect.objectContaining({ id: "reasoning", value: "low" })]);
		// modelDetails is still read server-side, so it must carry the base id too.
		expect(payload.modelDetails?.modelId).toBe("gpt-5.4-mini");
	});

	it("handles multi-segment GPT bases and the xhigh tier", async () => {
		const payload = await capture(cursorModel("gpt-5.6-sol-xhigh"));
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol");
		expect(payload.requestedModel?.parameters).toEqual([
			expect.objectContaining({ id: "reasoning", value: "xhigh" }),
		]);
	});

	it("routes the selected effort from a collapsed catalog model", async () => {
		const payload = await captureSimple(collapsedCursorModel(false), Effort.XHigh);
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol");
		expect(payload.requestedModel?.parameters).toEqual([
			expect.objectContaining({ id: "reasoning", value: "xhigh" }),
		]);
	});

	it("preserves the fast lane while splitting its effort token", async () => {
		const payload = await captureSimple(collapsedCursorModel(true), Effort.High);
		expect(payload.requestedModel?.modelId).toBe("gpt-5.6-sol-fast");
		expect(payload.requestedModel?.parameters).toEqual([expect.objectContaining({ id: "reasoning", value: "high" })]);
	});

	it("leaves Cursor-native ids untouched with no parameters", async () => {
		const payload = await capture(cursorModel("cursor-composer-2.5"));
		expect(payload.requestedModel?.modelId).toBe("cursor-composer-2.5");
		expect(payload.requestedModel?.parameters).toEqual([]);
	});

	it("does not translate non-OpenAI siblings (Claude effort schema is undecoded)", async () => {
		const payload = await capture(cursorModel("claude-fable-5-low"));
		expect(payload.requestedModel?.modelId).toBe("claude-fable-5-low");
		expect(payload.requestedModel?.parameters).toEqual([]);
	});
});
