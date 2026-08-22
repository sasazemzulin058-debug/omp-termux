import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import * as mcpConfigWriter from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getConfigRootDir, getProjectDir, removeWithRetries, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

describe("interactive /mcp test", () => {
	let projectDir = "";
	let agentDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-issue-956-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-issue-956-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);

		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify(
				{
					mcpServers: {
						github: {
							type: "stdio",
							command: "github-mcp-server",
							args: ["serve"],
						},
					},
				},
				null,
				2,
			),
		);
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	it("tests a discovered server and keeps its advertised Esc cancellation grace", async () => {
		vi.useFakeTimers();
		const transport = {
			connected: true,
			request: vi.fn(),
			notify: vi.fn(),
			close: vi.fn(async () => {}),
		};
		const connection = {
			name: "github",
			config: { type: "stdio" as const, command: "github-mcp-server", args: ["serve"] },
			transport,
			serverInfo: { name: "GitHub MCP", version: "1.0.0" },
			capabilities: {},
		};
		const showError = vi.fn();
		const showStatus = vi.fn();
		const requestRender = vi.fn();
		const addChild = vi.fn();
		const refreshMCPTools = vi.fn();
		const connectToServer = vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(connection);
		const listTools = vi.spyOn(mcpClient, "listTools").mockResolvedValue([{ name: "search_issues" }] as never);
		const disconnectServer = vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue();
		const mcpTestEscapeHandlers = new Set<() => void>();
		const controller = new MCPCommandController({
			mcpTestEscapeHandlers,
			chatContainer: { addChild },
			present: (content: unknown) => {
				for (const item of Array.isArray(content) ? content : [content]) addChild(item);
				requestRender();
			},
			presentCommandOutput: (content: unknown) => {
				for (const item of Array.isArray(content) ? content : [content]) addChild(item);
				requestRender();
			},
			ui: { requestRender },
			editor: {},
			showError,
			showStatus,
			session: { refreshMCPTools },
			mcpManager: {
				prepareConfig: vi.fn(async config => config),
				getConnectionStatus: vi.fn(() => "connected"),
			},
		} as never);

		await controller.handle("/mcp test github");
		const signal = connectToServer.mock.calls[0]?.[2]?.signal;
		expect(signal?.aborted).toBe(false);
		expect(mcpTestEscapeHandlers).toHaveLength(1);
		for (const handler of mcpTestEscapeHandlers) handler();
		expect(signal?.aborted).toBe(true);
		vi.advanceTimersByTime(4_999);
		expect(mcpTestEscapeHandlers).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(mcpTestEscapeHandlers).toHaveLength(0);

		expect(showError).not.toHaveBeenCalled();
		expect(connectToServer).toHaveBeenCalledWith(
			"github",
			expect.objectContaining({ command: "github-mcp-server", args: ["serve"] }),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(listTools).toHaveBeenCalledWith(connection, expect.objectContaining({ signal: expect.any(AbortSignal) }));
		expect(disconnectServer).toHaveBeenCalledWith(connection);
		expect(requestRender).toHaveBeenCalled();
	});

	it("claims Esc ownership before the awaited server lookup", async () => {
		const connection = {
			name: "github",
			config: { type: "stdio" as const, command: "github-mcp-server", args: ["serve"] },
			transport: { connected: true, request: vi.fn(), notify: vi.fn(), close: vi.fn(async () => {}) },
			serverInfo: { name: "GitHub MCP", version: "1.0.0" },
			capabilities: {},
		};
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(connection);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([{ name: "search_issues" }] as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue();
		const mcpTestEscapeHandlers = new Set<() => void>();
		const controller = new MCPCommandController({
			mcpTestEscapeHandlers,
			chatContainer: { addChild: vi.fn() },
			present: vi.fn(),
			presentCommandOutput: vi.fn(),
			ui: { requestRender: vi.fn() },
			editor: {},
			showError: vi.fn(),
			showStatus: vi.fn(),
			session: { refreshMCPTools: vi.fn() },
			mcpManager: {
				prepareConfig: vi.fn(async config => config),
				getConnectionStatus: vi.fn(() => "connected"),
			},
		} as never);

		// Do not await: the handler must be registered synchronously, before the
		// awaited `#resolveServerForAuth()` config read can suspend and let Esc
		// fall through to aborting the agent turn.
		const pending = controller.handle("/mcp test github");
		expect(mcpTestEscapeHandlers).toHaveLength(1);
		await pending;
	});

	it("releases Esc immediately when lookup fails before the hint is shown", async () => {
		vi.spyOn(mcpConfigWriter, "readMCPConfigFile").mockRejectedValue(new Error("EACCES: config unreadable"));
		const connectToServer = vi.spyOn(mcpClient, "connectToServer");
		const showError = vi.fn();
		const mcpTestEscapeHandlers = new Set<() => void>();
		const controller = new MCPCommandController({
			mcpTestEscapeHandlers,
			chatContainer: { addChild: vi.fn() },
			present: vi.fn(),
			presentCommandOutput: vi.fn(),
			ui: { requestRender: vi.fn() },
			editor: {},
			showError,
			showStatus: vi.fn(),
			session: { refreshMCPTools: vi.fn() },
			mcpManager: {
				getServerConfig: vi.fn(() => undefined),
				getSource: vi.fn(() => undefined),
			},
		} as never);

		await controller.handle("/mcp test github");

		// The "(esc to cancel)" hint never rendered, so no grace window applies:
		// Esc must be free again immediately instead of being swallowed for 5s.
		expect(mcpTestEscapeHandlers).toHaveLength(0);
		expect(connectToServer).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalled();
	});
});
