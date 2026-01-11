/**
 * Shared helpers for discovery providers.
 */

import { join, resolve } from "path";
import { parse as parseYAML } from "yaml";
import type { Skill, SkillFrontmatter } from "../capability/skill";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";

/**
 * Standard paths for each config source.
 */
export const SOURCE_PATHS = {
	native: {
		userBase: ".omp",
		userAgent: ".omp/agent",
		projectDir: ".omp",
		aliases: [".pi"], // .pi is an alias for backwards compat
	},
	claude: {
		userBase: ".claude",
		userAgent: ".claude",
		projectDir: ".claude",
	},
	codex: {
		userBase: ".codex",
		userAgent: ".codex",
		projectDir: ".codex",
	},
	gemini: {
		userBase: ".gemini",
		userAgent: ".gemini",
		projectDir: ".gemini",
	},
	cursor: {
		userBase: ".cursor",
		userAgent: ".cursor",
		projectDir: ".cursor",
	},
	windsurf: {
		userBase: ".codeium/windsurf",
		userAgent: ".codeium/windsurf",
		projectDir: ".windsurf",
	},
	cline: {
		userBase: ".cline",
		userAgent: ".cline",
		projectDir: null, // Cline uses root-level .clinerules
	},
	github: {
		userBase: null,
		userAgent: null,
		projectDir: ".github",
	},
	vscode: {
		userBase: ".vscode",
		userAgent: ".vscode",
		projectDir: ".vscode",
	},
} as const;

export type SourceId = keyof typeof SOURCE_PATHS;

/**
 * Get user-level path for a source.
 */
export function getUserPath(ctx: LoadContext, source: SourceId, subpath: string): string | null {
	const paths = SOURCE_PATHS[source];
	if (!paths.userAgent) return null;
	return join(ctx.home, paths.userAgent, subpath);
}

/**
 * Get project-level path for a source (walks up from cwd).
 */
export function getProjectPath(ctx: LoadContext, source: SourceId, subpath: string): string | null {
	const paths = SOURCE_PATHS[source];
	if (!paths.projectDir) return null;

	const found = ctx.fs.walkUp(paths.projectDir, { dir: true });
	if (!found) return null;

	return join(found, subpath);
}

/**
 * Create source metadata for an item.
 */
export function createSourceMeta(provider: string, path: string, level: "user" | "project"): SourceMeta {
	return {
		provider,
		providerName: "", // Filled in by registry
		path: resolve(path),
		level,
	};
}

/**
 * Strip YAML frontmatter from content.
 * Returns { frontmatter, body, raw }
 */
export function parseFrontmatter(content: string): {
	frontmatter: Record<string, unknown>;
	body: string;
	raw: string;
} {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

	if (!normalized.startsWith("---")) {
		return { frontmatter: {}, body: normalized, raw: "" };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter: {}, body: normalized, raw: "" };
	}

	const raw = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	try {
		const frontmatter = parseYAML(raw) as Record<string, unknown> | null;
		return { frontmatter: frontmatter ?? {}, body, raw };
	} catch {
		// Fallback to empty frontmatter on parse error
		return { frontmatter: {}, body, raw };
	}
}

export function loadSkillsFromDir(
	ctx: LoadContext,
	options: {
		dir: string;
		providerId: string;
		level: "user" | "project";
		requireDescription?: boolean;
	},
): LoadResult<Skill> {
	const items: Skill[] = [];
	const warnings: string[] = [];
	const { dir, level, providerId, requireDescription = false } = options;

	if (!ctx.fs.isDir(dir)) {
		return { items, warnings };
	}

	for (const name of ctx.fs.readDir(dir)) {
		if (name.startsWith(".") || name === "node_modules") continue;

		const skillDir = join(dir, name);
		if (!ctx.fs.isDir(skillDir)) continue;

		const skillFile = join(skillDir, "SKILL.md");
		if (!ctx.fs.isFile(skillFile)) continue;

		const content = ctx.fs.readFile(skillFile);
		if (!content) {
			warnings.push(`Failed to read ${skillFile}`);
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);
		if (requireDescription && !frontmatter.description) {
			continue;
		}

		items.push({
			name: (frontmatter.name as string) || name,
			path: skillFile,
			content: body,
			frontmatter: frontmatter as SkillFrontmatter,
			level,
			_source: createSourceMeta(providerId, skillFile, level),
		});
	}

	return { items, warnings };
}

/**
 * Expand environment variables in a string.
 * Supports ${VAR} and ${VAR:-default} syntax.
 */
export function expandEnvVars(value: string, extraEnv?: Record<string, string>): string {
	return value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_, varName: string, defaultValue?: string) => {
		const envValue = extraEnv?.[varName] ?? process.env[varName];
		if (envValue !== undefined) return envValue;
		if (defaultValue !== undefined) return defaultValue;
		return `\${${varName}}`;
	});
}

/**
 * Recursively expand environment variables in an object.
 */
export function expandEnvVarsDeep<T>(obj: T, extraEnv?: Record<string, string>): T {
	if (typeof obj === "string") {
		return expandEnvVars(obj, extraEnv) as T;
	}
	if (Array.isArray(obj)) {
		return obj.map((item) => expandEnvVarsDeep(item, extraEnv)) as T;
	}
	if (obj !== null && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = expandEnvVarsDeep(value, extraEnv);
		}
		return result as T;
	}
	return obj;
}

/**
 * Load files from a directory matching a pattern.
 */
export function loadFilesFromDir<T>(
	ctx: LoadContext,
	dir: string,
	provider: string,
	level: "user" | "project",
	options: {
		/** File extensions to match (without dot) */
		extensions?: string[];
		/** Transform file to item (return null to skip) */
		transform: (name: string, content: string, path: string, source: SourceMeta) => T | null;
		/** Whether to recurse into subdirectories */
		recursive?: boolean;
	},
): LoadResult<T> {
	const items: T[] = [];
	const warnings: string[] = [];

	if (!ctx.fs.isDir(dir)) {
		return { items, warnings };
	}

	const files = ctx.fs.readDir(dir);

	for (const name of files) {
		if (name.startsWith(".")) continue;

		const path = join(dir, name);

		if (options.recursive && ctx.fs.isDir(path)) {
			const subResult = loadFilesFromDir(ctx, path, provider, level, options);
			items.push(...subResult.items);
			if (subResult.warnings) warnings.push(...subResult.warnings);
			continue;
		}

		if (!ctx.fs.isFile(path)) continue;

		// Check extension
		if (options.extensions) {
			const hasMatch = options.extensions.some((ext) => name.endsWith(`.${ext}`));
			if (!hasMatch) continue;
		}

		const content = ctx.fs.readFile(path);
		if (content === null) {
			warnings.push(`Failed to read file: ${path}`);
			continue;
		}

		const source = createSourceMeta(provider, path, level);

		try {
			const item = options.transform(name, content, path, source);
			if (item !== null) {
				items.push(item);
			}
		} catch (err) {
			warnings.push(`Failed to parse ${path}: ${err}`);
		}
	}

	return { items, warnings };
}

/**
 * Parse JSON safely.
 */
export function parseJSON<T>(content: string): T | null {
	try {
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

/**
 * Calculate depth of target directory relative to current working directory.
 * Depth is the number of directory levels from cwd to target.
 * - Positive depth: target is above cwd (parent/ancestor)
 * - Zero depth: target is cwd
 * - This uses path splitting to count directory levels
 */
export function calculateDepth(cwd: string, targetDir: string, separator: string): number {
	return cwd.split(separator).length - targetDir.split(separator).length;
}

interface ExtensionModuleManifest {
	extensions?: string[];
}

function readExtensionModuleManifest(ctx: LoadContext, packageJsonPath: string): ExtensionModuleManifest | null {
	const content = ctx.fs.readFile(packageJsonPath);
	if (!content) return null;

	const pkg = parseJSON<{ omp?: ExtensionModuleManifest; pi?: ExtensionModuleManifest }>(content);
	const manifest = pkg?.omp ?? pkg?.pi;
	if (manifest && typeof manifest === "object") {
		return manifest;
	}
	return null;
}

function isExtensionModuleFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Discover extension module entry points in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/<ext>/index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/<ext>/package.json` with "omp"/"pi" field → load declared paths
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
export function discoverExtensionModulePaths(ctx: LoadContext, dir: string): string[] {
	if (!ctx.fs.isDir(dir)) {
		return [];
	}

	const discovered: string[] = [];

	for (const name of ctx.fs.readDir(dir)) {
		if (name.startsWith(".") || name === "node_modules") continue;

		const entryPath = join(dir, name);

		// 1. Direct files: *.ts or *.js
		if (ctx.fs.isFile(entryPath) && isExtensionModuleFile(name)) {
			discovered.push(entryPath);
			continue;
		}

		// 2 & 3. Subdirectories
		if (ctx.fs.isDir(entryPath)) {
			// Check for package.json with "omp"/"pi" field first
			const packageJsonPath = join(entryPath, "package.json");
			if (ctx.fs.isFile(packageJsonPath)) {
				const manifest = readExtensionModuleManifest(ctx, packageJsonPath);
				if (manifest?.extensions && Array.isArray(manifest.extensions)) {
					for (const extPath of manifest.extensions) {
						const resolvedExtPath = resolve(entryPath, extPath);
						if (ctx.fs.isFile(resolvedExtPath)) {
							discovered.push(resolvedExtPath);
						}
					}
					continue;
				}
			}

			// Check for index.ts or index.js
			const indexTs = join(entryPath, "index.ts");
			const indexJs = join(entryPath, "index.js");
			if (ctx.fs.isFile(indexTs)) {
				discovered.push(indexTs);
			} else if (ctx.fs.isFile(indexJs)) {
				discovered.push(indexJs);
			}
		}
	}

	return discovered;
}

/**
 * Derive a stable extension name from a path.
 */
export function getExtensionNameFromPath(extensionPath: string): string {
	const base = extensionPath.replace(/\\/g, "/").split("/").pop() ?? extensionPath;

	if (base === "index.ts" || base === "index.js") {
		const parts = extensionPath.replace(/\\/g, "/").split("/");
		const parent = parts[parts.length - 2];
		return parent ?? base;
	}

	const dot = base.lastIndexOf(".");
	if (dot > 0) {
		return base.slice(0, dot);
	}

	return base;
}
