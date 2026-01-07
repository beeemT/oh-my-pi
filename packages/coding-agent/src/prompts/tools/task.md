Launch a new agent to handle complex, multi-step tasks autonomously.

The Task tool launches specialized agents (workers) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

## Available Agents

{{AGENTS_LIST}}

## When NOT to Use

- Reading a specific file path → Use Read or Glob tool instead
- Searching for a specific class/function definition → Use Glob tool instead
- Searching code within 2-3 specific files → Use Read tool instead
- Tasks unrelated to the agent descriptions above

## Usage Notes

- Always include a short description of the task in the task parameter
- **Plan-then-execute**: Put shared constraints in `context`, keep each task focused, specify acceptance criteria; use `output_schema` when you need structured output
- **Minimize tool chatter**: Avoid repeating large context; use Output tool with output ids for full logs
- **Structured completion**: If `output_schema` is provided, subagents must call `complete` to finish
- **Parallelize**: Launch multiple agents concurrently whenever possible
- **Results are intermediate data**: Agent findings provide context for YOU to perform actual work. Do not treat agent reports as "task complete" signals.
- **Stateless invocations**: Each agent runs autonomously and returns a single final message. Include all necessary context and specify exactly what information to return.
- **Trust outputs**: Agent results should generally be trusted
- **Clarify intent**: Tell the agent whether you expect code changes or just research (search, file reads, web fetches)
- **Proactive use**: If an agent description says to use it proactively, do so without waiting for explicit user request

## Parameters

- `tasks`: Array of `{agent, task, description?, model?}` - tasks to run in parallel (max {{MAX_PARALLEL_TASKS}}, {{MAX_CONCURRENCY}} concurrent)
  - `model`: (optional) Override the agent's default model with fuzzy matching (e.g., "sonnet", "codex", "5.2"). Supports comma-separated fallbacks: "gpt, opus" tries gpt first, then opus. Use "default" for omp's default model
- `context`: (optional) Shared context string prepended to all task prompts - use this to avoid repeating instructions
- `output_schema`: (optional) JSON schema for structured subagent output (used by the complete tool)

## Examples

<example>
user: "Please write a function that checks if a number is prime"
assistant: Sure let me write a function that checks if a number is prime
assistant: I'm going to use the Write tool to write the following code:
<code>
function isPrime(n) {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
</code>
<commentary>
Since a significant piece of code was written and the task was completed, now use the code-reviewer agent to review the code
</commentary>
assistant: Now let me use the code-reviewer agent to review the code
assistant: Uses the Task tool: { tasks: [{ agent: "code-reviewer", task: "Review the isPrime function" }] }
</example>

<example>
user: "Find all TODO comments in the codebase"
assistant: I'll use multiple explore agents to search different directories in parallel
assistant: Uses the Task tool:
{
  "context": "Find all TODO comments. Return file:line:content format.",
  "tasks": [
    { "agent": "explore", "task": "Search in src/" },
    { "agent": "explore", "task": "Search in lib/" },
    { "agent": "explore", "task": "Search in tests/" }
  ]
}
</example>
