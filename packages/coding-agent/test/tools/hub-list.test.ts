import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { renderIrcPeerRoster } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import {
	DEFAULT_HUB_LIST_LIMIT,
	executeList,
	executeSend,
	MAX_HUB_LIST_LIMIT,
} from "@oh-my-pi/pi-coding-agent/tools/hub/messaging";
import { TempDir } from "@oh-my-pi/pi-utils";

function sessionHeader(id: string): string {
	return JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-08-13T17:14:48.125Z",
		cwd: "/tmp",
	});
}

async function writeParkedTranscript(sessionFile: string, id: string, task: string): Promise<void> {
	await Bun.write(
		sessionFile,
		`${[
			sessionHeader(id),
			JSON.stringify({
				type: "session_init",
				id: `si-${id}`,
				parentId: null,
				timestamp: "2026-08-13T17:14:49.000Z",
				systemPrompt: "review",
				task,
				tools: ["read"],
			}),
		].join("\n")}\n`,
	);
}

function listText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content[0];
	if (content?.type !== "text") throw new Error("Expected text result");
	const text = content.text;
	if (typeof text !== "string") throw new Error("Expected text result");
	return text;
}

function makeToolSession(registry: AgentRegistry, agentId: string): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		agentRegistry: registry,
		getAgentId: () => agentId,
	};
}

describe("hub list", () => {
	it("defaults to running+idle peers and reports parked counts without parked names", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		registry.register({
			id: "AuthLoader",
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "running",
			activity: "auditing tokens",
		});
		registry.register({
			id: "IdleWorker",
			displayName: "task",
			kind: "sub",
			session: null,
			status: "idle",
		});
		registry.register({
			id: "ParkedScout",
			displayName: "secret parked label",
			kind: "sub",
			session: null,
			status: "parked",
			activity: "reviewing classified.diff",
		});

		const result = await executeList(registry, MAIN_AGENT_ID);
		if (!result.details) throw new Error("Expected coordination details");

		expect(result.details.peers?.map(peer => peer.id)).toEqual(["AuthLoader", "IdleWorker"]);
		expect(result.details.counts).toEqual({
			running: 1,
			idle: 1,
			parked: 1,
			shown: 2,
			truncated: 0,
		});
		const text = listText(result);
		expect(text).toContain("AuthLoader");
		expect(text).toContain("IdleWorker");
		expect(text).toContain("parked 1");
		expect(text).toContain('status="parked"');
		expect(text).not.toContain("ParkedScout");
		expect(text).not.toContain("secret parked label");
		expect(text).not.toContain("reviewing classified.diff");
	});

	it("lists parked peers only when status=parked is requested", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		registry.register({ id: "Live", displayName: "task", kind: "sub", session: null, status: "idle" });
		registry.register({
			id: "ParkedScout",
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "parked",
		});

		const result = await executeList(registry, MAIN_AGENT_ID, { status: "parked" });
		if (!result.details) throw new Error("Expected coordination details");

		expect(result.details.peers).toEqual([
			expect.objectContaining({
				id: "ParkedScout",
				status: "parked",
				parentId: MAIN_AGENT_ID,
			}),
		]);
		expect(result.details.counts).toEqual({
			running: 0,
			idle: 1,
			parked: 1,
			shown: 1,
			truncated: 0,
		});
		expect(listText(result)).toContain("Parked agents are revived automatically");
	});

	it("bounds the page and reports truncated without a cursor", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		const extra = 5;
		for (let index = 0; index < DEFAULT_HUB_LIST_LIMIT + extra; index++) {
			registry.register({
				id: `Idle${index}`,
				displayName: "task",
				kind: "sub",
				session: null,
				status: "idle",
				lastActivity: index,
			});
		}

		const result = await executeList(registry, MAIN_AGENT_ID);
		if (!result.details) throw new Error("Expected coordination details");

		expect(result.details.peers).toHaveLength(DEFAULT_HUB_LIST_LIMIT);
		expect(result.details.counts).toEqual({
			running: 0,
			idle: DEFAULT_HUB_LIST_LIMIT + extra,
			parked: 0,
			shown: DEFAULT_HUB_LIST_LIMIT,
			truncated: extra,
		});
		expect(result.details.peers?.[0]?.id).toBe(`Idle${DEFAULT_HUB_LIST_LIMIT + extra - 1}`);
		expect(result.details).not.toHaveProperty("cursor");
		expect(listText(result)).toContain(`truncated ${extra}`);
	});

	it("clamps an explicit limit so parked archaeology cannot dump hundreds of names", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		const extra = 20;
		for (let index = 0; index < MAX_HUB_LIST_LIMIT + extra; index++) {
			registry.register({
				id: `Parked${index}`,
				displayName: "task",
				kind: "sub",
				session: null,
				status: "parked",
				lastActivity: index,
			});
		}

		const result = await executeList(registry, MAIN_AGENT_ID, { status: "parked", limit: 500 });
		if (!result.details) throw new Error("Expected coordination details");

		expect(result.details.peers).toHaveLength(MAX_HUB_LIST_LIMIT);
		expect(result.details.counts).toEqual({
			running: 0,
			idle: 0,
			parked: MAX_HUB_LIST_LIMIT + extra,
			shown: MAX_HUB_LIST_LIMIT,
			truncated: extra,
		});
	});

	it("excludes aborted and advisor refs from every list view", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		registry.register({ id: "Worker", displayName: "task", kind: "sub", session: null, status: "idle" });
		registry.register({
			id: `${MAIN_AGENT_ID}/advisor`,
			displayName: "advisor",
			kind: "advisor",
			session: null,
			status: "parked",
		});
		registry.register({ id: "Dead", displayName: "task", kind: "sub", session: null, status: "aborted" });

		const listed = await executeList(registry, MAIN_AGENT_ID);
		const parked = await executeList(registry, MAIN_AGENT_ID, { status: "parked" });
		if (!listed.details || !parked.details) throw new Error("Expected coordination details");

		expect(listed.details.peers?.map(peer => peer.id)).toEqual(["Worker"]);
		expect(parked.details.peers).toEqual([]);
		expect(listed.details.counts).toEqual({
			running: 0,
			idle: 1,
			parked: 0,
			shown: 1,
			truncated: 0,
		});
	});

	it("schema rejects aborted and advisor list filters", () => {
		const tool = new HubTool(makeToolSession(new AgentRegistry(), MAIN_AGENT_ID));
		expect(() => tool.parameters.assert({ op: "list", status: "aborted" })).toThrow();
		expect(() => tool.parameters.assert({ op: "list", status: "advisor" })).toThrow();
		expect(tool.parameters.assert({ op: "list", status: "parked" })).toEqual({ op: "list", status: "parked" });
	});

	it("restores persisted peers after the process registry is lost without leaking them into the default view", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-persisted-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("main")}\n`);
		// A settled subagent transcript: header + session_init. A header-only file
		// is a mid-spawn stub and stays unregistered by design.
		await Bun.write(
			workerSessionFile,
			`${[
				sessionHeader("worker"),
				JSON.stringify({
					type: "session_init",
					id: "si",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					systemPrompt: "review",
					task: "review the diff",
					tools: ["read"],
				}),
			].join("\n")}\n`,
		);

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});

		const listed = await executeList(registry, MAIN_AGENT_ID);
		if (!listed.details) throw new Error("Expected coordination details");
		expect(listed.details.peers).toEqual([]);
		expect(listed.details.counts).toEqual({
			running: 0,
			idle: 0,
			parked: 1,
			shown: 0,
			truncated: 0,
		});
		expect(listText(listed)).not.toContain("Worker");
		expect(registry.get("Worker")?.sessionFile).toBe(workerSessionFile);

		const parked = await executeList(registry, MAIN_AGENT_ID, { status: "parked" });
		if (!parked.details) throw new Error("Expected coordination details");
		expect(parked.details.peers).toEqual([
			expect.objectContaining({
				id: "Worker",
				kind: "sub",
				status: "parked",
				parentId: MAIN_AGENT_ID,
			}),
		]);
		expect(listText(parked)).toContain("Worker");
		expect(listText(parked)).toContain("parked");
	});

	it("counts a disk-only parked sibling when a live sibling is already in memory", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-live-disk-");
		const dir = tempDir.path();
		const sessionFile = path.join(dir, "main.jsonl");
		const liveSessionFile = path.join(dir, "main", "LiveWorker.jsonl");
		const parkedSessionFile = path.join(dir, "main", "ParkedScout.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("main")}\n`);
		await writeParkedTranscript(parkedSessionFile, "parked", "reviewing classified.diff");

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});
		registry.register({
			id: "LiveWorker",
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: liveSessionFile,
			status: "idle",
		});

		const listed = await executeList(registry, MAIN_AGENT_ID);
		if (!listed.details) throw new Error("Expected coordination details");
		expect(listed.details.peers?.map(peer => peer.id)).toEqual(["LiveWorker"]);
		expect(listed.details.counts).toEqual({
			running: 0,
			idle: 1,
			parked: 1,
			shown: 1,
			truncated: 0,
		});
		expect(listText(listed)).not.toContain("ParkedScout");
		expect(listText(listed)).not.toContain("reviewing classified.diff");

		const fromChild = await executeList(registry, "LiveWorker");
		if (!fromChild.details) throw new Error("Expected coordination details");
		expect(fromChild.details.counts?.parked).toBe(1);
		expect(fromChild.details.peers?.map(peer => peer.id)).not.toContain("ParkedScout");
	});
	it("restores a newly selected root when the registry outlives a session", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-session-switch-");
		const firstRoot = path.join(tempDir.path(), "first.jsonl");
		const secondRoot = path.join(tempDir.path(), "second.jsonl");
		await Bun.write(firstRoot, `${sessionHeader("first")}\n`);
		await Bun.write(secondRoot, `${sessionHeader("second")}\n`);
		await writeParkedTranscript(path.join(tempDir.path(), "first", "OldWorker.jsonl"), "old", "old task");
		await writeParkedTranscript(path.join(tempDir.path(), "second", "NewWorker.jsonl"), "new", "new task");

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile: firstRoot,
			status: "running",
		});

		await executeList(registry, MAIN_AGENT_ID, { status: "parked" }, firstRoot);
		const switched = await executeList(registry, MAIN_AGENT_ID, { status: "parked" }, secondRoot);
		expect(switched.details?.peers?.map(peer => peer.id)).toContain("NewWorker");
	});

	it("clamps a positive fractional limit to at least one row", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		registry.register({ id: "IdleWorker", displayName: "task", kind: "sub", session: null, status: "idle" });

		const result = await executeList(registry, MAIN_AGENT_ID, { limit: 0.9 });
		if (!result.details) throw new Error("Expected coordination details");
		expect(result.details.peers).toHaveLength(1);
		expect(result.details.counts?.shown).toBe(1);
		expect(result.details.counts?.truncated).toBe(0);
	});

	it("send still revives a known parked id omitted from the default list", async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		try {
			const registry = AgentRegistry.global();
			registry.register({
				id: MAIN_AGENT_ID,
				displayName: MAIN_AGENT_ID,
				kind: "main",
				session: null,
				status: "running",
			});
			registry.register({ id: "Sleeper", displayName: "task", kind: "sub", session: null, status: "parked" });
			const delivered: string[] = [];
			const revived = {
				isStreaming: false,
				deliverIrcMessage: async (msg: { body: string }) => {
					delivered.push(msg.body);
					return "woken";
				},
			} as unknown as AgentSession;
			AgentLifecycleManager.global().adopt("Sleeper", {
				idleTtlMs: 0,
				revive: async () => revived,
			});

			const listed = await executeList(registry, MAIN_AGENT_ID);
			expect(listed.details?.peers?.map(peer => peer.id)).not.toContain("Sleeper");

			const sent = await executeSend(
				{ registry, senderId: MAIN_AGENT_ID, settings: Settings.isolated() },
				{ to: "Sleeper", message: "wake up" },
			);
			expect(sent.isError).toBeFalsy();
			expect(sent.details?.receipts).toEqual([{ to: "Sleeper", outcome: "revived" }]);
			expect(delivered).toEqual(["wake up"]);
			expect(registry.get("Sleeper")?.status).not.toBe("parked");
		} finally {
			AgentRegistry.resetGlobalForTests();
			AgentLifecycleManager.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		}
	});
});

describe("child system prompt roster", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	it("enumerates running+idle peers and one parked count, never parked names or task labels", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		registry.register({
			id: "LiveWorker",
			displayName: "implementer",
			kind: "sub",
			session: null,
			status: "running",
			activity: "editing auth.ts",
		});
		registry.register({
			id: "IdleReviewer",
			displayName: "reviewer",
			kind: "sub",
			session: null,
			status: "idle",
		});
		registry.register({
			id: "ParkedScout",
			displayName: "secret parked label",
			kind: "sub",
			session: null,
			status: "parked",
			activity: "reviewing classified.diff",
		});
		registry.register({
			id: `${MAIN_AGENT_ID}/advisor`,
			displayName: "advisor",
			kind: "advisor",
			session: null,
			status: "parked",
			activity: "advisor-only gist",
		});

		const text = await renderIrcPeerRoster("Child");
		expect(text).toContain("LiveWorker");
		expect(text).toContain("editing auth.ts");
		expect(text).toContain("IdleReviewer");
		expect(text).toContain("1 parked peer(s) omitted");
		expect(text).toContain('status:"parked"');
		expect(text).toContain("history://");
		expect(text).toContain("agent://");
		expect(text).not.toContain("ParkedScout");
		expect(text).not.toContain("secret parked label");
		expect(text).not.toContain("reviewing classified.diff");
		expect(text).not.toContain("advisor-only gist");
	});

	it("counts a disk-only parked sibling from the root tree without naming it", async () => {
		using tempDir = TempDir.createSync("@omp-hub-roster-live-disk-");
		const dir = tempDir.path();
		const sessionFile = path.join(dir, "main.jsonl");
		const liveSessionFile = path.join(dir, "main", "LiveWorker.jsonl");
		const parkedSessionFile = path.join(dir, "main", "ParkedScout.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("main")}\n`);
		await writeParkedTranscript(parkedSessionFile, "parked", "reviewing classified.diff");

		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});
		registry.register({
			id: "LiveWorker",
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: liveSessionFile,
			status: "idle",
		});

		const text = await renderIrcPeerRoster("LiveWorker", registry);
		expect(text).toContain("1 parked peer(s) omitted");
		expect(text).toContain("`Main`");
		expect(text).not.toContain("ParkedScout");
		expect(text).not.toContain("reviewing classified.diff");
	});
});
