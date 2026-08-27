import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { HermesFactory, HermesRuntime } from "@oh-my-pi/pi-coding-agent/memory-backend/hermes-backend";
import {
	__clearHermesRuntimesForTests,
	__getHermesRuntimeForTests,
	__resetHermesFactoryForTests,
	__setHermesFactoryForTests,
	hermesBackend,
	resolveHermesMemoryDir,
} from "@oh-my-pi/pi-coding-agent/memory-backend/hermes-backend";

describe("hermes memory backend", () => {
	beforeEach(() => {
		resetSettingsForTest();
		__resetHermesFactoryForTests();
		__clearHermesRuntimesForTests();
	});

	afterEach(() => {
		__resetHermesFactoryForTests();
		__clearHermesRuntimesForTests();
		resetSettingsForTest();
	});

	it("resolves hermes backend when memory.backend is hermes", async () => {
		const settings = Settings.isolated({ "memory.backend": "hermes" });
		const backend = await resolveMemoryBackend(settings);
		expect(backend.id).toBe("hermes");
		expect(backend).toBe(hermesBackend);
	});

	it("is mutually exclusive: hermes selection does not fall back to local/off on missing dependency", async () => {
		__setHermesFactoryForTests(null); // simulate missing pi-hermes-memory
		const settings = Settings.isolated({ "memory.backend": "hermes" });
		const backend = await resolveMemoryBackend(settings);
		expect(backend.id).toBe("hermes");
		// Status must be explicit inert/error, not a silent fallback to local
		const status = await backend.status!({ agentDir: "/tmp/agent", cwd: "/tmp/project" });
		expect(status.backend).toBe("hermes");
		expect(status.active).toBe(false);
		expect(status.writable).toBe(false);
		expect(status.searchable).toBe(false);
		expect(status.error ?? status.message).toMatch(/not available|not installed/i);
	});

	it("derives default memory directory under {agentDir}/memory/hermes", () => {
		expect(resolveHermesMemoryDir("/tmp/agent")).toBe("/tmp/agent/memory/hermes");
		expect(resolveHermesMemoryDir("/home/user/.omp/agent")).toBe("/home/user/.omp/agent/memory/hermes");
	});

	it("settings schema accepts memory.backend: hermes and honours mapping", async () => {
		const settings = Settings.isolated({ "memory.backend": "hermes" });
		expect(settings.get("memory.backend")).toBe("hermes");
		const backend = await resolveMemoryBackend(settings);
		expect(backend.id).toBe("hermes");
	});

	it("reports inert status/search/save when runtime has not been started and dependency is unavailable", async () => {
		__setHermesFactoryForTests(null);
		const fakeSession = { sessionId: "s1", getCwd: () => "/tmp/project" } as never;

		const status = await hermesBackend.status!({
			agentDir: "/tmp/agent",
			cwd: "/tmp/project",
			session: fakeSession,
		});
		expect(status).toMatchObject({
			backend: "hermes",
			active: false,
			writable: false,
			searchable: false,
		});
		expect(status.error ?? status.message).toMatch(/not available/i);

		const search = await hermesBackend.search!(
			{ agentDir: "/tmp/agent", cwd: "/tmp/project", session: fakeSession },
			"hello",
		);
		expect(search).toMatchObject({ backend: "hermes", query: "hello", count: 0, items: [] });
		expect(search.message).toMatch(/not available/i);

		const save = await hermesBackend.save!(
			{ agentDir: "/tmp/agent", cwd: "/tmp/project", session: fakeSession },
			{ content: "test" },
		);
		expect(save).toMatchObject({ backend: "hermes", stored: 0 });
		expect(save.message).toMatch(/not available|not been started/i);
	});

	it("uses injected factory via DI seam and reports active status after start", async () => {
		let factoryCall: { memoryDir: string; cwd: string; taskDepth: number } | undefined;
		const fakeRuntime: HermesRuntime = {
			start: async () => {},
			buildDeveloperInstructions: async () => "# Hermes memory\n- test fact",
			clear: async () => {},
			enqueue: async () => {},
			status: async () => ({
				active: true,
				writable: true,
				searchable: true,
				scope: "project",
				database: "/tmp/agent/memory/hermes/sessions.db",
				message: "Hermes active",
			}),
			search: async (query: string) => ({
				query,
				count: 1,
				items: [{ id: "1", content: `result for ${query}`, source: "memory", score: 0.9 }],
			}),
			save: async () => ({ stored: 1, ids: ["1"] }),
			stats: async () => "Hermes stats: 1 memory",
			diagnose: async () => "Hermes diagnose: ok",
			beforeAgentStartPrompt: async (prompt: string) => `${prompt}\n[Hermes injected]`,
			preCompactionContext: async () => "Hermes compaction context",
			dispose: async () => {},
		};

		const factory: HermesFactory = async options => {
			factoryCall = {
				memoryDir: options.memoryDir,
				cwd: options.cwd,
				taskDepth: options.taskDepth,
			};
			return fakeRuntime;
		};

		__setHermesFactoryForTests(factory);

		const session = { sessionId: "hermes-s1", getCwd: () => "/tmp/project" } as never;
		const agentDir = "/tmp/agent";
		await hermesBackend.start({
			session: session as never,
			settings: Settings.isolated({ "memory.backend": "hermes" }) as never,
			modelRegistry: {} as never,
			agentDir,
			taskDepth: 0,
		});

		expect(factoryCall?.memoryDir).toBe(resolveHermesMemoryDir(agentDir));
		expect(factoryCall?.cwd).toBe("/tmp/project");
		expect(factoryCall?.taskDepth).toBe(0);
		expect(__getHermesRuntimeForTests(session as never)).toBe(fakeRuntime);

		const status = await hermesBackend.status!({
			agentDir,
			cwd: "/tmp/project",
			session: session as never,
		});
		expect(status).toMatchObject({
			backend: "hermes",
			active: true,
			writable: true,
			searchable: true,
			scope: "project",
			database: "/tmp/agent/memory/hermes/sessions.db",
		});

		const search = await hermesBackend.search!(
			{ agentDir, cwd: "/tmp/project", session: session as never },
			"preference",
		);
		expect(search).toMatchObject({
			backend: "hermes",
			query: "preference",
			count: 1,
		});
		expect(search.items[0].content).toContain("preference");

		const save = await hermesBackend.save!(
			{ agentDir, cwd: "/tmp/project", session: session as never },
			{ content: "remember this" },
		);
		expect(save).toMatchObject({ backend: "hermes", stored: 1, ids: ["1"] });

		const instr = await hermesBackend.buildDeveloperInstructions(
			agentDir,
			Settings.isolated({ "memory.backend": "hermes" }) as never,
			session as never,
		);
		expect(instr).toContain("Hermes memory");

		const stats = await hermesBackend.stats!(agentDir, "/tmp/project", session as never);
		expect(stats).toContain("Hermes stats");

		const diagnose = await hermesBackend.diagnose!(agentDir, "/tmp/project", session as never);
		expect(diagnose).toContain("Hermes diagnose");

		const before = await hermesBackend.beforeAgentStartPrompt!(session as never, "system prompt");
		expect(before).toContain("Hermes injected");

		const ctx = await hermesBackend.preCompactionContext!(
			[{ role: "user", content: "hi" } as never],
			Settings.isolated({ "memory.backend": "hermes" }) as never,
			session as never,
		);
		expect(ctx).toBe("Hermes compaction context");
	});

	it("stats/diagnose return unavailable message when factory is missing", async () => {
		__setHermesFactoryForTests(null);
		const stats = await hermesBackend.stats!("/tmp/agent", "/tmp/project", undefined);
		expect(stats).toMatch(/unavailable|not available/i);
		const diagnose = await hermesBackend.diagnose!("/tmp/agent", "/tmp/project", undefined);
		expect(diagnose).toMatch(/unavailable|not available/i);
	});

	it("clear and enqueue are inert and do not throw when runtime is unavailable", async () => {
		__setHermesFactoryForTests(null);
		await expect(hermesBackend.clear("/tmp/agent", "/tmp/project", undefined)).resolves.toBeUndefined();
		await expect(hermesBackend.enqueue("/tmp/agent", "/tmp/project", undefined)).resolves.toBeUndefined();
	});

	it("does not expose Pi extension tools/commands registration surface", () => {
		// Hermes backend is purely a MemoryBackend; it must not duplicate Pi tool registration.
		const keys = Object.keys(hermesBackend);
		expect(keys).not.toContain("tools");
		expect(keys).not.toContain("commands");
		// Ensure id is exactly hermes and start does not register tools
		expect(hermesBackend.id).toBe("hermes");
	});

	it("beforeAgentStartPrompt and preCompactionContext are inert when no runtime", async () => {
		__setHermesFactoryForTests(null);
		const session = { sessionId: "no-runtime" } as never;
		await expect(hermesBackend.beforeAgentStartPrompt!(session, "prompt")).resolves.toBeUndefined();
		await expect(
			hermesBackend.preCompactionContext!([], Settings.isolated({ "memory.backend": "hermes" }) as never, session),
		).resolves.toBeUndefined();
	});

	it("start with taskDepth > 0 does not create a runtime (subagent isolation)", async () => {
		let called = false;
		const factory: HermesFactory = async () => {
			called = true;
			return {
				start: async () => {},
				buildDeveloperInstructions: async () => undefined,
				clear: async () => {},
				enqueue: async () => {},
				status: async () => ({ active: true, writable: true, searchable: true }),
				search: async q => ({ query: q, count: 0, items: [] }),
				save: async () => ({ stored: 0 }),
				stats: async () => undefined,
				diagnose: async () => undefined,
				beforeAgentStartPrompt: async () => undefined,
				preCompactionContext: async () => undefined,
				dispose: async () => {},
			};
		};
		__setHermesFactoryForTests(factory);
		const session = { sessionId: "sub", getCwd: () => "/tmp/project" } as never;
		await hermesBackend.start({
			session: session as never,
			settings: Settings.isolated({ "memory.backend": "hermes" }) as never,
			modelRegistry: {} as never,
			agentDir: "/tmp/agent",
			taskDepth: 1,
		});
		expect(called).toBe(false);
		expect(__getHermesRuntimeForTests(session as never)).toBeUndefined();
	});
});
