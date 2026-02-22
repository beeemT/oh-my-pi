/**
 * ScriptTool — programmatic tool calling via a sandboxed JavaScript subprocess.
 *
 * The model writes JavaScript code that calls other registered tools as async
 * functions. The code runs in a child Bun process that has no access to the
 * parent's environment variables (API keys, auth tokens, etc.). Tool calls are
 * bridged via a short-lived localhost HTTP server (ToolBridgeServer) that
 * performs live tool lookups, so tools activated after startup (dynamic MCP
 * servers) are accessible through the `tools` proxy inside the script.
 *
 * See script-bridge.ts for the bridge server and script-worker.ts for the
 * subprocess entry point.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import scriptDescription from "../prompts/tools/script.md" with { type: "text" };
import type { ToolSession } from "./index";
import { ToolBridgeServer } from "./script-bridge";
import { ToolAbortError } from "./tool-errors";

// ── Schema ────────────────────────────────────────────────────────────────────

const scriptSchema = Type.Object({
	code: Type.String({
		description:
			"JavaScript code to execute. Named async tool functions (bash, read, write, edit, grep, find, fetch, web_search, lsp, browser, …) are available directly. Use `await tools.name(args)` for MCP or dynamically loaded tools. Call `listTools()` to discover all available tools. Use `return` or `console.log` for output.",
	}),
	timeout: Type.Optional(Type.Number({ description: "Maximum execution time in seconds (default: 30)" })),
});

type ScriptParams = Static<typeof scriptSchema>;

export interface ScriptToolDetails {
	exitCode: number | undefined;
	stderr?: string;
}

// ── Tools excluded from the script environment ────────────────────────────────
//
// ask      — blocks waiting for user input; meaningless inside an automated script
// task     — spawns an LLM subagent; recursive LLM calls inside code would be
//            extremely expensive and are better expressed as top-level tool calls
// script   — no recursion
// poll_jobs / cancel_job — job lifecycle belongs outside the script
// submit_result / report_finding / exit_plan_mode — agent lifecycle signals

const EXCLUDED_TOOLS = new Set([
	"script",
	"ask",
	"task",
	"poll_jobs",
	"cancel_job",
	"submit_result",
	"report_finding",
	"exit_plan_mode",
]);

// ── Safe environment for the subprocess ──────────────────────────────────────
//
// Deliberately excludes API keys, auth tokens, and session secrets.
// The subprocess can still use Bun's full API surface for filesystem / network
// operations, but it cannot read secrets from the environment.

function buildSafeEnv(bridgePort: number, scriptFile: string): Record<string, string> {
	const env: Record<string, string> = {
		OMP_BRIDGE_PORT: String(bridgePort),
		OMP_SCRIPT_FILE: scriptFile,
	};
	// Passthrough: minimal set needed for Bun to locate itself and basic OS ops.
	// Intentionally does NOT include any key that looks like a secret.
	const passthrough = [
		"HOME",
		"PATH",
		"TMPDIR",
		"TMP",
		"TEMP",
		"SHELL",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"USER",
		"LOGNAME",
		"BUN_INSTALL",
		"BUN_RUNTIME_TRANSPILER_CACHE_PATH",
	] as const;
	for (const key of passthrough) {
		const val = process.env[key];
		if (val !== undefined) env[key] = val;
	}
	return env;
}

// ── ScriptTool ────────────────────────────────────────────────────────────────

export class ScriptTool implements AgentTool<typeof scriptSchema, ScriptToolDetails> {
	readonly name = "script";
	readonly label = "Script";
	readonly description = scriptDescription;
	readonly parameters = scriptSchema;

	constructor(private readonly session: ToolSession) {}

	static create(session: ToolSession): ScriptTool {
		return new ScriptTool(session);
	}

	async execute(
		_toolCallId: string,
		params: ScriptParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ScriptToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<ScriptToolDetails>> {
		const timeoutMs = (params.timeout ?? 30) * 1000;

		// Combine the parent abort signal with a per-execution timeout
		const timeoutController = new AbortController();
		const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
		const effectiveSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;

		// Only expose tools that make sense inside a script
		const getFilteredTools = () => {
			const all = this.session.getTools?.() ?? [];
			return all.filter(t => !EXCLUDED_TOOLS.has(t.name));
		};

		const bridge = new ToolBridgeServer();
		let tmpFile: string | null = null;

		try {
			const bridgePort = await bridge.start(getFilteredTools, effectiveSignal, context);

			// Write the script code to an isolated temp file
			tmpFile = path.join(os.tmpdir(), `omp-script-${crypto.randomUUID()}.ts`);
			await Bun.write(tmpFile, params.code);

			const workerPath = path.join(import.meta.dir, "script-worker.ts");

			const child = Bun.spawn(["bun", "run", workerPath], {
				env: buildSafeEnv(bridgePort, tmpFile),
				stdout: "pipe",
				stderr: "pipe",
			});

			// Kill the child if the effective signal fires (timeout or parent abort)
			const onAbort = () => {
				try {
					child.kill();
				} catch {
					// Already exited — ignore
				}
			};
			effectiveSignal.addEventListener("abort", onAbort, { once: true });

			const exitCode = await child.exited;

			effectiveSignal.removeEventListener("abort", onAbort);
			clearTimeout(timeoutHandle);

			if (signal?.aborted) {
				throw new ToolAbortError();
			}

			if (timeoutController.signal.aborted) {
				return {
					content: [
						{
							type: "text",
							text: `Script timed out after ${params.timeout ?? 30}s`,
						},
					],
					details: { exitCode: undefined },
				};
			}

			const stdout = await new Response(child.stdout as ReadableStream).text();
			const stderr = await new Response(child.stderr as ReadableStream).text();

			logger.debug("Script execution complete", { exitCode, stdoutLen: stdout.length });

			if (exitCode !== 0) {
				const errorText = stderr.trim() || `Script exited with code ${exitCode}`;
				return {
					content: [{ type: "text", text: errorText }],
					details: { exitCode, stderr: stderr.trim() || undefined },
				};
			}

			return {
				content: [{ type: "text", text: stdout.trim() || "(no output)" }],
				details: {
					exitCode: 0,
					stderr: stderr.trim() || undefined,
				},
			};
		} catch (err) {
			clearTimeout(timeoutHandle);
			if (err instanceof ToolAbortError) throw err;
			if (signal?.aborted) throw new ToolAbortError();
			const message = err instanceof Error ? err.message : String(err);
			logger.error("Script tool execution failed", { error: message });
			return {
				content: [{ type: "text", text: `Script execution failed: ${message}` }],
				details: { exitCode: undefined },
			};
		} finally {
			clearTimeout(timeoutHandle);
			bridge.stop();
			if (tmpFile) {
				try {
					await fs.unlink(tmpFile);
				} catch {
					// Ignore cleanup failures
				}
			}
		}
	}
}
