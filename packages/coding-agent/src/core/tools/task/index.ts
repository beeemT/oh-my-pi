/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with omp-coding-agent)
 *   - ~/.omp/agent/agents/*.md (user-level)
 *   - .omp/agents/*.md (project-level)
 *
 * Supports:
 *   - Single agent execution
 *   - Parallel execution with concurrency limits
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */

import type { Usage } from "@mariozechner/pi-ai";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Theme } from "../../../modes/interactive/theme/theme";
import taskDescriptionTemplate from "../../../prompts/tools/task.md" with { type: "text" };
import { formatDuration } from "../render-utils";
import { cleanupTempDir, createTempArtifactsDir, getArtifactsDir } from "./artifacts";
import { discoverAgents, getAgent } from "./discovery";
import { runSubprocess } from "./executor";
import { generateTaskName } from "./name-generator";
import { mapWithConcurrencyLimit } from "./parallel";
import { renderCall, renderResult } from "./render";
import {
	type AgentProgress,
	MAX_AGENTS_IN_DESCRIPTION,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	type TaskToolDetails,
	taskSchema,
} from "./types";

// Import review tools for side effects (registers subagent tool handlers)
import "../review";
import type { ToolSession } from "..";

/** Format byte count for display */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export type { AgentDefinition, AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "./types";
export { taskSchema } from "./types";

/**
 * Build dynamic tool description listing available agents.
 */
async function buildDescription(cwd: string): Promise<string> {
	const { agents } = await discoverAgents(cwd);

	// Build agents list
	const agentLines: string[] = [];
	for (const agent of agents.slice(0, MAX_AGENTS_IN_DESCRIPTION)) {
		const tools = agent.tools?.join(", ") || "All tools";
		agentLines.push(`- ${agent.name}: ${agent.description} (Tools: ${tools})`);
	}
	if (agents.length > MAX_AGENTS_IN_DESCRIPTION) {
		agentLines.push(`  ...and ${agents.length - MAX_AGENTS_IN_DESCRIPTION} more agents`);
	}

	// Fill template placeholders
	return taskDescriptionTemplate
		.replace("{{AGENTS_LIST}}", agentLines.join("\n"))
		.replace("{{MAX_PARALLEL_TASKS}}", String(MAX_PARALLEL_TASKS))
		.replace("{{MAX_CONCURRENCY}}", String(MAX_CONCURRENCY));
}

/**
 * Create the task tool configured for a specific session.
 */
export async function createTaskTool(
	session: ToolSession,
): Promise<AgentTool<typeof taskSchema, TaskToolDetails, Theme>> {
	// Check for same-agent blocking (allows other agent types)
	const blockedAgent = process.env.OMP_BLOCKED_AGENT;

	// Build description upfront
	const description = await buildDescription(session.cwd);

	return {
		name: "task",
		label: "Task",
		description,
		parameters: taskSchema,
		renderCall,
		renderResult,
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const startTime = Date.now();
			const { agents, projectAgentsDir } = await discoverAgents(session.cwd);
			const context = params.context;
			const outputSchema = params.output_schema;

			// Handle empty or missing tasks
			if (!params.tasks || params.tasks.length === 0) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `No tasks provided. Use: { tasks: [{agent, task}, ...] }\nAvailable agents: ${available}`,
						},
					],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: 0,
					},
				};
			}

			// Validate task count
			if (params.tasks.length > MAX_PARALLEL_TASKS) {
				return {
					content: [
						{
							type: "text",
							text: `Too many tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
						},
					],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: 0,
					},
				};
			}

			// Derive artifacts directory
			const sessionFile = session.getSessionFile();
			const artifactsDir = sessionFile ? getArtifactsDir(sessionFile) : null;
			const tempArtifactsDir = artifactsDir ? null : createTempArtifactsDir();
			const effectiveArtifactsDir = artifactsDir || tempArtifactsDir!;

			// Initialize progress tracking
			const progressMap = new Map<number, AgentProgress>();

			// Update callback
			const emitProgress = () => {
				const progress = Array.from(progressMap.values()).sort((a, b) => a.index - b.index);
				onUpdate?.({
					content: [{ type: "text", text: `Running ${params.tasks.length} agents...` }],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
						progress,
					},
				});
			};

			try {
				let tasks = params.tasks;
				let skippedSelfRecursion = 0;

				// Filter out blocked agent (self-recursion prevention)
				if (blockedAgent) {
					const blockedTasks = tasks.filter((t) => t.agent === blockedAgent);
					tasks = tasks.filter((t) => t.agent !== blockedAgent);
					skippedSelfRecursion = blockedTasks.length;

					if (skippedSelfRecursion > 0 && tasks.length === 0) {
						return {
							content: [
								{
									type: "text",
									text: `Cannot spawn ${blockedAgent} agent from within itself (recursion prevention). Use a different agent type.`,
								},
							],
							details: {
								projectAgentsDir,
								results: [],
								totalDurationMs: Date.now() - startTime,
							},
						};
					}
				}

				// Validate all agents exist
				for (const task of tasks) {
					if (!getAgent(agents, task.agent)) {
						const available = agents.map((a) => a.name).join(", ");
						return {
							content: [{ type: "text", text: `Unknown agent: ${task.agent}. Available: ${available}` }],
							details: {
								projectAgentsDir,
								results: [],
								totalDurationMs: Date.now() - startTime,
							},
						};
					}
				}

				// Check spawn restrictions from parent
				const parentSpawns = session.getSessionSpawns() ?? "*";
				const allowedSpawns = parentSpawns.split(",").map((s) => s.trim());
				const isSpawnAllowed = (agentName: string): boolean => {
					if (parentSpawns === "") return false; // Empty = deny all
					if (parentSpawns === "*") return true; // Wildcard = allow all
					return allowedSpawns.includes(agentName);
				};

				for (const task of tasks) {
					if (!isSpawnAllowed(task.agent)) {
						const allowed = parentSpawns === "" ? "none (spawns disabled for this agent)" : parentSpawns;
						return {
							content: [{ type: "text", text: `Cannot spawn '${task.agent}'. Allowed: ${allowed}` }],
							details: {
								projectAgentsDir,
								results: [],
								totalDurationMs: Date.now() - startTime,
							},
						};
					}
				}

				// Build full prompts with context prepended and generate task IDs
				const tasksWithContext = tasks.map((t) => ({
					agent: t.agent,
					task: context ? `${context}\n\n${t.task}` : t.task,
					model: t.model,
					description: t.description,
					taskId: generateTaskName(),
				}));

				// Initialize progress for all tasks
				for (let i = 0; i < tasksWithContext.length; i++) {
					const t = tasksWithContext[i];
					const agentCfg = getAgent(agents, t.agent);
					progressMap.set(i, {
						index: i,
						taskId: t.taskId,
						agent: t.agent,
						agentSource: agentCfg?.source ?? "user",
						status: "pending",
						task: t.task,
						recentTools: [],
						recentOutput: [],
						toolCount: 0,
						tokens: 0,
						durationMs: 0,
						modelOverride: t.model,
						description: t.description,
					});
				}
				emitProgress();

				// Execute in parallel with concurrency limit
				const results = await mapWithConcurrencyLimit(tasksWithContext, MAX_CONCURRENCY, async (task, index) => {
					const agent = getAgent(agents, task.agent)!;
					return runSubprocess({
						cwd: session.cwd,
						agent,
						task: task.task,
						description: task.description,
						index,
						taskId: task.taskId,
						context: undefined, // Already prepended above
						modelOverride: task.model,
						outputSchema,
						sessionFile,
						persistArtifacts: !!artifactsDir,
						artifactsDir: effectiveArtifactsDir,
						signal,
						eventBus: undefined,
						onProgress: (progress) => {
							progressMap.set(index, structuredClone(progress));
							emitProgress();
						},
					});
				});

				// Aggregate usage from executor results (already accumulated incrementally)
				const aggregatedUsage = createUsageTotals();
				let hasAggregatedUsage = false;
				for (const result of results) {
					if (result.usage) {
						addUsageTotals(aggregatedUsage, result.usage);
						hasAggregatedUsage = true;
					}
				}

				// Collect output paths (artifacts already written by executor in real-time)
				const outputPaths: string[] = [];
				for (const result of results) {
					if (result.artifactPaths) {
						outputPaths.push(result.artifactPaths.outputPath);
					}
				}

				// Build final output - match plugin format
				const successCount = results.filter((r) => r.exitCode === 0).length;
				const totalDuration = Date.now() - startTime;

				const summaries = results.map((r) => {
					const status = r.exitCode === 0 ? "completed" : `failed (exit ${r.exitCode})`;
					const output = r.output.trim() || r.stderr.trim() || "(no output)";
					const preview = output.split("\n").slice(0, 5).join("\n");
					const meta = r.outputMeta
						? ` [${r.outputMeta.lineCount} lines, ${formatBytes(r.outputMeta.charCount)}]`
						: "";
					return `[${r.agent}] ${status}${meta} ${r.taskId}\n${preview}`;
				});

				const skippedNote =
					skippedSelfRecursion > 0
						? ` (${skippedSelfRecursion} ${blockedAgent} task${skippedSelfRecursion > 1 ? "s" : ""} skipped - self-recursion blocked)`
						: "";
				const outputIds = results.map((r) => r.taskId);
				const outputHint =
					outputIds.length > 0 ? `\n\nUse output tool for full logs: output ids ${outputIds.join(", ")}` : "";
				const summary = `${successCount}/${results.length} succeeded${skippedNote} [${formatDuration(
					totalDuration,
				)}]\n\n${summaries.join("\n\n---\n\n")}${outputHint}`;

				// Cleanup temp directory if used
				if (tempArtifactsDir) {
					await cleanupTempDir(tempArtifactsDir);
				}

				return {
					content: [{ type: "text", text: summary }],
					details: {
						projectAgentsDir,
						results: results,
						totalDurationMs: totalDuration,
						usage: hasAggregatedUsage ? aggregatedUsage : undefined,
						outputPaths,
					},
				};
			} catch (err) {
				// Cleanup temp directory on error
				if (tempArtifactsDir) {
					await cleanupTempDir(tempArtifactsDir);
				}

				return {
					content: [{ type: "text", text: `Task execution failed: ${err}` }],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}
		},
	};
}

// Default task tool - returns a placeholder tool
// Real implementations should use createTaskTool(session) to initialize the tool
export const taskTool: AgentTool<typeof taskSchema, TaskToolDetails, Theme> = {
	name: "task",
	label: "Task",
	description: "Launch a new agent to handle complex, multi-step tasks autonomously.",
	parameters: taskSchema,
	execute: async () => ({
		content: [{ type: "text", text: "Task tool not properly initialized. Use createTaskTool(session) instead." }],
		details: {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
		},
	}),
};
