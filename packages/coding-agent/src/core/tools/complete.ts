/**
 * Complete tool for structured subagent output.
 *
 * Subagents must call this tool to finish and return structured JSON output.
 */

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import type { ToolSession } from "./index";
import { jtdToJsonSchema } from "./jtd-to-json-schema";
import { subprocessToolRegistry } from "./task/subprocess-tool-registry";

export interface CompleteDetails {
	data: unknown;
	status: "success" | "aborted";
	error?: string;
}

const ajv = new Ajv({ allErrors: true, strict: false });

function normalizeSchema(schema: unknown): { normalized?: unknown; error?: string } {
	if (schema === undefined || schema === null) return {};
	if (typeof schema === "string") {
		try {
			return { normalized: JSON.parse(schema) };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}
	return { normalized: schema };
}

function formatSchema(schema: unknown): string {
	if (schema === undefined) return "No schema provided.";
	if (typeof schema === "string") return schema;
	try {
		return JSON.stringify(schema, null, 2);
	} catch {
		return "[unserializable schema]";
	}
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
	if (!errors || errors.length === 0) return "Unknown schema validation error.";
	return errors
		.map((err) => {
			const path = err.instancePath ? `${err.instancePath}: ` : "";
			return `${path}${err.message ?? "invalid"}`;
		})
		.join("; ");
}

export function createCompleteTool(session: ToolSession) {
	const schemaResult = normalizeSchema(session.outputSchema);
	// Convert JTD to JSON Schema if needed (auto-detected)
	const normalizedSchema =
		schemaResult.normalized !== undefined ? jtdToJsonSchema(schemaResult.normalized) : undefined;
	let validate: ValidateFunction | undefined;
	let schemaError = schemaResult.error;

	if (normalizedSchema !== undefined && !schemaError) {
		try {
			validate = ajv.compile(normalizedSchema as any);
		} catch (err) {
			schemaError = err instanceof Error ? err.message : String(err);
		}
	}

	const schemaHint = formatSchema(normalizedSchema ?? session.outputSchema);

	// Use actual schema if provided, otherwise fall back to Type.Any
	// Merge description into the JSON schema for better tool documentation
	const dataSchema = normalizedSchema
		? Type.Unsafe({
				...(normalizedSchema as object),
				description: "Structured output matching the schema:\n" + schemaHint,
			})
		: Type.Any({ description: "Structured JSON output (no schema specified)" });

	const completeParams = Type.Object({
		data: dataSchema,
		status: Type.Optional(
			Type.Union([Type.Literal("success"), Type.Literal("aborted")], {
				default: "success",
				description: "Use 'aborted' if the task cannot be completed",
			}),
		),
		error: Type.Optional(Type.String({ description: "Error message when status is 'aborted'" })),
	});

	const tool: AgentTool<typeof completeParams, CompleteDetails> = {
		name: "complete",
		label: "Complete",
		description:
			"Finish the task with structured JSON output. Call exactly once at the end of the task.\n\n" +
			"If you cannot complete the task, call with status='aborted' and an error message.",
		parameters: completeParams,
		execute: async (_toolCallId, params) => {
			const status = params.status ?? "success";

			// Skip schema validation when aborting - the agent is giving up
			if (status === "success") {
				if (schemaError) {
					throw new Error(`Invalid output schema: ${schemaError}`);
				}
				if (validate && !validate(params.data)) {
					throw new Error(`Output does not match schema: ${formatAjvErrors(validate.errors)}`);
				}
			}

			const responseText =
				status === "aborted"
					? `Task aborted: ${params.error || "No reason provided"}`
					: "Completion recorded.";

			return {
				content: [{ type: "text", text: responseText }],
				details: { data: params.data, status, error: params.error },
			};
		},
	};

	return tool;
}

// Register subprocess tool handler for extraction + termination.
subprocessToolRegistry.register<CompleteDetails>("complete", {
	extractData: (event) => event.result?.details as CompleteDetails | undefined,
	shouldTerminate: () => true,
});
