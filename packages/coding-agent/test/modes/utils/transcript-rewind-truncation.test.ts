/**
 * History rewinds (esc-esc branch, /tree navigation to an ancestor) drop the
 * rendered transcript tail in place instead of a destructive clear-scrollback
 * replay — but only while none of the dropped blocks' rows entered native
 * scrollback (committed rows are immutable tape). Covers the fast-path gates
 * in UiHelpers.truncateTranscriptFromMessage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { Component } from "@oh-my-pi/pi-tui";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

class Block implements Component {
	disposed = false;
	constructor(private line: string) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return [this.line];
	}
	dispose(): void {
		this.disposed = true;
	}
}

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AgentMessage;
}

function assistantMessage(text: string, input: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input, output: 1, cacheRead: 0, cacheWrite: 0 },
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

/**
 * Rendered transcript: user1, assistant1, user2, assistant2 — one row each,
 * separated by blank rows (rows 0..6). The rewind boundary is user2 (row 4).
 */
function createHarness() {
	const user1 = userMessage("first question");
	const assistant1 = assistantMessage("first answer", 42);
	const user2 = userMessage("second question");
	const assistant2 = assistantMessage("second answer", 99);

	const chat = new TranscriptContainer();
	const blocks = [new Block("user-1"), new Block("assistant-1"), new Block("user-2"), new Block("assistant-2")];
	for (const block of blocks) chat.addChild(block);

	const transcriptMessageComponents = new WeakMap<AgentMessage, Component>();
	transcriptMessageComponents.set(user1, blocks[0]!);
	transcriptMessageComponents.set(assistant1, blocks[1]!);
	transcriptMessageComponents.set(user2, blocks[2]!);
	transcriptMessageComponents.set(assistant2, blocks[3]!);

	// Messages the view session reports AFTER the rewind; tests mutate this to
	// model a session that was (or was not) actually rewound.
	const remainingMessages: AgentMessage[] = [user1, assistant1];
	const viewSession = {
		isStreaming: false,
		buildTranscriptSessionContext: () => ({ messages: remainingMessages }),
	};

	const ctx = {
		initialChatRendered: true,
		focusedAgentId: undefined,
		viewSession,
		pendingTools: new Map<string, unknown>(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		chatContainer: chat,
		transcriptMessageComponents,
		lastAssistantUsage: undefined,
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		ui: { requestRender: vi.fn() },
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		chat,
		blocks,
		remainingMessages,
		viewSession,
		messages: { user1, assistant1, user2, assistant2 },
		helpers: new UiHelpers(ctx),
	};
}

describe("UiHelpers.truncateTranscriptFromMessage", () => {
	it("drops an uncommitted tail in place and reseeds rewind-scoped state", () => {
		const { ctx, chat, blocks, messages, helpers } = createHarness();
		expect(chat.render(40)).toEqual(["user-1", "", "assistant-1", "", "user-2", "", "assistant-2"]);
		// Only rows above the boundary (user-1 / assistant-1) are on the tape.
		chat.setNativeScrollbackCommittedRows(3);

		expect(helpers.truncateTranscriptFromMessage(messages.user2)).toBe(true);

		expect(chat.children).toEqual([blocks[0]!, blocks[1]!]);
		expect(blocks[2]!.disposed).toBe(true);
		expect(blocks[3]!.disposed).toBe(true);
		expect(blocks[0]!.disposed).toBe(false);
		expect(chat.render(40)).toEqual(["user-1", "", "assistant-1"]);
		// Cache-invalidation baseline reseeds from the surviving assistant turn,
		// not the dropped one.
		expect(ctx.lastAssistantUsage).toBe(messages.assistant1.usage);
		// Surviving components stay reusable; dropped ones are pruned.
		expect(ctx.transcriptMessageComponents.get(messages.assistant1)).toBe(blocks[1]!);
		expect(ctx.transcriptMessageComponents.get(messages.user2)).toBeUndefined();
		expect(ctx.ui.requestRender).toHaveBeenCalled();
	});

	it("falls back once any dropped row entered native scrollback", () => {
		const { chat, blocks, messages, helpers } = createHarness();
		chat.render(40);
		// Commit through user-2's row: the boundary block is now immutable tape.
		chat.setNativeScrollbackCommittedRows(5);

		expect(helpers.truncateTranscriptFromMessage(messages.user2)).toBe(false);

		expect(chat.children).toHaveLength(4);
		expect(blocks[2]!.disposed).toBe(false);
	});

	it("bails without mutating when the session was not actually rewound past the boundary", () => {
		const { chat, blocks, messages, remainingMessages, helpers } = createHarness();
		chat.render(40);
		chat.setNativeScrollbackCommittedRows(0);
		remainingMessages.push(messages.user2, messages.assistant2);

		expect(helpers.truncateTranscriptFromMessage(messages.user2)).toBe(false);

		expect(chat.children).toHaveLength(4);
		expect(blocks[2]!.disposed).toBe(false);
	});

	it("falls back while the view session is streaming or has in-flight tools", () => {
		const streaming = createHarness();
		streaming.viewSession.isStreaming = true;
		expect(streaming.helpers.truncateTranscriptFromMessage(streaming.messages.user2)).toBe(false);

		const pending = createHarness();
		pending.ctx.pendingTools.set("call-1", {} as never);
		expect(pending.helpers.truncateTranscriptFromMessage(pending.messages.user2)).toBe(false);
		expect(pending.chat.children).toHaveLength(4);
	});
});
