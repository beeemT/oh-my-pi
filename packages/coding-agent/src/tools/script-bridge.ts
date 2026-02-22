/**
 * HTTP bridge server for programmatic tool calling from script-worker subprocesses.
 *
 * Exposes registered AgentTools over a localhost HTTP API so that the sandboxed
 * script worker can invoke them without inheriting the parent process environment.
 */
import * as net from "node:net";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { validateToolArguments } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";

/** Allocate a free TCP port by briefly binding to port 0. */
function allocatePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const server = net.createServer();
	server.unref();
	server.on("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (address && typeof address === "object") {
			const port = address.port;
			server.close(err => {
				if (err) reject(err);
				else resolve(port);
			});
		} else {
			server.close();
			reject(new Error("Failed to allocate port for script bridge"));
		}
	});
	return promise;
}

/** Tool descriptor returned by the /tools endpoint. */
export interface BridgeToolInfo {
	name: string;
	description: string;
}

/**
 * Short-lived HTTP server that exposes AgentTools for use by a script-worker subprocess.
 *
 * Endpoints:
 *   GET  /tools           — list available tools (live lookup)
 *   POST /tool/:name      — execute a tool with JSON body of arguments
 *
 * The `getTools` callback is called on every request so dynamically registered
 * tools (e.g. MCP servers activated mid-script) are always accessible.
 */
export class ToolBridgeServer {
	#server: ReturnType<typeof Bun.serve> | null = null;
	#port = 0;

	async start(
		getTools: () => AgentTool<any>[],
		signal: AbortSignal,
		context?: AgentToolContext,
	): Promise<number> {
		this.#port = await allocatePort();

		this.#server = Bun.serve({
			port: this.#port,
			hostname: "127.0.0.1",
			fetch: async (req): Promise<Response> => {
				const url = new URL(req.url);

				// ── GET /tools ────────────────────────────────────────────────────
				if (req.method === "GET" && url.pathname === "/tools") {
					const list: BridgeToolInfo[] = getTools().map(t => ({
						name: t.name,
						description: t.description,
					}));
					return Response.json(list);
				}

				// ── POST /tool/:name ──────────────────────────────────────────────
				if (req.method === "POST" && url.pathname.startsWith("/tool/")) {
					const name = decodeURIComponent(url.pathname.slice("/tool/".length));
					const tool = getTools().find(t => t.name === name);

					if (!tool) {
						return Response.json({ error: `Tool not found: ${name}` }, { status: 404 });
					}

					let args: Record<string, unknown>;
					try {
						args = (await req.json()) as Record<string, unknown>;
					} catch {
						return Response.json({ error: "Invalid JSON body" }, { status: 400 });
					}

					// Schema validation — same path as the agent loop
					let validatedArgs: Record<string, unknown>;
					try {
						validatedArgs = validateToolArguments(tool, {
							type: "toolCall",
							id: crypto.randomUUID(),
							name,
							arguments: args,
						});
					} catch (err) {
						return Response.json(
							{ error: err instanceof Error ? err.message : String(err) },
							{ status: 422 },
						);
					}

					try {
						const result = await tool.execute(
							crypto.randomUUID(),
							validatedArgs,
							signal,
							undefined, // no streaming updates from bridge calls
							context,
						);
						const content =
							result.content.length > 0
								? result.content.map(c => (c.type === "text" ? c.text : "")).join("\n")
								: "";
						return Response.json({ content, isError: false });
					} catch (err) {
						// Surface abort as a recognisable message so the worker exits cleanly
						if (signal.aborted) {
							return Response.json({ content: "Tool execution aborted.", isError: true });
						}
						logger.debug("Script bridge tool execution error", {
							tool: name,
							error: err instanceof Error ? err.message : String(err),
						});
						const message = err instanceof Error ? err.message : String(err);
						return Response.json({ content: message, isError: true });
					}
				}

				return new Response("Not found", { status: 404 });
			},
		});

		return this.#port;
	}

	get port(): number {
		return this.#port;
	}

	stop(): void {
		if (this.#server) {
			this.#server.stop(true);
			this.#server = null;
		}
	}
}
