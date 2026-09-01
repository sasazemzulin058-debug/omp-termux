/**
 * Custom autolearn session controller (custom mode only).
 * Observes bounded tool events, verifies via allowlisted verifiers, persists candidate, and supports projection.
 * Requires reliable structured verifier proof with exact tool/episode/project/fingerprint identity; never infers verified from exit success.
 * Binds verifier proof to actual tool start metadata (invocation command, toolCallId) and repository-root identity.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import {
	CustomAutolearnService,
	resolveProjectIdentity,
	canonicalProjectIdentity,
	resolveAutolearnMode,
	isAllowlistedVerifierCommand,
} from "./custom-service";
const MAX_CANDIDATES_PER_EPISODE = 20;
function extractInvocationCommand(toolName: string, args: unknown): string {
	if (toolName === "bash" && args !== null && typeof args === "object" && "command" in (args as Record<string, unknown>)) {
		const c = (args as Record<string, unknown>)["command"];
		if (typeof c === "string" && c.trim()) return c.trim();
	}
	return toolName;
}

/** Extract bounded failure summary from tool result without persisting raw transcript/stdout/path/secrets. */
function boundedFailureMessage(result: unknown): string {
	if (typeof result === "string") return result.slice(0, 512);
	try {
		const s = JSON.stringify(result);
		return s.slice(0, 512);
	} catch {
		return String(result).slice(0, 512);
	}
}

interface StructuredVerifierProof {
	verified: true;
	summary: string;
	toolCallId: string;
	expectedCommand: string;
	failureFingerprint: string;
	projectIdentity: string;
	sessionId: string;
	episodeId: string;
}

function extractStructuredVerifierProof(result: unknown): StructuredVerifierProof | null {
	if (result == null) return null;
	let payload: unknown = result;
	// If result is a JSON string, parse it
	if (typeof payload === "string") {
		const trimmed = payload.trim();
		if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
			try {
				payload = JSON.parse(trimmed);
			} catch {
				return null;
			}
		} else {
			return null;
		}
	}
	if (typeof payload !== "object") return null;
	const obj = payload as Record<string, unknown>;
	let cand: Record<string, unknown> | null = null;
	if (typeof obj.verified === "boolean") cand = obj;
	else if (obj.structured && typeof (obj.structured as Record<string, unknown>).verified === "boolean")
		cand = obj.structured as Record<string, unknown>;
	else if (obj.data && typeof (obj.data as Record<string, unknown>).verified === "boolean")
		cand = obj.data as Record<string, unknown>;
	else if (obj.verifierResult && typeof (obj.verifierResult as Record<string, unknown>).verified === "boolean")
		cand = obj.verifierResult as Record<string, unknown>;
	else if (typeof obj.content === "string") {
		try {
			const inner = JSON.parse(obj.content);
			if (inner && typeof inner.verified === "boolean") cand = inner as Record<string, unknown>;
		} catch {}
	}
	if (!cand) return null;
	if (cand.verified !== true) return null;
	const toolCallId = cand.toolCallId;
	const failureFingerprint = cand.failureFingerprint;
	const projectIdentity = cand.projectIdentity;
	const sessionId = cand.sessionId;
	const episodeId = cand.episodeId;
	const expectedCommand = cand.expectedCommand;
	if (typeof toolCallId !== "string" || !toolCallId) return null;
	if (typeof failureFingerprint !== "string" || !failureFingerprint) return null;
	if (typeof projectIdentity !== "string" || !projectIdentity) return null;
	if (typeof sessionId !== "string" || !sessionId) return null;
	if (typeof episodeId !== "string" || !episodeId) return null;
	if (typeof expectedCommand !== "string" || !expectedCommand) return null;
	// summary is bounded redacted metadata, not raw output keywords
	let summary = "";
	if (typeof cand.summary === "string") summary = cand.summary.slice(0, 512);
	else if (typeof cand.content === "string") summary = cand.content.slice(0, 512);
	else if (typeof obj.summary === "string") summary = (obj.summary as string).slice(0, 512);
	return {
		verified: true,
		summary,
		toolCallId,
		expectedCommand,
		failureFingerprint,
		projectIdentity,
		sessionId,
		episodeId,
	};
}

export class CustomAutolearnController {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	readonly #agentDir?: string;
	readonly #svcFactory?: (dir: string) => CustomAutolearnService;
	#svc: CustomAutolearnService | null = null;
	#episodeId: string;
	#observedCount = 0;
	readonly #toolStarts: Map<string, { toolName: string; command: string }> = new Map();

	constructor(options: {
		session: AgentSession;
		settings: Settings;
		agentDir?: string;
		svcFactory?: (dir: string) => CustomAutolearnService;
	}) {
		this.#session = options.session;
		this.#settings = options.settings;
		this.#agentDir = options.agentDir;
		this.#svcFactory = options.svcFactory;
		this.#episodeId =
			(this.#session as unknown as { sessionId?: string }).sessionId ??
			`ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		this.#session.subscribe(event => this.#onEvent(event as AgentSessionEvent));
	}

	#ensureService(): CustomAutolearnService | null {
		if (resolveAutolearnMode(this.#settings) !== "custom") return null;
		if (this.#svc) return this.#svc;
		try {
			if (this.#svcFactory) {
				this.#svc = this.#svcFactory(this.#agentDir ?? "");
			} else {
				this.#svc = new CustomAutolearnService(this.#agentDir as unknown as string | undefined);
			}
		} catch (e) {
			logger.warn("custom autolearn: failed to open service", { error: String(e).slice(0, 512) });
			return null;
		}
		return this.#svc;
	}

	#onEvent(event: AgentSessionEvent): void {
		if (resolveAutolearnMode(this.#settings) !== "custom") return;
		// Capture actual invocation metadata at start
		if (event.type === "tool_execution_start") {
			try {
				const se = event as unknown as { toolCallId: string; toolName: string; args: unknown };
				if (typeof se.toolCallId === "string" && typeof se.toolName === "string") {
					const cmd = extractInvocationCommand(se.toolName, se.args);
					// Bound map size to avoid unbounded growth
					if (this.#toolStarts.size > 200) {
						const oldest = this.#toolStarts.keys().next().value as string | undefined;
						if (oldest) this.#toolStarts.delete(oldest);
					}
					this.#toolStarts.set(se.toolCallId, { toolName: se.toolName, command: cmd });
				}
			} catch {}
			return;
		}
		// Only handle tool execution boundaries in custom mode, top-level bounded.
		if (event.type !== "tool_execution_end") return;
		// Bound: respect taskDepth 0 only to avoid subagent noise; but allow if taskDepth undefined.
		const taskDepth = (this.#session as unknown as { taskDepth?: number }).taskDepth;
		if (typeof taskDepth === "number" && taskDepth !== 0) return;

		const svc = this.#ensureService();
		if (!svc) return;
		let cwd: string;
		try {
			const sess = this.#session as unknown as { sessionManager?: { getCwd?: () => string }; cwd?: string };
			cwd = sess.sessionManager?.getCwd?.() ?? (typeof sess.cwd === "string" && sess.cwd ? sess.cwd : process.cwd());
		} catch {
			cwd = process.cwd();
		}
		const projectIdentity = resolveProjectIdentity(cwd);
		const sessionId = (this.#session as unknown as { sessionId?: string }).sessionId ?? "unknown-session";
		const episodeId = this.#episodeId;

		// Ensure episode exists (bounded metadata)
		try {
			svc.ensureEpisode(episodeId, projectIdentity, sessionId);
		} catch {}

		if (event.isError) {
			if (this.#observedCount >= MAX_CANDIDATES_PER_EPISODE) return;
			// Observe bounded failure candidate
			const failureMessage = boundedFailureMessage(event.result);
			try {
				svc.observeCandidate({
					episodeId,
					sessionId,
					projectIdentity,
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					failureMessage,
					scope: "project",
				});
				this.#observedCount++;
			} catch (e) {
				logger.warn("custom autolearn observe failed", { error: String(e).slice(0, 256) });
			}
			return;
		}

		// Non-error: require reliable structured verifier proof with exact linkage.
		// Never infer verified from isError=false, exit-code, or output-keyword (e.g. "pass", "ok", "success", "0 diagnostics").
		const proof = extractStructuredVerifierProof(event.result);
		if (!proof) return;
		// Bind to actual invocation metadata: retrieve start command and compare
		const startMeta = this.#toolStarts.get(event.toolCallId);
		// Cleanup map entry regardless
		if (startMeta) this.#toolStarts.delete(event.toolCallId);
		const actualCommand = startMeta?.command ?? event.toolName;
		const normalizedActual = actualCommand.trim();
		const normalizedExpected = proof.expectedCommand.trim();
		const isActualAllowlisted = isAllowlistedVerifierCommand(normalizedActual);
		if (!isActualAllowlisted) return;
		const commandsMatch =
			normalizedActual === normalizedExpected ||
			normalizedActual.startsWith(normalizedExpected + " ") ||
			normalizedActual.startsWith(normalizedExpected + "\t");
		if (!commandsMatch) return;
		// Exact linkage: canonical project, session, episode must match current context (using repository-root identity)
		const normalizedProofProject = resolveProjectIdentity(proof.projectIdentity);
		const normalizedCurrentProject = projectIdentity;
		if (normalizedProofProject !== normalizedCurrentProject) return;
		if (proof.sessionId !== sessionId) return;
		if (proof.episodeId !== episodeId) return;
		// ToolCallId and failure fingerprint linkage must match candidate; also bind to actual toolCallId via fingerprint
		// Never treat repository-controlled output keywords as proof: verified must be explicit true already enforced.
		try {
			// Find target candidate by exact toolCallId linkage; fingerprint must also match (service enforces)
			const candidates = svc
				.listCandidates(projectIdentity)
				.filter(
					c =>
						c.sessionId === sessionId &&
						c.episodeId === episodeId &&
						c.status === "pending" &&
						c.toolCallId === proof.toolCallId,
				);
			const target = candidates.find(c => c.failureDigest === proof.failureFingerprint);
			if (!target) return;
			try {
				const verifierName = proof.expectedCommand;
				svc.recordVerifierResult(target.id, verifierName, proof);
			} catch {}
		} catch (e) {
			logger.warn("custom autolearn verifier linkage failed", { error: String(e).slice(0, 256) });
		}
	}

	/** For tests: expose episodeId. */
	get episodeId(): string {
		return this.#episodeId;
	}

	/** For tests: close underlying service if created. */
	close(): void {
		try {
			this.#svc?.close();
		} catch {}
	}

	/** Production startup recovery: invoke durable operation intent reconciliation with current Mnemopi state and same agentDir scope. */
	recoverPendingIntents(mnemopi?: MnemopiProjectionClient | null): number {
		const svc = this.#ensureService();
		if (!svc) return 0;
		let state: unknown = mnemopi;
		if (state === undefined) {
			try {
				const sess = this.#session as unknown as { getMnemopiSessionState?: () => unknown };
				state = sess.getMnemopiSessionState?.() ?? null;
			} catch {
				state = null;
			}
		}
		try {
			const n = svc.recoverOperationIntents(state as never);
			if (n > 0) logger.info("custom autolearn recovery reconciled intents", { recovered: n });
			return n;
		} catch (e) {
			logger.warn("custom autolearn recovery failed", { error: String(e).slice(0, 512) });
			return 0;
		}
}
	}
