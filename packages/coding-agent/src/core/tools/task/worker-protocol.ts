import type { AgentEvent } from "@oh-my-pi/pi-agent-core";

export interface SubagentWorkerStartPayload {
	cwd: string;
	task: string;
	systemPrompt: string;
	model?: string;
	toolNames?: string[];
	outputSchema?: unknown;
	sessionFile?: string | null;
	spawnsEnv?: string;
}

export type SubagentWorkerRequest = { type: "start"; payload: SubagentWorkerStartPayload } | { type: "abort" };

export type SubagentWorkerResponse =
	| { type: "event"; event: AgentEvent }
	| { type: "done"; exitCode: number; durationMs: number; error?: string; aborted?: boolean };
