import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ScriptTool } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolBridgeServer } from "@oh-my-pi/pi-coding-agent/tools/script-bridge";
import { Type } from "@sinclair/typebox";

function text(r: AgentToolResult): string {
	return (r.content[0] as { type: "text"; text: string }).text;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockTool(name: string, fn: (params: Record<string, unknown>) => string): AgentTool<any> {
	return {
		name,
		label: name,
		description: `Mock ${name}`,
		parameters: Type.Object({ input: Type.Optional(Type.String()) }),
		execute: async (_id: string, params: Record<string, unknown>) => ({
			content: [{ type: "text" as const, text: fn(params) }],
			details: {},
		}),
	};
}

function createSession(tools: AgentTool<any>[] = []): ToolSession {
	const session: ToolSession = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	};
	session.getTools = () => tools;
	return session;
}

// ── ToolBridgeServer ──────────────────────────────────────────────────────────

describe("ToolBridgeServer", () => {
	it("allocates a port atomically without TOCTOU race", () => {
		const bridge = new ToolBridgeServer();
		const secret = crypto.randomUUID();
		const ac = new AbortController();
		const port = bridge.start(() => [], ac.signal, secret);
		expect(port).toBeGreaterThan(0);
		expect(Number.isInteger(port)).toBe(true);
		bridge.stop();
	});

	it("two concurrent bridges get distinct ports", () => {
		const b1 = new ToolBridgeServer();
		const b2 = new ToolBridgeServer();
		const ac = new AbortController();
		const p1 = b1.start(() => [], ac.signal, crypto.randomUUID());
		const p2 = b2.start(() => [], ac.signal, crypto.randomUUID());
		expect(p1).not.toBe(p2);
		b1.stop();
		b2.stop();
	});

	it("returns 401 when X-Bridge-Token header is absent", async () => {
		const bridge = new ToolBridgeServer();
		const secret = crypto.randomUUID();
		const ac = new AbortController();
		const port = bridge.start(() => [], ac.signal, secret);
		const res = await fetch(`http://127.0.0.1:${port}/tools`);
		expect(res.status).toBe(401);
		bridge.stop();
	});

	it("returns 401 for a wrong token", async () => {
		const bridge = new ToolBridgeServer();
		const secret = crypto.randomUUID();
		const ac = new AbortController();
		const port = bridge.start(() => [], ac.signal, secret);
		const res = await fetch(`http://127.0.0.1:${port}/tools`, {
			headers: { "X-Bridge-Token": "wrong" },
		});
		expect(res.status).toBe(401);
		bridge.stop();
	});

	it("serves GET /tools with the correct token", async () => {
		const tool = mockTool("echo", p => String(p.input ?? ""));
		const bridge = new ToolBridgeServer();
		const secret = crypto.randomUUID();
		const ac = new AbortController();
		const port = bridge.start(() => [tool], ac.signal, secret);
		const res = await fetch(`http://127.0.0.1:${port}/tools`, {
			headers: { "X-Bridge-Token": secret },
		});
		expect(res.status).toBe(200);
		const list = (await res.json()) as Array<{ name: string }>;
		expect(list.map((t: { name: string }) => t.name)).toContain("echo");
		bridge.stop();
	});

	it("executes POST /tool/:name and returns text content", async () => {
		const tool = mockTool("echo", p => `got:${p.input}`);
		const bridge = new ToolBridgeServer();
		const secret = crypto.randomUUID();
		const ac = new AbortController();
		const port = bridge.start(() => [tool], ac.signal, secret);
		const res = await fetch(`http://127.0.0.1:${port}/tool/echo`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Bridge-Token": secret },
			body: JSON.stringify({ input: "hello" }),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()) as { content: string; isError: boolean };
		expect(data.content).toBe("got:hello");
		expect(data.isError).toBe(false);
		bridge.stop();
	});

	it("returns 404 for an unknown tool", async () => {
		const bridge = new ToolBridgeServer();
		const secret = crypto.randomUUID();
		const ac = new AbortController();
		const port = bridge.start(() => [], ac.signal, secret);
		const res = await fetch(`http://127.0.0.1:${port}/tool/nonexistent`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Bridge-Token": secret },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(404);
		bridge.stop();
	});

	it("returns 422 when tool arguments fail schema validation", async () => {
		const tool = mockTool("echo", () => "");
		const bridge = new ToolBridgeServer();
		const secret = crypto.randomUUID();
		const ac = new AbortController();
		// echo requires 'input' (optional string) — send a non-string to trigger validation failure
		const _port = bridge.start(() => [tool], ac.signal, secret);
		// Override tool schema with a required field to force validation failure
		const strictTool: AgentTool<any> = {
			...tool,
			parameters: Type.Object({ required_field: Type.String() }),
		};
		const portStrict = new ToolBridgeServer().start(() => [strictTool], ac.signal, secret);
		const res = await fetch(`http://127.0.0.1:${portStrict}/tool/echo`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Bridge-Token": secret },
			body: JSON.stringify({}), // missing required_field
		});
		expect(res.status).toBe(422);
		bridge.stop();
	});

	it("reflects tools added after startup (live getTools)", async () => {
		const tools: AgentTool<any>[] = [];
		const bridge = new ToolBridgeServer();
		const secret = crypto.randomUUID();
		const ac = new AbortController();
		const port = bridge.start(() => tools, ac.signal, secret);

		const list1 = (await (
			await fetch(`http://127.0.0.1:${port}/tools`, { headers: { "X-Bridge-Token": secret } })
		).json()) as unknown[];
		expect(list1).toHaveLength(0);

		tools.push(mockTool("dynamic", () => "ok"));

		const list2 = (await (
			await fetch(`http://127.0.0.1:${port}/tools`, { headers: { "X-Bridge-Token": secret } })
		).json()) as unknown[];
		expect(list2).toHaveLength(1);

		bridge.stop();
	});
});

// ── ScriptTool ────────────────────────────────────────────────────────────────

describe("ScriptTool schema", () => {
	it("requires code parameter", () => {
		const tool = new ScriptTool(createSession());
		const schema = tool.parameters as { properties: Record<string, { type: string }> };
		expect(schema.properties.code.type).toBe("string");
	});

	it("timeout has minimum:1", () => {
		const tool = new ScriptTool(createSession());
		const schema = tool.parameters as {
			properties: Record<string, { type: string; minimum?: number }>;
		};
		expect(schema.properties.timeout.minimum).toBe(1);
	});
});

describe("ScriptTool execution", () => {
	const echoTool = mockTool("echo", p => `echo:${p.input ?? ""}`);
	const reverseTool = mockTool("reverse", p =>
		String(p.input ?? "")
			.split("")
			.reverse()
			.join(""),
	);
	const errorTool: AgentTool<any> = {
		name: "erroring",
		label: "Erroring",
		description: "Always throws",
		parameters: Type.Object({}),
		execute: async () => {
			throw new Error("always fails");
		},
	};

	let tool: ScriptTool;

	beforeAll(() => {
		tool = new ScriptTool(createSession([echoTool, reverseTool, errorTool]));
	});

	afterAll(() => {
		// nothing to clean up
	});

	async function run(code: string, timeout = 10) {
		return tool.execute("test", { code, timeout });
	}

	it("returns a value from return statement", async () => {
		const r = await run(`return "alive"`);
		expect(text(r)).toBe("alive");
		expect(r.details?.exitCode).toBe(0);
	});

	it("collects console.log output", async () => {
		const r = await run(`console.log("line1"); console.log("line2")`);
		expect(text(r)).toBe("line1\nline2");
	});

	it("appends return value after console.log output", async () => {
		const r = await run(`console.log("logged"); return "returned"`);
		expect(text(r)).toBe("logged\nreturned");
	});

	it("calls named tool function", async () => {
		const r = await run(`return await echo({ input: "hello" })`);
		expect(text(r)).toBe("echo:hello");
	});

	it("calls tool via tools proxy", async () => {
		const r = await run(`return await tools.reverse({ input: "world" })`);
		expect(text(r)).toBe("dlrow");
	});

	it("chains sequential tool calls", async () => {
		const r = await run(`
			const a = await echo({ input: "foo" });
			const b = await reverse({ input: "bar" });
			return [a, b].join("|");
		`);
		expect(text(r)).toBe("echo:foo|rab");
	});

	it("executes parallel tool calls via Promise.all", async () => {
		const r = await run(`
			const results = await Promise.all(["a","b","c"].map(v => echo({ input: v })));
			return results.join(",");
		`);
		expect(text(r)).toBe("echo:a,echo:b,echo:c");
	});

	it("listTools returns available tools", async () => {
		const r = await run(`
			const list = await listTools();
			return list.map(t => t.name).sort().join(",");
		`);
		expect(text(r)).toContain("echo");
		expect(text(r)).toContain("reverse");
	});

	it("script tool itself is excluded from listTools", async () => {
		// ScriptTool adds itself to the session's getTools but bridge filters it out
		const session = createSession([echoTool, new ScriptTool(createSession())]);
		const t = new ScriptTool(session);
		session.getTools = () => [echoTool, t];
		const r = await t.execute("test", {
			code: `const l = await listTools(); return l.some(x => x.name === "script") ? "exposed" : "excluded"`,
			timeout: 10,
		});
		expect(text(r)).toBe("excluded");
	});

	it("returns (no output) when script produces nothing", async () => {
		const r = await run(`// silence`);
		expect(text(r)).toBe("(no output)");
	});

	it("surfaces tool errors as JS exceptions catchable in script", async () => {
		const r = await run(`
			try {
				await tools.erroring({});
				return "unreachable";
			} catch (e) {
				return "caught:" + e.message;
			}
		`);
		expect(text(r)).toBe("caught:always fails");
	});

	it("returns error text and non-zero exitCode on uncaught throw", async () => {
		const r = await run(`throw new Error("boom")`);
		expect(text(r)).toContain("boom");
		expect(r.details?.exitCode).not.toBe(0);
	});

	it("handles large stderr without deadlocking (pipe buffer test)", async () => {
		// Write >64KB directly to stderr; should not stall child.exited
		const kb128 = "x".repeat(128 * 1024);
		const start = Date.now();
		const r = await run(`process.stderr.write(${JSON.stringify(kb128)}); return "done"`, 10);
		expect(text(r)).toBe("done");
		expect(Date.now() - start).toBeLessThan(8000);
	});

	it("respects timeout and returns timeout message", async () => {
		const start = Date.now();
		const r = await run(`await new Promise(r => setTimeout(r, 60000))`, 2);
		expect(text(r)).toContain("timed out");
		expect(Date.now() - start).toBeLessThan(5000);
	});

	it("respects abort signal", async () => {
		const ac = new AbortController();
		const start = Date.now();
		const p = tool.execute("test", { code: `await new Promise(r => setTimeout(r, 60000))`, timeout: 30 }, ac.signal);
		await Bun.sleep(150);
		ac.abort();
		await expect(p).rejects.toThrow();
		expect(Date.now() - start).toBeLessThan(5000);
	});

	it("does not expose parent env secrets to subprocess", async () => {
		Bun.env.OMP_TEST_SECRET_XYZ = "leaked";
		const r = await run(`return Bun.env.OMP_TEST_SECRET_XYZ ?? "isolated"`, 5);
		delete Bun.env.OMP_TEST_SECRET_XYZ;
		expect(text(r)).toBe("isolated");
	});

	it("dynamically added tool is visible via tools proxy", async () => {
		const dynamicTool = mockTool("dynamic_xyz", () => "dynamic-result");
		const liveTools = [echoTool, dynamicTool];
		const session = createSession(liveTools);
		const t = new ScriptTool(session);
		session.getTools = () => [echoTool, dynamicTool, t];

		const r = await t.execute("test", {
			code: `return await tools.dynamic_xyz({})`,
			timeout: 10,
		});
		expect(text(r)).toBe("dynamic-result");
	});
});
