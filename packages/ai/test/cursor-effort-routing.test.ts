// Regression (#9246): the cursor transport hard-pinned every request to
// `model.requestModelId` (the collapsed `-none` off tier), so thinking-effort
// selection never reached the wire. `mapOptionsForApi` now resolves the effort
// to a routed wire id; `buildGrpcRequest` splits an OpenAI effort suffix off
// `options.wireModelId` into a `reasoning` parameter (suffixed sibling ids
// trigger Cursor's 528384) and sends the base id on both `requestedModel` and
// `modelDetails`, keeping the logical id only as the display id.
// buildGrpcRequest is exercised directly (the transport is HTTP/2)
// and the serialized run request is decoded back from the wire bytes.
import { describe, expect, it } from "bun:test";
import { buildGrpcRequest } from "@oh-my-pi/pi-ai/providers/cursor";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AgentRunRequest } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { AgentClientMessageSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { fromBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const model: Model<"cursor-agent"> = buildModel({
	id: "gpt-5.6-terra",
	name: "GPT-5.6 Terra",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "https://api2.cursor.sh",
	reasoning: true,
	requestModelId: "gpt-5.6-terra-none",
	thinking: {
		mode: "effort",
		efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		effortRouting: {
			off: "gpt-5.6-terra-none",
			[Effort.Low]: "gpt-5.6-terra-low",
			[Effort.Medium]: "gpt-5.6-terra-medium",
			[Effort.High]: "gpt-5.6-terra-high",
			[Effort.XHigh]: "gpt-5.6-terra-xhigh",
			[Effort.Max]: "gpt-5.6-terra-max",
		},
	},
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const context: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
};

function decodeRunRequest(requestBytes: Uint8Array): { case: string; value: Record<string, any> } {
	const decoded = fromBinary(AgentClientMessageSchema, requestBytes);
	return decoded.message as unknown as { case: string; value: Record<string, any> };
}

function captureStreamPayload(reasoning: Effort): Promise<AgentRunRequest> {
	const { promise, resolve, reject } = Promise.withResolvers<AgentRunRequest>();
	streamSimple(model, context, {
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
	});
	return promise;
}

describe("cursor effort routing", () => {
	it("routes stream reasoning through to the Cursor payload", async () => {
		const run = await captureStreamPayload(Effort.Medium);
		expect(run.requestedModel?.modelId).toBe("gpt-5.6-terra");
		expect(run.requestedModel?.parameters).toEqual([expect.objectContaining({ id: "reasoning", value: "medium" })]);
		expect(run.modelDetails?.modelId).toBe("gpt-5.6-terra");
	});
	it("sends the effort-routed wire id, not the collapsed off tier", async () => {
		const { requestBytes } = await buildGrpcRequest(
			model,
			context,
			{ wireModelId: "gpt-5.6-terra-medium" },
			{ conversationId: "conv-1", blobStore: new Map() },
		);
		const run = decodeRunRequest(requestBytes).value;
		expect(run.requestedModel.modelId).toBe("gpt-5.6-terra");
		expect(run.modelDetails.modelId).toBe("gpt-5.6-terra");
		expect(run.requestedModel.parameters).toEqual([expect.objectContaining({ id: "reasoning", value: "medium" })]);

		// Logical id stays as the display id for local attribution.
		expect(run.modelDetails.displayModelId).toBe("gpt-5.6-terra");
	});

	it("falls back to requestModelId when no wire id is routed", async () => {
		const { requestBytes } = await buildGrpcRequest(model, context, undefined, {
			conversationId: "conv-2",
			blobStore: new Map(),
		});
		const run = decodeRunRequest(requestBytes).value;
		expect(run.requestedModel.modelId).toBe("gpt-5.6-terra-none");
		expect(run.modelDetails.modelId).toBe("gpt-5.6-terra-none");
	});
});
