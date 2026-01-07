/**
 * Worker execution for subagents.
 *
 * Runs each subagent in a Bun Worker and forwards AgentEvents for progress tracking.
 */

import { writeFileSync } from "node:fs";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { EventBus } from "../../event-bus";
import { ensureArtifactsDir, getArtifactPaths } from "./artifacts";
import { resolveModelPattern } from "./model-resolver";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import {
	type AgentDefinition,
	type AgentProgress,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	type SingleResult,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "./types";
import type { SubagentWorkerRequest, SubagentWorkerResponse } from "./worker-protocol";

/** Options for worker execution */
export interface ExecutorOptions {
	cwd: string;
	agent: AgentDefinition;
	task: string;
	description?: string;
	index: number;
	taskId: string;
	context?: string;
	modelOverride?: string;
	outputSchema?: unknown;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	sessionFile?: string | null;
	persistArtifacts?: boolean;
	artifactsDir?: string;
	eventBus?: EventBus;
}

/**
 * Truncate output to byte and line limits.
 */
function truncateOutput(output: string): { text: string; truncated: boolean } {
	let truncated = false;
	let byteBudget = MAX_OUTPUT_BYTES;
	let lineBudget = MAX_OUTPUT_LINES;

	let i = 0;
	let lastNewlineIndex = -1;
	while (i < output.length && byteBudget > 0) {
		const ch = output.charCodeAt(i);
		byteBudget--;

		if (ch === 10 /* \n */) {
			lineBudget--;
			lastNewlineIndex = i;
			if (lineBudget <= 0) {
				truncated = true;
				break;
			}
		}

		i++;
	}

	if (i < output.length) {
		truncated = true;
	}

	if (truncated && lineBudget <= 0 && lastNewlineIndex >= 0) {
		output = output.slice(0, lastNewlineIndex);
	} else {
		output = output.slice(0, i);
	}

	return { text: output, truncated };
}

/**
 * Extract a short preview from tool args for display.
 */
function extractToolArgsPreview(args: Record<string, unknown>): string {
	// Priority order for preview
	const previewKeys = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"];

	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return value.length > 60 ? `${value.slice(0, 57)}...` : value;
		}
	}

	return "";
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
	if (!Object.hasOwn(record, key)) return undefined;
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstNumberField(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = getNumberField(record, key);
		if (value !== undefined) return value;
	}
	return undefined;
}

/**
 * Normalize usage objects from different event formats.
 */
function getUsageTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const record = usage as Record<string, unknown>;

	const totalTokens = firstNumberField(record, ["totalTokens", "total_tokens"]);
	if (totalTokens !== undefined && totalTokens > 0) return totalTokens;

	const input = firstNumberField(record, ["input", "input_tokens", "inputTokens"]) ?? 0;
	const output = firstNumberField(record, ["output", "output_tokens", "outputTokens"]) ?? 0;
	const cacheRead = firstNumberField(record, ["cacheRead", "cache_read", "cacheReadTokens"]) ?? 0;
	const cacheWrite = firstNumberField(record, ["cacheWrite", "cache_write", "cacheWriteTokens"]) ?? 0;

	return input + output + cacheRead + cacheWrite;
}

/**
 * Run a single agent in a worker.
 */
export async function runSubprocess(options: ExecutorOptions): Promise<SingleResult> {
	const { cwd, agent, task, index, taskId, context, modelOverride, outputSchema, signal, onProgress } = options;
	const startTime = Date.now();

	// Initialize progress
	const progress: AgentProgress = {
		index,
		taskId,
		agent: agent.name,
		agentSource: agent.source,
		status: "running",
		task,
		description: options.description,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		modelOverride,
	};

	// Check if already aborted
	if (signal?.aborted) {
		return {
			index,
			taskId,
			agent: agent.name,
			agentSource: agent.source,
			task,
			description: options.description,
			exitCode: 1,
			output: "",
			stderr: "Aborted before start",
			truncated: false,
			durationMs: 0,
			tokens: 0,
			modelOverride,
			error: "Aborted",
		};
	}

	// Build full task with context
	const fullTask = context ? `${context}\n\n${task}` : task;

	// Set up artifact paths and write input file upfront if artifacts dir provided
	let artifactPaths: { inputPath: string; outputPath: string; jsonlPath: string } | undefined;
	let subtaskSessionFile: string | undefined;

	if (options.artifactsDir) {
		ensureArtifactsDir(options.artifactsDir);
		artifactPaths = getArtifactPaths(options.artifactsDir, taskId);
		subtaskSessionFile = artifactPaths.jsonlPath;

		// Write input file immediately (real-time visibility)
		try {
			writeFileSync(artifactPaths.inputPath, fullTask, "utf-8");
		} catch {
			// Non-fatal, continue without input artifact
		}
	}

	// Add tools if specified
	let toolNames: string[] | undefined;
	if (agent.tools && agent.tools.length > 0) {
		toolNames = agent.tools;
		// Auto-include task tool if spawns defined but task not in tools
		if (agent.spawns !== undefined && !toolNames.includes("task")) {
			toolNames = [...toolNames, "task"];
		}
	}

	// Resolve and add model
	const resolvedModel = resolveModelPattern(modelOverride || agent.model);
	const sessionFile = subtaskSessionFile ?? options.sessionFile ?? null;
	const spawnsEnv = agent.spawns === undefined ? "" : agent.spawns === "*" ? "*" : agent.spawns.join(",");

	const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

	let output = "";
	let stderr = "";
	let finalOutput = "";
	let resolved = false;
	let pendingTermination = false; // Set when shouldTerminate fires, wait for message_end

	// Accumulate usage incrementally from message_end events (no memory for streaming events)
	const accumulatedUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let hasUsage = false;

	let abortSent = false;
	const requestAbort = () => {
		if (abortSent) return;
		abortSent = true;
		const abortMessage: SubagentWorkerRequest = { type: "abort" };
		worker.postMessage(abortMessage);
		setTimeout(() => {
			if (!resolved) {
				worker.terminate();
			}
		}, 2000);
	};

	// Handle abort signal
	const onAbort = () => {
		if (!resolved) requestAbort();
	};
	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	const emitProgress = () => {
		progress.durationMs = Date.now() - startTime;
		onProgress?.({ ...progress });
		if (options.eventBus) {
			options.eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index,
				agent: agent.name,
				agentSource: agent.source,
				task,
				progress: { ...progress },
			});
		}
	};

	const getMessageContent = (message: unknown): unknown => {
		if (message && typeof message === "object" && "content" in message) {
			return (message as { content?: unknown }).content;
		}
		return undefined;
	};

	const getMessageUsage = (message: unknown): unknown => {
		if (message && typeof message === "object" && "usage" in message) {
			return (message as { usage?: unknown }).usage;
		}
		return undefined;
	};

	const processEvent = (event: AgentEvent) => {
		if (resolved) return;

		if (options.eventBus) {
			options.eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
				index,
				agent: agent.name,
				agentSource: agent.source,
				task,
				event,
			});
		}

		const now = Date.now();

		switch (event.type) {
			case "tool_execution_start":
				progress.toolCount++;
				progress.currentTool = event.toolName;
				progress.currentToolArgs = extractToolArgsPreview(
					(event as { toolArgs?: Record<string, unknown> }).toolArgs || event.args || {},
				);
				progress.currentToolStartMs = now;
				break;

			case "tool_execution_end": {
				if (progress.currentTool) {
					progress.recentTools.unshift({
						tool: progress.currentTool,
						args: progress.currentToolArgs || "",
						endMs: now,
					});
					// Keep only last 5
					if (progress.recentTools.length > 5) {
						progress.recentTools.pop();
					}
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartMs = undefined;

				// Check for registered subagent tool handler
				const handler = subprocessToolRegistry.getHandler(event.toolName);
				const eventArgs = (event as { args?: Record<string, unknown> }).args ?? {};
				if (handler) {
					// Extract data using handler
					if (handler.extractData) {
						const data = handler.extractData({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						});
						if (data !== undefined) {
							progress.extractedToolData = progress.extractedToolData || {};
							progress.extractedToolData[event.toolName] = progress.extractedToolData[event.toolName] || [];
							progress.extractedToolData[event.toolName].push(data);
						}
					}

					// Check if handler wants to terminate worker
					if (
						handler.shouldTerminate?.({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						})
					) {
						// Don't terminate immediately - wait for message_end to get token counts
						pendingTermination = true;
						// Safety timeout in case message_end never arrives
						setTimeout(() => {
							if (!resolved) {
								requestAbort();
							}
						}, 2000);
					}
				}
				break;
			}

			case "message_update": {
				// Extract text for progress display only (replace, don't accumulate)
				const updateContent =
					getMessageContent(event.message) || (event as AgentEvent & { content?: unknown }).content;
				if (updateContent && Array.isArray(updateContent)) {
					const allText: string[] = [];
					for (const block of updateContent) {
						if (block.type === "text" && block.text) {
							const lines = block.text.split("\n").filter((l: string) => l.trim());
							allText.push(...lines);
						}
					}
					// Show last 8 lines from current state (not accumulated)
					progress.recentOutput = allText.slice(-8).reverse();
				}
				break;
			}

			case "message_end": {
				// Extract text from assistant and toolResult messages (not user prompts)
				const role = event.message?.role;
				if (role === "assistant") {
					const messageContent =
						getMessageContent(event.message) || (event as AgentEvent & { content?: unknown }).content;
					if (messageContent && Array.isArray(messageContent)) {
						for (const block of messageContent) {
							if (block.type === "text" && block.text) {
								output += block.text;
							}
						}
					}
				}
				// Extract and accumulate usage (prefer message.usage, fallback to event.usage)
				const messageUsage = getMessageUsage(event.message) || (event as AgentEvent & { usage?: unknown }).usage;
				if (messageUsage && typeof messageUsage === "object") {
					// Only count assistant messages (not tool results, etc.)
					if (
						role === "assistant" &&
						event.message?.stopReason !== "aborted" &&
						event.message?.stopReason !== "error"
					) {
						const usageRecord = messageUsage as Record<string, number | undefined>;
						const costRecord = (messageUsage as { cost?: Record<string, number | undefined> }).cost;
						hasUsage = true;
						accumulatedUsage.input += usageRecord.input ?? 0;
						accumulatedUsage.output += usageRecord.output ?? 0;
						accumulatedUsage.cacheRead += usageRecord.cacheRead ?? 0;
						accumulatedUsage.cacheWrite += usageRecord.cacheWrite ?? 0;
						accumulatedUsage.totalTokens += usageRecord.totalTokens ?? 0;
						if (costRecord) {
							accumulatedUsage.cost.input += costRecord.input ?? 0;
							accumulatedUsage.cost.output += costRecord.output ?? 0;
							accumulatedUsage.cost.cacheRead += costRecord.cacheRead ?? 0;
							accumulatedUsage.cost.cacheWrite += costRecord.cacheWrite ?? 0;
							accumulatedUsage.cost.total += costRecord.total ?? 0;
						}
					}
					// Accumulate tokens for progress display
					progress.tokens += getUsageTokens(messageUsage);
				}
				// If pending termination, now we have tokens - terminate
				if (pendingTermination && !resolved) {
					requestAbort();
				}
				break;
			}

			case "agent_end":
				// Extract final content from assistant messages only (not user prompts)
				if (event.messages && Array.isArray(event.messages)) {
					for (const msg of event.messages) {
						if ((msg as { role?: string })?.role !== "assistant") continue;
						const messageContent = getMessageContent(msg);
						if (messageContent && Array.isArray(messageContent)) {
							for (const block of messageContent) {
								if (block.type === "text" && block.text) {
									finalOutput += block.text;
								}
							}
						}
					}
				}
				break;
		}

		emitProgress();
	};

	const startMessage: SubagentWorkerRequest = {
		type: "start",
		payload: {
			cwd,
			task: fullTask,
			systemPrompt: agent.systemPrompt,
			model: resolvedModel,
			toolNames,
			outputSchema,
			sessionFile,
			spawnsEnv,
		},
	};

	interface WorkerMessageEvent<T> {
		data: T;
	}
	interface WorkerErrorEvent {
		message: string;
	}

	const done = await new Promise<Extract<SubagentWorkerResponse, { type: "done" }>>((resolve) => {
		const onMessage = (event: WorkerMessageEvent<SubagentWorkerResponse>) => {
			const message = event.data;
			if (!message || resolved) return;
			if (message.type === "event") {
				processEvent(message.event);
				return;
			}
			if (message.type === "done") {
				resolved = true;
				resolve(message);
			}
		};
		const onError = (event: WorkerErrorEvent) => {
			if (resolved) return;
			resolved = true;
			resolve({
				type: "done",
				exitCode: 1,
				durationMs: Date.now() - startTime,
				error: event.message,
			});
		};
		worker.addEventListener("message", onMessage);
		worker.addEventListener("error", onError);
		worker.postMessage(startMessage);
	});

	// Cleanup
	if (signal) {
		signal.removeEventListener("abort", onAbort);
	}
	worker.terminate();

	let exitCode = done.exitCode;
	if (done.error) {
		stderr = done.error;
	}

	// Use final output if available, otherwise accumulated output
	let rawOutput = finalOutput || output;
	let abortedViaComplete = false;
	const completeItems = progress.extractedToolData?.complete as
		| Array<{ data?: unknown; status?: "success" | "aborted"; error?: string }>
		| undefined;
	const hasComplete = Array.isArray(completeItems) && completeItems.length > 0;
	if (hasComplete) {
		const lastComplete = completeItems[completeItems.length - 1];
		if (lastComplete?.status === "aborted") {
			// Agent explicitly aborted via complete tool - clean exit with error info
			abortedViaComplete = true;
			exitCode = 0;
			stderr = lastComplete.error || "Subagent aborted task";
			try {
				rawOutput = JSON.stringify({ aborted: true, error: lastComplete.error }, null, 2);
			} catch {
				rawOutput = `{"aborted":true,"error":"${lastComplete.error || "Unknown error"}"}`;
			}
		} else {
			// Normal successful completion
			const completeData = lastComplete?.data ?? null;
			try {
				rawOutput = JSON.stringify(completeData, null, 2) ?? "null";
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				rawOutput = `{"error":"Failed to serialize complete data: ${errorMessage}"}`;
			}
			exitCode = 0;
			stderr = "";
		}
	} else {
		const warning = "SYSTEM WARNING: Subagent exited without calling complete tool after 3 reminders.";
		rawOutput = rawOutput ? `${warning}\n\n${rawOutput}` : warning;
	}
	const { text: truncatedOutput, truncated } = truncateOutput(rawOutput);

	// Write output artifact (input and jsonl already written in real-time)
	// Compute output metadata for Output tool integration
	let outputMeta: { lineCount: number; charCount: number } | undefined;
	if (artifactPaths) {
		try {
			writeFileSync(artifactPaths.outputPath, rawOutput, "utf-8");
			outputMeta = {
				lineCount: rawOutput.split("\n").length,
				charCount: rawOutput.length,
			};
		} catch {
			// Non-fatal
		}
	}

	// Update final progress
	const wasAborted = abortedViaComplete || (!hasComplete && (done.aborted || signal?.aborted || false));
	progress.status = wasAborted ? "aborted" : exitCode === 0 ? "completed" : "failed";
	emitProgress();

	return {
		index,
		taskId,
		agent: agent.name,
		agentSource: agent.source,
		task,
		description: options.description,
		exitCode,
		output: truncatedOutput,
		stderr,
		truncated,
		durationMs: Date.now() - startTime,
		tokens: progress.tokens,
		modelOverride,
		error: exitCode !== 0 && stderr ? stderr : undefined,
		aborted: wasAborted,
		usage: hasUsage ? accumulatedUsage : undefined,
		artifactPaths,
		extractedToolData: progress.extractedToolData,
		outputMeta,
	};
}
