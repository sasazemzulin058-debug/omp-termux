/**
 * Hermes memory backend adapter for OMP.
 *
 * Lazily imports `pi-hermes-memory` only when `memory.backend === "hermes"` is selected.
 * Default store path is `${agentDir}/memory/hermes` unless a factory override supplies another.
 * Implements all OMP MemoryBackend hooks with explicit inert/error status when the
 * dependency or per-session runtime is unavailable. No Hermes Pi tools/commands are
 * registered here — this is purely the OMP memory backend contract.
 *
 * Contract (from batch context):
 *   Hermes package is expected to export a named `createHermesMemoryBackend(options)` factory
 *   returning a HermeBackendRuntime with async methods:
 *     start, buildDeveloperInstructions, clear, enqueue, status, search, save,
 *     stats, diagnose, beforeAgentStartPrompt, preCompactionContext, dispose
 *   All async except dispose may be async. Factory options include memoryDir, cwd,
 *   session, taskDepth, modelRegistry, and exec callback. Package must not import OMP types;
 *   OMP normalizes returned data to OMP-like shapes.
 *
 * This adapter stays compileable even when `pi-hermes-memory` is not installed by
 * declaring a local typed seam and safely handling dynamic import failures.
 */

import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { completeSimple, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import type {
	MemoryBackend,
	MemoryBackendOperationContext,
	MemoryBackendSaveInput,
	MemoryBackendSaveResult,
	MemoryBackendSearchOptions,
	MemoryBackendSearchResult,
	MemoryBackendStartOptions,
	MemoryBackendStatus,
} from "./types";

// ---- Local typed seam for the expected Hermes package API ----
// We do NOT import from "pi-hermes-memory" at the top level to keep the module
// graph clean and to stay compileable when the package is absent.
// The seam mirrors the contract described in the batch context.

export interface HermesFactoryOptions {
	memoryDir: string;
	cwd: string;
	session?: AgentSession | unknown;
	taskDepth: number;
	modelRegistry?: unknown;
	exec?: (
		prompt: string,
		options?: { signal?: AbortSignal; maxTokens?: number; temperature?: number },
	) => Promise<string>;
}

export interface HermesRuntime {
	start(): Promise<void>;
	buildDeveloperInstructions(): Promise<string | undefined>;
	clear(): Promise<void>;
	enqueue(): Promise<void>;
	status(): Promise<Partial<MemoryBackendStatus> & { message?: string; error?: string }>;
	search(
		query: string,
		options?: MemoryBackendSearchOptions,
	): Promise<Partial<MemoryBackendSearchResult> & { message?: string }>;
	save(input: MemoryBackendSaveInput): Promise<Partial<MemoryBackendSaveResult> & { message?: string }>;
	stats(): Promise<string | undefined>;
	diagnose(): Promise<string | undefined>;
	beforeAgentStartPrompt(promptText: string): Promise<string | undefined>;
	preCompactionContext(messages: AgentMessage[]): Promise<string | undefined>;
	dispose(): Promise<void> | void;
}

export type HermesFactory = (options: HermesFactoryOptions) => HermesRuntime | Promise<HermesRuntime>;

// ---- Inert/error helpers ----

const HERMES_MISSING_MESSAGE =
	"Hermes memory backend is not available: pi-hermes-memory is not installed. Install it or set memory.backend to another value.";
const HERMES_NO_FACTORY_MESSAGE =
	"Hermes memory backend is not available: pi-hermes-memory does not export createHermesMemoryBackend. Update the package.";
const HERMES_NOT_STARTED_MESSAGE = "Hermes runtime has not been started for this session.";

function hermesUnavailableStatus(detail?: string): MemoryBackendStatus {
	return {
		backend: "hermes",
		active: false,
		writable: false,
		searchable: false,
		message: HERMES_MISSING_MESSAGE,
		error: detail ?? HERMES_MISSING_MESSAGE,
	};
}

function hermesInertSearch(backend: "hermes", query: string, message: string): MemoryBackendSearchResult {
	return { backend, query, count: 0, items: [], message };
}

function hermesInertSave(backend: "hermes", message: string): MemoryBackendSaveResult {
	return { backend, stored: 0, message };
}

// ---- Path helper ----

export function resolveHermesMemoryDir(agentDir: string): string {
	return path.join(agentDir, "memory", "hermes");
}

// ---- Dependency seam ----

let hermesFactoryOverride: HermesFactory | null | undefined;
let hermesLoadError: string | undefined;

const runtimes = new WeakMap<AgentSession, HermesRuntime>();
// Fallback for contexts without a session (ephemeral) — not cached across calls.
let ephemeralRuntime: HermesRuntime | undefined;

export function __setHermesFactoryForTests(factory: HermesFactory | null): void {
	hermesFactoryOverride = factory;
	hermesLoadError = undefined;
	if (factory === null) {
		// Simulate missing dependency
		ephemeralRuntime = undefined;
	}
}

export function __resetHermesFactoryForTests(): void {
	hermesFactoryOverride = undefined;
	hermesLoadError = undefined;
	ephemeralRuntime = undefined;
}

export function __clearHermesRuntimesForTests(): void {
	ephemeralRuntime = undefined;
	// WeakMap cannot be cleared enumerably; callers should drop session refs.
}

export function __getHermesRuntimeForTests(session: AgentSession): HermesRuntime | undefined {
	return runtimes.get(session);
}

export function __getHermesLoadErrorForTests(): string | undefined {
	return hermesLoadError;
}

export async function disposeHermesRuntimeForSession(session: AgentSession): Promise<void> {
	const runtime = runtimes.get(session);
	if (!runtime) return;
	try {
		await runtime.dispose?.();
	} finally {
		runtimes.delete(session);
	}
}

export function hasHermesRuntime(session: AgentSession): boolean {
	return runtimes.has(session);
}

async function loadHermesFactory(): Promise<HermesFactory | undefined> {
	if (hermesFactoryOverride !== undefined) return hermesFactoryOverride ?? undefined;
	try {
		// Runtime subpath avoids Pi extension registration and Pi-only dependencies.
		const mod: unknown = await import("pi-hermes-memory/runtime");
		if (typeof mod !== "object" || mod === null || !("createHermesMemoryBackend" in mod)) {
			hermesLoadError = HERMES_NO_FACTORY_MESSAGE;
			return undefined;
		}
		const factory = mod.createHermesMemoryBackend;
		if (typeof factory !== "function") {
			hermesLoadError = HERMES_NO_FACTORY_MESSAGE;
			return undefined;
		}
		return factory as HermesFactory;
	} catch (error) {
		hermesLoadError = error instanceof Error ? error.message : String(error);
		logger.warn("Hermes backend: runtime is not available", { error: hermesLoadError });
		return undefined;
	}
}

function createHermesExec(
	settings: Settings,
	modelRegistry: ModelRegistry,
	sessionId: string,
): (prompt: string, options?: { signal?: AbortSignal; maxTokens?: number; temperature?: number }) => Promise<string> {
	return async (prompt, options) => {
		let resolved: { model: Model; thinkingLevel?: unknown } | undefined;
		try {
			resolved = resolveRoleSelection(["tiny", "smol", "default"], settings, modelRegistry.getAvailable());
		} catch (error) {
			throw new Error(
				`Hermes exec unavailable: model resolution failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const model = resolved?.model;
		if (!model) {
			throw new Error(
				"Hermes exec unavailable: no model resolved. Configure a smol/default provider or enable a local model for hermes.",
			);
		}
		const hasKey = await modelRegistry.getApiKey(model, sessionId);
		if (!hasKey) {
			throw new Error(`Hermes exec unavailable: no API key for ${model.provider}/${model.id}`);
		}
		const message = await retryTransientCompletion(() =>
			completeSimple(
				model,
				{
					messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
				},
				{
					apiKey: modelRegistry.resolver(model, sessionId),
					maxTokens: options?.maxTokens,
					temperature: options?.temperature,
					signal: options?.signal,
				},
			),
		);
		const text = message.content
			.filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
			.map(block => block.text)
			.join("\n")
			.trim();
		if (!text) throw new Error("Hermes exec failed: empty completion");
		return text;
	};
}

function createHermesExecUnavailable(reason: string): HermesFactoryOptions["exec"] {
	return async () => {
		throw new Error(`Hermes exec unavailable: ${reason}`);
	};
}

async function getOrCreateRuntimeForSession(
	session: AgentSession,
	agentDir: string,
	cwd: string,
	taskDepth: number,
	settings: Settings,
	modelRegistry: ModelRegistry,
): Promise<HermesRuntime | undefined> {
	const existing = runtimes.get(session);
	if (existing) return existing;

	const factory = await loadHermesFactory();
	if (!factory) return undefined;

	const memoryDir = resolveHermesMemoryDir(agentDir);
	const sessionId = (session as { sessionId?: string }).sessionId ?? "unknown";
	const exec = createHermesExec(settings, modelRegistry, sessionId);
	try {
		const runtime = await factory({
			memoryDir,
			cwd,
			session,
			taskDepth,
			modelRegistry,
			exec,
		});
		runtimes.set(session, runtime);
		return runtime;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		hermesLoadError = message;
		logger.warn("Hermes backend: failed to create runtime", { error: message });
		return undefined;
	}
}

async function getRuntimeForContext(context: MemoryBackendOperationContext): Promise<HermesRuntime | undefined> {
	if (context.session) {
		return runtimes.get(context.session as AgentSession);
	}
	// No session — if we have an ephemeral runtime for this agentDir, reuse it;
	// otherwise try to create one if factory is available (used for status without session).
	if (ephemeralRuntime) return ephemeralRuntime;
	const factory = await loadHermesFactory();
	if (!factory) return undefined;
	// We lack modelRegistry here, so create a minimal inert runtime.
	// Instead of fabricating, return undefined and let caller emit inert status.
	return undefined;
}

// ---- Backend implementation ----

export const hermesBackend: MemoryBackend = {
	id: "hermes",

	async start(options: MemoryBackendStartOptions): Promise<void> {
		// Only the root agent (taskDepth 0) owns persistent Hermes state, mirrioring
		// hindsight/mnemopi scoping. Subagents skip Hermes wiring.
		if (options.taskDepth !== 0) return;

		const existing = runtimes.get(options.session as AgentSession);
		if (existing) {
			try {
				await existing.start();
			} catch (error) {
				logger.warn("Hermes backend: runtime.start failed", { error: String(error) });
			}
			return;
		}

		const runtime = await getOrCreateRuntimeForSession(
			options.session as AgentSession,
			options.agentDir,
			options.session.sessionManager?.getCwd?.() ?? options.agentDir,
			options.taskDepth,
			options.settings,
			options.modelRegistry as ModelRegistry,
		);
		if (!runtime) {
			// Explicit inert — do not throw, do not fall back to another backend.
			logger.warn("Hermes backend: start skipped — dependency or factory unavailable", {
				loadError: hermesLoadError ?? HERMES_MISSING_MESSAGE,
			});
			return;
		}
		try {
			await runtime.start();
		} catch (error) {
			logger.warn("Hermes backend: runtime.start threw", { error: String(error) });
			// Keep runtime cached so status can report the error; do not rethrow.
		}
	},

	async buildDeveloperInstructions(
		_agentDir: string,
		_settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined> {
		if (session) {
			const runtime = runtimes.get(session);
			if (runtime) {
				try {
					return await runtime.buildDeveloperInstructions();
				} catch (error) {
					logger.warn("Hermes backend: buildDeveloperInstructions failed", { error: String(error) });
					return undefined;
				}
			}
		}
		// No runtime for this session — try ephemeral if factory exists but start wasn't called
		// (e.g., prompt rebuild after settings change). We need modelRegistry which we don't have here,
		// so remain inert rather than fabricating a runtime.
		if (hermesLoadError) {
			logger.debug("Hermes backend: buildDeveloperInstructions inert — load error", {
				error: hermesLoadError,
			});
		}
		return undefined;
	},

	async clear(agentDir: string, _cwd: string, session?: AgentSession): Promise<void> {
		if (session) {
			const runtime = runtimes.get(session);
			if (runtime) {
				let clearError: unknown;
				try {
					await runtime.clear();
				} catch (error) {
					clearError = error;
					logger.warn("Hermes backend: clear failed", { error: String(error) });
				}
				try {
					await runtime.dispose?.();
				} catch (error) {
					logger.warn("Hermes backend: dispose after clear failed", { error: String(error) });
					clearError = clearError ?? error;
				}
				runtimes.delete(session);
				if (clearError) throw clearError;
				return;
			}
		}
		// No per-session runtime — attempt ephemeral clear via factory if available
		const factory = await loadHermesFactory();
		if (factory) {
			try {
				const memoryDir = resolveHermesMemoryDir(agentDir);
				const exec = createHermesExecUnavailable("no session/modelRegistry for ephemeral clear");
				const tmpRuntime = await factory({
					memoryDir,
					cwd: _cwd,
					session,
					taskDepth: 0,
					modelRegistry: undefined,
					exec,
				});
				await tmpRuntime.clear();
				await tmpRuntime.dispose?.();
				return;
			} catch (error) {
				logger.warn("Hermes backend: ephemeral clear failed", { error: String(error) });
				throw error;
			}
		}
		// No factory — explicit error so /memory can report it
		const msg = hermesLoadError ?? HERMES_MISSING_MESSAGE;
		logger.warn("Hermes backend: clear skipped — runtime unavailable", {
			loadError: msg,
		});
		throw new Error(msg);
	},

	async enqueue(agentDir: string, cwd: string, session?: AgentSession): Promise<void> {
		if (session) {
			const runtime = runtimes.get(session);
			if (runtime) {
				try {
					await runtime.enqueue();
				} catch (error) {
					logger.warn("Hermes backend: enqueue failed", { error: String(error) });
					throw error;
				}
				return;
			}
		}
		// No runtime — try ephemeral enqueue if factory exists
		const factory = await loadHermesFactory();
		if (factory) {
			try {
				const memoryDir = resolveHermesMemoryDir(agentDir);
				const exec = createHermesExecUnavailable("no session/modelRegistry for ephemeral enqueue");
				const tmpRuntime = await factory({
					memoryDir,
					cwd,
					session,
					taskDepth: 0,
					modelRegistry: undefined,
					exec,
				});
				await tmpRuntime.enqueue();
				await tmpRuntime.dispose?.();
				return;
			} catch (error) {
				logger.warn("Hermes backend: ephemeral enqueue failed", { error: String(error) });
				throw error;
			}
		}
		const msg = hermesLoadError ?? HERMES_MISSING_MESSAGE;
		logger.warn("Hermes backend: enqueue skipped — runtime unavailable", {
			loadError: msg,
		});
		throw new Error(msg);
	},

	async status(context: MemoryBackendOperationContext): Promise<MemoryBackendStatus> {
		const runtime = await getRuntimeForContext(context);
		if (!runtime) {
			return hermesUnavailableStatus(hermesLoadError);
		}
		try {
			const raw = await runtime.status();
			// Normalize to OMP shape — ensure backend is hermes and defaults are sane.
			return {
				backend: "hermes",
				active: raw.active ?? true,
				writable: raw.writable ?? true,
				searchable: raw.searchable ?? true,
				scope: raw.scope,
				retainBank: raw.retainBank,
				recallBanks: raw.recallBanks,
				workingCount: raw.workingCount,
				episodicCount: raw.episodicCount,
				tripleCount: raw.tripleCount,
				lastMemory: raw.lastMemory,
				lastRecall: raw.lastRecall,
				database: raw.database ?? resolveHermesMemoryDir(context.agentDir),
				message: raw.message,
				error: raw.error,
			};
		} catch (error) {
			return {
				backend: "hermes",
				active: false,
				writable: false,
				searchable: false,
				database: resolveHermesMemoryDir(context.agentDir),
				message: "Hermes status failed.",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},

	async search(
		context: MemoryBackendOperationContext,
		query: string,
		options?: MemoryBackendSearchOptions,
	): Promise<MemoryBackendSearchResult> {
		const runtime = await getRuntimeForContext(context);
		if (!runtime) {
			return hermesInertSearch("hermes", query, hermesLoadError ?? HERMES_MISSING_MESSAGE);
		}
		try {
			const raw = await runtime.search(query, options);
			return {
				backend: "hermes",
				query: raw.query ?? query,
				count: raw.count ?? raw.items?.length ?? 0,
				items: (raw.items ?? []).map(item => ({
					id: item.id,
					content: item.content,
					source: item.source,
					timestamp: item.timestamp,
					score: item.score,
				})),
				message: raw.message,
			};
		} catch (error) {
			return hermesInertSearch("hermes", query, error instanceof Error ? error.message : String(error));
		}
	},

	async save(context: MemoryBackendOperationContext, input: MemoryBackendSaveInput): Promise<MemoryBackendSaveResult> {
		const runtime = await getRuntimeForContext(context);
		if (!runtime) {
			return hermesInertSave("hermes", hermesLoadError ?? HERMES_NOT_STARTED_MESSAGE);
		}
		try {
			const raw = await runtime.save(input);
			return {
				backend: "hermes",
				stored: raw.stored ?? 0,
				ids: raw.ids,
				queued: raw.queued,
				message: raw.message,
			};
		} catch (error) {
			return hermesInertSave("hermes", error instanceof Error ? error.message : String(error));
		}
	},

	async stats(agentDir: string, _cwd: string, session?: AgentSession): Promise<string | undefined> {
		if (session) {
			const runtime = runtimes.get(session);
			if (runtime) {
				try {
					return await runtime.stats();
				} catch (error) {
					return `Hermes stats failed: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
		}
		const factory = await loadHermesFactory();
		if (!factory) {
			return `Hermes stats unavailable: ${hermesLoadError ?? HERMES_MISSING_MESSAGE}`;
		}
		try {
			const memoryDir = resolveHermesMemoryDir(agentDir);
			const exec = createHermesExecUnavailable("no session/modelRegistry for ephemeral stats");
			const tmpRuntime = await factory({
				memoryDir,
				cwd: _cwd,
				session,
				taskDepth: 0,
				modelRegistry: undefined,
				exec,
			});
			const out = await tmpRuntime.stats();
			await tmpRuntime.dispose?.();
			return out;
		} catch (error) {
			return `Hermes stats failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	},

	async diagnose(agentDir: string, _cwd: string, session?: AgentSession): Promise<string | undefined> {
		if (session) {
			const runtime = runtimes.get(session);
			if (runtime) {
				try {
					return await runtime.diagnose();
				} catch (error) {
					return `Hermes diagnose failed: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
		}
		const factory = await loadHermesFactory();
		if (!factory) {
			return `Hermes diagnose unavailable: ${hermesLoadError ?? HERMES_MISSING_MESSAGE}`;
		}
		try {
			const memoryDir = resolveHermesMemoryDir(agentDir);
			const exec = createHermesExecUnavailable("no session/modelRegistry for ephemeral diagnose");
			const tmpRuntime = await factory({
				memoryDir,
				cwd: _cwd,
				session,
				taskDepth: 0,
				modelRegistry: undefined,
				exec,
			});
			const out = await tmpRuntime.diagnose();
			await tmpRuntime.dispose?.();
			return out;
		} catch (error) {
			return `Hermes diagnose failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	},

	async beforeAgentStartPrompt(session: AgentSession, promptText: string): Promise<string | undefined> {
		const runtime = runtimes.get(session);
		if (!runtime) return undefined;
		try {
			// Hermes runtime signature is (session?, promptText?) — pass both
			const maybe = runtime.beforeAgentStartPrompt as unknown as (
				a?: unknown,
				b?: unknown,
			) => Promise<string | undefined>;
			// Try new 2-arg form first, fallback to legacy 1-arg
			const result = await (maybe.length >= 2
				? maybe(session, promptText)
				: maybe.length === 1
					? maybe(promptText)
					: maybe());
			return result;
		} catch (error) {
			logger.warn("Hermes backend: beforeAgentStartPrompt failed", { error: String(error) });
			return undefined;
		}
	},

	async preCompactionContext(
		messages: AgentMessage[],
		_settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined> {
		if (!session) return undefined;
		const runtime = runtimes.get(session);
		if (!runtime) return undefined;
		try {
			const maybe = runtime.preCompactionContext as unknown as (
				a?: unknown,
				b?: unknown,
				c?: unknown,
			) => Promise<string | undefined>;
			// Hermes runtime is (messages?, settings?, session?), OMP is (messages, settings, session)
			const result = await (maybe.length >= 3
				? maybe(messages, _settings, session)
				: maybe.length === 1
					? maybe(messages)
					: maybe.length === 2
						? maybe(messages, _settings)
						: maybe());
			return result;
		} catch (error) {
			logger.warn("Hermes backend: preCompactionContext failed", { error: String(error) });
			return undefined;
		}
	},
};
