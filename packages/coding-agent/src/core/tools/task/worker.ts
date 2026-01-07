/**
 * Worker thread for subagent execution.
 *
 * This worker runs in a separate thread via Bun's Worker API. It creates a minimal
 * AgentSession and forwards events back to the parent thread.
 *
 * ## Event Flow
 *
 * 1. Parent sends { type: "start", payload } with task config
 * 2. Worker creates AgentSession and subscribes to events
 * 3. Worker forwards AgentEvent messages via postMessage
 * 4. Worker sends { type: "done", exitCode, ... } on completion
 * 5. Parent can send { type: "abort" } to request cancellation
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentEvent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "../../agent-session";
import { parseModelPattern, parseModelString } from "../../model-resolver";
import { createAgentSession, discoverAuthStorage, discoverModels } from "../../sdk";
import { SessionManager } from "../../session-manager";
import type { SubagentWorkerRequest, SubagentWorkerResponse, SubagentWorkerStartPayload } from "./worker-protocol";

type PostMessageFn = (message: SubagentWorkerResponse) => void;

const postMessageSafe: PostMessageFn = (message) => {
	(globalThis as typeof globalThis & { postMessage: PostMessageFn }).postMessage(message);
};

interface WorkerMessageEvent<T> {
	data: T;
}

/** Agent event types to forward to parent (excludes session-only events like compaction) */
const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

const isAgentEvent = (event: AgentSessionEvent): event is AgentEvent => {
	return agentEventTypes.has(event.type as AgentEvent["type"]);
};

let running = false;
let abortRequested = false;
let activeSession: { abort: () => Promise<void>; dispose: () => Promise<void> } | null = null;

/**
 * Resolve model string to Model object with optional thinking level.
 * Supports both exact "provider/id" format and fuzzy matching ("sonnet", "opus").
 */
function resolveModelOverride(
	override: string | undefined,
	modelRegistry: { getAvailable: () => Model<Api>[]; find: (provider: string, id: string) => Model<Api> | undefined },
): { model?: Model<Api>; thinkingLevel?: ThinkingLevel } {
	if (!override) return {};

	// Try exact "provider/id" format first
	const parsed = parseModelString(override);
	if (parsed) {
		return { model: modelRegistry.find(parsed.provider, parsed.id) };
	}

	// Fall back to fuzzy pattern matching
	const result = parseModelPattern(override, modelRegistry.getAvailable());
	return {
		model: result.model,
		thinkingLevel: result.thinkingLevel !== "off" ? result.thinkingLevel : undefined,
	};
}

/**
 * Main task execution function.
 *
 * Equivalent to CLI flow:
 * 1. omp --mode json --non-interactive
 * 2. --append-system-prompt <agent.systemPrompt>
 * 3. --tools <toolNames> (if specified)
 * 4. --model <model> (if specified)
 * 5. --session <sessionFile> OR --no-session
 * 6. --prompt <task>
 *
 * Environment equivalent:
 * - OMP_BLOCKED_AGENT: payload.blockedAgent (prevents same-agent recursion)
 * - OMP_SPAWNS: payload.spawnsEnv (controls nested spawn permissions)
 */
async function runTask(payload: SubagentWorkerStartPayload): Promise<void> {
	const startTime = Date.now();
	let exitCode = 0;
	let error: string | undefined;
	let aborted = false;

	try {
		// Check for pre-start abort
		if (abortRequested) {
			aborted = true;
			exitCode = 1;
			return;
		}

		// Set working directory (CLI does this implicitly)
		process.chdir(payload.cwd);

		// Discover auth and models (equivalent to CLI's discoverAuthStorage/discoverModels)
		const authStorage = await discoverAuthStorage();
		const modelRegistry = await discoverModels(authStorage);

		// Resolve model override (equivalent to CLI's parseModelPattern with --model)
		const { model, thinkingLevel } = resolveModelOverride(payload.model, modelRegistry);

		// Create session manager (equivalent to CLI's --session or --no-session)
		const sessionManager = payload.sessionFile
			? await SessionManager.open(payload.sessionFile)
			: SessionManager.inMemory(payload.cwd);

		// Create agent session (equivalent to CLI's createAgentSession)
		// Note: hasUI: false disables interactive features
		const completionInstruction =
			"When finished, call the complete tool exactly once. Do not end with a plain-text final answer.";

		const { session } = await createAgentSession({
			cwd: payload.cwd,
			authStorage,
			modelRegistry,
			model,
			thinkingLevel,
			toolNames: payload.toolNames,
			outputSchema: payload.outputSchema,
			requireCompleteTool: true,
			// Append system prompt (equivalent to CLI's --append-system-prompt)
			systemPrompt: (defaultPrompt) => `${defaultPrompt}\n\n${payload.systemPrompt}\n\n${completionInstruction}`,
			sessionManager,
			hasUI: false,
			// Pass spawn restrictions to nested tasks
			spawns: payload.spawnsEnv,
		});

		activeSession = session;

		// Initialize extensions (equivalent to CLI's extension initialization)
		// Note: Does not support --extension CLI flag or extension CLI flags
		const extensionRunner = session.extensionRunner;
		if (extensionRunner) {
			extensionRunner.initialize({
				getModel: () => session.model,
				sendMessageHandler: (message, options) => {
					session.sendCustomMessage(message, options).catch((e) => {
						console.error(`Extension sendMessage failed: ${e instanceof Error ? e.message : String(e)}`);
					});
				},
				appendEntryHandler: (customType, data) => {
					session.sessionManager.appendCustomEntry(customType, data);
				},
				getActiveToolsHandler: () => session.getActiveToolNames(),
				getAllToolsHandler: () => session.getAllToolNames(),
				setActiveToolsHandler: (toolNamesList: string[]) => session.setActiveToolsByName(toolNamesList),
			});
			extensionRunner.onError((err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			});
			await extensionRunner.emit({ type: "session_start" });
		}

		// Track complete tool calls
		const MAX_COMPLETE_RETRIES = 3;
		let completeCalled = false;

		// Subscribe to events and forward to parent (equivalent to --mode json output)
		session.subscribe((event: AgentSessionEvent) => {
			if (isAgentEvent(event)) {
				postMessageSafe({ type: "event", event });
				// Track when complete tool is called
				if (event.type === "tool_execution_end" && event.toolName === "complete") {
					completeCalled = true;
				}
			}
		});

		// Run the prompt (equivalent to --prompt flag)
		await session.prompt(payload.task);

		// Retry loop if complete was not called
		let retryCount = 0;
		while (!completeCalled && retryCount < MAX_COMPLETE_RETRIES && !abortRequested) {
			retryCount++;
			const reminder = `<system-reminder>
CRITICAL: You stopped without calling the complete tool. This is reminder ${retryCount} of ${MAX_COMPLETE_RETRIES}.

You MUST call the complete tool to finish your task. Options:
1. Call complete with your result data if you have completed the task
2. Call complete with status="aborted" and an error message if you cannot complete the task

Failure to call complete after ${MAX_COMPLETE_RETRIES} reminders will result in task failure.
</system-reminder>

Call complete now.`;

			await session.prompt(reminder);
		}

		// Check if aborted during execution
		const lastMessage = session.state.messages[session.state.messages.length - 1];
		if (lastMessage?.role === "assistant" && lastMessage.stopReason === "aborted") {
			aborted = true;
			exitCode = 1;
		}
	} catch (err) {
		exitCode = 1;
		error = err instanceof Error ? err.stack || err.message : String(err);
	} finally {
		// Handle abort requested during execution
		if (abortRequested) {
			aborted = true;
			if (exitCode === 0) exitCode = 1;
		}

		// Cleanup session
		if (activeSession) {
			try {
				await activeSession.dispose();
			} catch {
				// Ignore cleanup errors
			}
			activeSession = null;
		}

		// Send completion message to parent
		postMessageSafe({
			type: "done",
			exitCode,
			durationMs: Date.now() - startTime,
			error,
			aborted,
		});
	}
}

/** Handle abort request from parent */
function handleAbort(): void {
	abortRequested = true;
	if (activeSession) {
		void activeSession.abort();
	}
}

// Message handler - receives start/abort commands from parent
globalThis.addEventListener("message", (event: WorkerMessageEvent<SubagentWorkerRequest>) => {
	const message = event.data;
	if (!message) return;

	if (message.type === "abort") {
		handleAbort();
		return;
	}

	if (message.type === "start") {
		// Only allow one task per worker
		if (running) return;
		running = true;
		void runTask(message.payload);
	}
});
