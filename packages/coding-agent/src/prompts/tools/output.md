Retrieves complete output from background tasks spawned with the Task tool.

## When to Use

Use TaskOutput when:

- Task tool returns truncated preview with "Output truncated" message
- You need full output to debug errors or analyze detailed results
- Task tool's summary shows substantial line/character counts but preview is incomplete
- You're analyzing multi-step task output requiring full context

Do NOT use when:

- Task preview already shows complete output (no truncation indicator)
- Summary alone answers your question

## Parameters

- `ids`: Array of output IDs from Task results (e.g., `["reviewer_0", "explore_1"]`)
- `format` (optional):
  - `"raw"` (default): Full output with ANSI codes preserved
  - `"json"`: Structured object with metadata
  - `"stripped"`: Plain text with ANSI codes removed for parsing
- `query` (optional): jq-like query for JSON outputs (e.g., `.result.items[0].name`)
- `offset` (optional): Line number to start reading from (1-indexed)
- `limit` (optional): Maximum number of lines to read

Use offset/limit for line ranges to reduce context usage on large outputs. Use `query` for JSON outputs (for example, subagent `complete` results).
