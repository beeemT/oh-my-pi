/**
 * Builtin Provider (.omp / .pi)
 *
 * Primary provider for OMP native configs. Supports all capabilities.
 * .pi is an alias for backwards compatibility.
 */

import { dirname, isAbsolute, join, resolve } from "path";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { type Extension, type ExtensionManifest, extensionCapability } from "../capability/extension";
import { type ExtensionModule, extensionModuleCapability } from "../capability/extension-module";
import { type Hook, hookCapability } from "../capability/hook";
import { registerProvider } from "../capability/index";
import { type Instruction, instructionCapability } from "../capability/instruction";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Prompt, promptCapability } from "../capability/prompt";
import { type Rule, ruleCapability } from "../capability/rule";
import { type Settings, settingsCapability } from "../capability/settings";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { type SystemPrompt, systemPromptCapability } from "../capability/system-prompt";
import { type CustomTool, toolCapability } from "../capability/tool";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	createSourceMeta,
	discoverExtensionModulePaths,
	expandEnvVarsDeep,
	getExtensionNameFromPath,
	loadFilesFromDir,
	loadSkillsFromDir,
	parseFrontmatter,
	parseJSON,
	SOURCE_PATHS,
} from "./helpers";

const PROVIDER_ID = "native";
const DISPLAY_NAME = "OMP";
const DESCRIPTION = "Native OMP configuration from ~/.omp and .omp/";
const PRIORITY = 100;

const PATHS = SOURCE_PATHS.native;
const PROJECT_DIRS = [PATHS.projectDir, ...PATHS.aliases];
const USER_DIRS = [PATHS.userBase, ...PATHS.aliases];

function getConfigDirs(ctx: LoadContext): Array<{ dir: string; level: "user" | "project" }> {
	const result: Array<{ dir: string; level: "user" | "project" }> = [];

	for (const name of PROJECT_DIRS) {
		const projectDir = ctx.fs.walkUp(name, { dir: true });
		if (projectDir) {
			result.push({ dir: projectDir, level: "project" });
			break;
		}
	}

	for (const name of USER_DIRS) {
		const userDir = join(ctx.home, name, PATHS.userAgent.replace(`${PATHS.userBase}/`, ""));
		if (ctx.fs.isDir(userDir)) {
			result.push({ dir: userDir, level: "user" });
			break;
		}
	}

	return result;
}

// MCP
function loadMCPServers(ctx: LoadContext): LoadResult<MCPServer> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	for (const name of PROJECT_DIRS) {
		const projectDir = ctx.fs.walkUp(name, { dir: true });
		if (!projectDir) continue;

		for (const filename of ["mcp.json", ".mcp.json"]) {
			const path = join(projectDir, filename);
			const content = ctx.fs.readFile(path);
			if (!content) continue;

			const data = parseJSON<{ mcpServers?: Record<string, unknown> }>(content);
			if (!data?.mcpServers) continue;

			const expanded = expandEnvVarsDeep(data.mcpServers);
			for (const [serverName, config] of Object.entries(expanded)) {
				const serverConfig = config as Record<string, unknown>;
				items.push({
					name: serverName,
					command: serverConfig.command as string | undefined,
					args: serverConfig.args as string[] | undefined,
					env: serverConfig.env as Record<string, string> | undefined,
					url: serverConfig.url as string | undefined,
					headers: serverConfig.headers as Record<string, string> | undefined,
					transport: serverConfig.type as "stdio" | "sse" | "http" | undefined,
					_source: createSourceMeta(PROVIDER_ID, path, "project"),
				});
			}
			break;
		}
		break;
	}

	for (const name of USER_DIRS) {
		const userPath = join(ctx.home, name, "mcp.json");
		const content = ctx.fs.readFile(userPath);
		if (!content) continue;

		const data = parseJSON<{ mcpServers?: Record<string, unknown> }>(content);
		if (!data?.mcpServers) continue;

		const expanded = expandEnvVarsDeep(data.mcpServers);
		for (const [serverName, config] of Object.entries(expanded)) {
			const serverConfig = config as Record<string, unknown>;
			items.push({
				name: serverName,
				command: serverConfig.command as string | undefined,
				args: serverConfig.args as string[] | undefined,
				env: serverConfig.env as Record<string, string> | undefined,
				url: serverConfig.url as string | undefined,
				headers: serverConfig.headers as Record<string, string> | undefined,
				transport: serverConfig.type as "stdio" | "sse" | "http" | undefined,
				_source: createSourceMeta(PROVIDER_ID, userPath, "user"),
			});
		}
		break;
	}

	return { items, warnings };
}

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadMCPServers,
});

// System Prompt (SYSTEM.md)
function loadSystemPrompt(ctx: LoadContext): LoadResult<SystemPrompt> {
	const items: SystemPrompt[] = [];

	// User level: ~/.omp/agent/SYSTEM.md or ~/.pi/agent/SYSTEM.md
	for (const name of USER_DIRS) {
		const userPath = join(ctx.home, name, PATHS.userAgent.replace(`${PATHS.userBase}/`, ""), "SYSTEM.md");
		const userContent = ctx.fs.readFile(userPath);
		if (userContent) {
			items.push({
				path: userPath,
				content: userContent,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, userPath, "user"),
			});
			break; // First match wins
		}
	}

	// Project level: walk up looking for .omp/SYSTEM.md or .pi/SYSTEM.md
	let current = ctx.cwd;
	while (true) {
		for (const name of PROJECT_DIRS) {
			const configDir = join(current, name);
			if (ctx.fs.isDir(configDir)) {
				const projectPath = join(configDir, "SYSTEM.md");
				const content = ctx.fs.readFile(projectPath);
				if (content) {
					items.push({
						path: projectPath,
						content,
						level: "project",
						_source: createSourceMeta(PROVIDER_ID, projectPath, "project"),
					});
					break; // First config dir in this directory wins
				}
			}
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return { items, warnings: [] };
}

registerProvider<SystemPrompt>(systemPromptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Custom system prompt from SYSTEM.md",
	priority: PRIORITY,
	load: loadSystemPrompt,
});

// Skills
function loadSkills(ctx: LoadContext): LoadResult<Skill> {
	const items: Skill[] = [];
	const warnings: string[] = [];

	for (const { dir, level } of getConfigDirs(ctx)) {
		const skillsDir = join(dir, "skills");
		const result = loadSkillsFromDir(ctx, {
			dir: skillsDir,
			providerId: PROVIDER_ID,
			level,
			requireDescription: true,
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSkills,
});

// Slash Commands
function loadSlashCommands(ctx: LoadContext): LoadResult<SlashCommand> {
	const items: SlashCommand[] = [];
	const warnings: string[] = [];

	for (const { dir, level } of getConfigDirs(ctx)) {
		const commandsDir = join(dir, "commands");
		const result = loadFilesFromDir<SlashCommand>(ctx, commandsDir, PROVIDER_ID, level, {
			extensions: ["md"],
			transform: (name, content, path, source) => ({
				name: name.replace(/\.md$/, ""),
				path,
				content,
				level,
				_source: source,
			}),
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSlashCommands,
});

// Rules
function loadRules(ctx: LoadContext): LoadResult<Rule> {
	const items: Rule[] = [];
	const warnings: string[] = [];

	for (const { dir, level } of getConfigDirs(ctx)) {
		const rulesDir = join(dir, "rules");
		const result = loadFilesFromDir<Rule>(ctx, rulesDir, PROVIDER_ID, level, {
			extensions: ["md", "mdc"],
			transform: (name, content, path, source) => {
				const { frontmatter, body } = parseFrontmatter(content);
				return {
					name: name.replace(/\.(md|mdc)$/, ""),
					path,
					content: body,
					globs: frontmatter.globs as string[] | undefined,
					alwaysApply: frontmatter.alwaysApply as boolean | undefined,
					description: frontmatter.description as string | undefined,
					ttsrTrigger: typeof frontmatter.ttsr_trigger === "string" ? frontmatter.ttsr_trigger : undefined,
					_source: source,
				};
			},
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadRules,
});

// Prompts
function loadPrompts(ctx: LoadContext): LoadResult<Prompt> {
	const items: Prompt[] = [];
	const warnings: string[] = [];

	for (const { dir, level } of getConfigDirs(ctx)) {
		const promptsDir = join(dir, "prompts");
		const result = loadFilesFromDir<Prompt>(ctx, promptsDir, PROVIDER_ID, level, {
			extensions: ["md"],
			transform: (name, content, path, source) => ({
				name: name.replace(/\.md$/, ""),
				path,
				content,
				_source: source,
			}),
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

registerProvider<Prompt>(promptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadPrompts,
});

// Extension Modules
function loadExtensionModules(ctx: LoadContext): LoadResult<ExtensionModule> {
	const items: ExtensionModule[] = [];
	const warnings: string[] = [];

	const resolveExtensionPath = (rawPath: string): string => {
		if (rawPath.startsWith("~/")) {
			return join(ctx.home, rawPath.slice(2));
		}
		if (rawPath.startsWith("~")) {
			return join(ctx.home, rawPath.slice(1));
		}
		if (isAbsolute(rawPath)) {
			return rawPath;
		}
		return resolve(ctx.cwd, rawPath);
	};

	const addExtensionPath = (extPath: string, level: "user" | "project"): void => {
		items.push({
			name: getExtensionNameFromPath(extPath),
			path: extPath,
			level,
			_source: createSourceMeta(PROVIDER_ID, extPath, level),
		});
	};

	for (const { dir, level } of getConfigDirs(ctx)) {
		const extensionsDir = join(dir, "extensions");
		const discovered = discoverExtensionModulePaths(ctx, extensionsDir);
		for (const extPath of discovered) {
			addExtensionPath(extPath, level);
		}

		const settingsPath = join(dir, "settings.json");
		const settingsContent = ctx.fs.readFile(settingsPath);
		if (settingsContent) {
			const settingsData = parseJSON<{ extensions?: unknown }>(settingsContent);
			const extensions = settingsData?.extensions;
			if (Array.isArray(extensions)) {
				for (const entry of extensions) {
					if (typeof entry !== "string") {
						warnings.push(`Invalid extension path in ${settingsPath}: ${String(entry)}`);
						continue;
					}
					const resolvedPath = resolveExtensionPath(entry);
					if (ctx.fs.isDir(resolvedPath)) {
						for (const extPath of discoverExtensionModulePaths(ctx, resolvedPath)) {
							addExtensionPath(extPath, level);
						}
					} else if (ctx.fs.isFile(resolvedPath)) {
						addExtensionPath(resolvedPath, level);
					} else {
						warnings.push(`Extension path not found: ${resolvedPath}`);
					}
				}
			}
		}
	}

	return { items, warnings };
}

registerProvider<ExtensionModule>(extensionModuleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadExtensionModules,
});

// Extensions
function loadExtensions(ctx: LoadContext): LoadResult<Extension> {
	const items: Extension[] = [];
	const warnings: string[] = [];

	for (const { dir, level } of getConfigDirs(ctx)) {
		const extensionsDir = join(dir, "extensions");
		if (!ctx.fs.isDir(extensionsDir)) continue;

		for (const name of ctx.fs.readDir(extensionsDir)) {
			if (name.startsWith(".")) continue;

			const extDir = join(extensionsDir, name);
			if (!ctx.fs.isDir(extDir)) continue;

			const manifestPath = join(extDir, "gemini-extension.json");
			const content = ctx.fs.readFile(manifestPath);
			if (!content) continue;

			const manifest = parseJSON<ExtensionManifest>(content);
			if (!manifest) {
				warnings.push(`Failed to parse ${manifestPath}`);
				continue;
			}

			items.push({
				name: manifest.name || name,
				path: extDir,
				manifest,
				level,
				_source: createSourceMeta(PROVIDER_ID, manifestPath, level),
			});
		}
	}

	return { items, warnings };
}

registerProvider<Extension>(extensionCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadExtensions,
});

// Instructions
function loadInstructions(ctx: LoadContext): LoadResult<Instruction> {
	const items: Instruction[] = [];
	const warnings: string[] = [];

	for (const { dir, level } of getConfigDirs(ctx)) {
		const instructionsDir = join(dir, "instructions");
		const result = loadFilesFromDir<Instruction>(ctx, instructionsDir, PROVIDER_ID, level, {
			extensions: ["md"],
			transform: (name, content, path, source) => {
				const { frontmatter, body } = parseFrontmatter(content);
				return {
					name: name.replace(/\.instructions\.md$/, "").replace(/\.md$/, ""),
					path,
					content: body,
					applyTo: frontmatter.applyTo as string | undefined,
					_source: source,
				};
			},
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

registerProvider<Instruction>(instructionCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadInstructions,
});

// Hooks
function loadHooks(ctx: LoadContext): LoadResult<Hook> {
	const items: Hook[] = [];

	for (const { dir, level } of getConfigDirs(ctx)) {
		const hooksDir = join(dir, "hooks");
		if (!ctx.fs.isDir(hooksDir)) continue;

		for (const hookType of ["pre", "post"] as const) {
			const typeDir = join(hooksDir, hookType);
			if (!ctx.fs.isDir(typeDir)) continue;

			for (const name of ctx.fs.readDir(typeDir)) {
				if (name.startsWith(".")) continue;

				const path = join(typeDir, name);
				if (!ctx.fs.isFile(path)) continue;

				const baseName = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
				const tool = baseName === "*" ? "*" : baseName;

				items.push({
					name,
					path,
					type: hookType,
					tool,
					level,
					_source: createSourceMeta(PROVIDER_ID, path, level),
				});
			}
		}
	}

	return { items, warnings: [] };
}

registerProvider<Hook>(hookCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadHooks,
});

// Custom Tools
function loadTools(ctx: LoadContext): LoadResult<CustomTool> {
	const items: CustomTool[] = [];
	const warnings: string[] = [];

	for (const { dir, level } of getConfigDirs(ctx)) {
		const toolsDir = join(dir, "tools");
		if (!ctx.fs.isDir(toolsDir)) continue;

		// Load tool files (JSON and Markdown declarative tools)
		const result = loadFilesFromDir<CustomTool>(ctx, toolsDir, PROVIDER_ID, level, {
			extensions: ["json", "md"],
			transform: (name, content, path, source) => {
				if (name.endsWith(".json")) {
					const data = parseJSON<{ name?: string; description?: string }>(content);
					return {
						name: data?.name || name.replace(/\.json$/, ""),
						path,
						description: data?.description,
						level,
						_source: source,
					};
				}
				const { frontmatter } = parseFrontmatter(content);
				return {
					name: (frontmatter.name as string) || name.replace(/\.md$/, ""),
					path,
					description: frontmatter.description as string | undefined,
					level,
					_source: source,
				};
			},
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);

		// Load TypeScript tools from subdirectories (tools/mytool/index.ts pattern)
		for (const name of ctx.fs.readDir(toolsDir)) {
			if (name.startsWith(".")) continue;

			const subDir = join(toolsDir, name);
			if (!ctx.fs.isDir(subDir)) continue;

			const indexPath = join(subDir, "index.ts");
			if (ctx.fs.isFile(indexPath)) {
				items.push({
					name,
					path: indexPath,
					description: undefined,
					level,
					_source: createSourceMeta(PROVIDER_ID, indexPath, level),
				});
			}
		}
	}

	return { items, warnings };
}

registerProvider<CustomTool>(toolCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadTools,
});

// Settings
function loadSettings(ctx: LoadContext): LoadResult<Settings> {
	const items: Settings[] = [];
	const warnings: string[] = [];

	for (const { dir, level } of getConfigDirs(ctx)) {
		const settingsPath = join(dir, "settings.json");
		const content = ctx.fs.readFile(settingsPath);
		if (!content) continue;

		const data = parseJSON<Record<string, unknown>>(content);
		if (!data) {
			warnings.push(`Failed to parse ${settingsPath}`);
			continue;
		}

		items.push({
			path: settingsPath,
			data,
			level,
			_source: createSourceMeta(PROVIDER_ID, settingsPath, level),
		});
	}

	return { items, warnings };
}

registerProvider<Settings>(settingsCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSettings,
});

// Context Files (AGENTS.md)
function loadContextFiles(ctx: LoadContext): LoadResult<ContextFile> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	// User level: ~/.omp/agent/AGENTS.md or ~/.pi/agent/AGENTS.md
	for (const name of USER_DIRS) {
		const userPath = join(ctx.home, name, PATHS.userAgent.replace(`${PATHS.userBase}/`, ""), "AGENTS.md");
		const content = ctx.fs.readFile(userPath);
		if (content) {
			items.push({
				path: userPath,
				content,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, userPath, "user"),
			});
			break; // First match wins
		}
	}

	// Project level: walk up looking for .omp/AGENTS.md or .pi/AGENTS.md
	let current = ctx.cwd;
	let depth = 0;
	while (true) {
		for (const name of PROJECT_DIRS) {
			const configDir = join(current, name);
			if (ctx.fs.isDir(configDir)) {
				const projectPath = join(configDir, "AGENTS.md");
				const content = ctx.fs.readFile(projectPath);
				if (content) {
					items.push({
						path: projectPath,
						content,
						level: "project",
						depth,
						_source: createSourceMeta(PROVIDER_ID, projectPath, "project"),
					});
					return { items, warnings }; // First config dir wins
				}
			}
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
		depth++;
	}

	return { items, warnings };
}

registerProvider<ContextFile>(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load AGENTS.md from .omp/ directories",
	priority: PRIORITY,
	load: loadContextFiles,
});
