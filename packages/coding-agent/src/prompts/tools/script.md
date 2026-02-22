Execute JavaScript code that can call other registered tools as async functions.

Use this tool when a task requires calling the same tool multiple times, chaining outputs between tools, or looping over a set of items — situations that would otherwise require many separate tool calls and LLM round-trips.

## Available functions

Every registered tool is available as a named async function. Common ones:

```javascript
await bash({ command, timeout?, cwd?, head?, tail? })
await read({ path, offset?, limit? })
await write({ path, content })
await edit({ path, edits })
await grep({ pattern, path?, glob?, type?, pre?, post?, limit? })
await find({ pattern, limit?, hidden? })
await fetch({ url, raw?, timeout? })
await web_search({ query, limit?, provider? })
await lsp({ action, file?, line?, column?, query? })
await browser({ action, url?, selector?, text? })
```

All functions return the tool's text output as a string. Errors throw.

## Dynamic and MCP tools

Tools loaded at runtime (MCP servers, dynamically activated servers) are accessible through the `tools` proxy. This works even for tools not present at script startup:

```javascript
await tools.mcp_github_search({ query: "issue" })
await tools.mcp_postgres_query({ sql: "SELECT 1" })
await tools.any_tool_name({ ...args })
```

To discover what tools are currently registered (including those activated mid-script):

```javascript
const available = await listTools();
// [{ name: "bash", description: "..." }, { name: "mcp_postgres_query", ... }, ...]
```

## Output
- `console.log(...)` output is collected and returned
- A `return` value is appended to the output
- Errors thrown from the script or from tool calls surface as tool errors
- Default timeout is **30 seconds**. For scripts that read many files, run shell commands, or call slow tools, set `timeout` explicitly: `{ code: "...", timeout: 120 }`. Maximum useful values are task-dependent; large codebase scans may need 120–300s.

## Patterns
**Sequential pipeline:**
```javascript
const files = JSON.parse(await find({ pattern: "src/**/*.ts" }));
let count = 0;
for (const f of files) {
  const src = await read({ path: f });
  if (src.includes("TODO")) {
    console.log(`Found TODO in ${f}`);
    count++;
  }
}
return `${count} files have TODOs`;
```
**Parallel execution:**
```javascript
const files = JSON.parse(await find({ pattern: "*.md" }));
const results = await Promise.all(files.map(f => read({ path: f })));
return results.filter(c => c.includes("deprecated")).length + " files mention deprecated";
```
**Conditional logic on tool output:**
```javascript
const status = await bash({ command: "git status --porcelain" });
if (status.trim() === "") {
  return "Working tree clean — nothing to do";
}
const diff = await bash({ command: "git diff HEAD" });
return diff;
```
**Using a dynamically activated MCP tool:**
```javascript
// After a tool_search call has activated an MCP server:
const available = await listTools();
const hasDb = available.some(t => t.name === "mcp_postgres_query");
if (hasDb) {
  const rows = await tools.mcp_postgres_query({ sql: "SELECT count(*) FROM users" });
  return rows;
}
return "Database tool not available";
```