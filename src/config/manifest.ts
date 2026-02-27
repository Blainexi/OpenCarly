/**
 * OpenCarly Config Loader
 *
 * Parses and validates manifest.json, commands.json, and context.json
 * from the discovered .opencarly/ directory.
 * Collects warnings for non-fatal issues instead of silently ignoring them.
 */

import * as fs from "fs";
import * as path from "path";
import { ZodError } from "zod";
import {
  ManifestSchema,
  CommandsFileSchema,
  ContextFileSchema,
  type Manifest,
  type CommandsFile,
  type ContextFile,
} from "./schema";

export interface CarlyConfig {
  /** Parsed and validated manifest */
  manifest: Manifest;

  /** Parsed and validated star-commands (empty object if commands.json missing) */
  commands: CommandsFile;

  /** Parsed and validated context brackets (defaults if context.json missing) */
  context: ContextFile;

  /** Absolute path to the .opencarly/ directory */
  configPath: string;

  /** Non-fatal warnings encountered during config loading */
  warnings: string[];
}

/**
 * Read and parse a JSON file. Returns null if file doesn't exist.
 * Throws on invalid JSON.
 */
async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Format Zod errors into human-readable messages.
 */
function formatZodErrors(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  ${path}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Load all configuration from a .opencarly/ directory.
 * Validates against Zod schemas. Collects warnings for non-fatal issues.
 * Throws only when manifest.json is missing entirely.
 */
export async function loadConfig(configPath: string): Promise<CarlyConfig> {
  const warnings: string[] = [];

  // manifest.json (required)
  const manifestPath = path.join(configPath, "manifest.json");
  const manifestRaw = await readJsonFile(manifestPath);
  if (manifestRaw === null) {
    throw new Error(`OpenCarly: manifest.json not found at ${manifestPath}`);
  }

  let manifest: Manifest;
  try {
    manifest = ManifestSchema.parse(manifestRaw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(
        `OpenCarly: manifest.json validation failed:\n${formatZodErrors(err)}`
      );
    }
    throw err;
  }

  // Validate domain file references exist
  for (const [name, domain] of Object.entries(manifest.domains)) {
    const domainFilePath = path.join(configPath, domain.file);
    try {
      await fs.promises.access(domainFilePath);
    } catch {
      warnings.push(
        `Domain "${name}" references file "${domain.file}" which does not exist`
      );
    }
  }

  // commands.json (optional - defaults to empty)
  const commandsPath = path.join(configPath, "commands.json");
  let commands: CommandsFile = {};
  const commandsRaw = await readJsonFile(commandsPath);

  if (commandsRaw !== null) {
    try {
      commands = CommandsFileSchema.parse(commandsRaw);
    } catch (err) {
      if (err instanceof ZodError) {
        warnings.push(
          `commands.json has validation errors (using defaults):\n${formatZodErrors(err)}`
        );
      } else if (err instanceof SyntaxError) {
        warnings.push(`commands.json has invalid JSON syntax (using defaults)`);
      }
    }
  }

  // context.json (optional - defaults to empty with default thresholds)
  const contextPath = path.join(configPath, "context.json");
  let context: ContextFile = ContextFileSchema.parse({});
  const contextRaw = await readJsonFile(contextPath);

  if (contextRaw !== null) {
    try {
      context = ContextFileSchema.parse(contextRaw);
    } catch (err) {
      if (err instanceof ZodError) {
        warnings.push(
          `context.json has validation errors (using defaults):\n${formatZodErrors(err)}`
        );
      } else if (err instanceof SyntaxError) {
        warnings.push(`context.json has invalid JSON syntax (using defaults)`);
      }
    }
  }

  // Validate context thresholds make sense
  if (context.thresholds.moderate >= context.thresholds.depleted) {
    warnings.push(
      `context.json: moderate threshold (${context.thresholds.moderate}) should be less than depleted (${context.thresholds.depleted})`
    );
  }
  if (context.thresholds.depleted >= context.thresholds.critical) {
    warnings.push(
      `context.json: depleted threshold (${context.thresholds.depleted}) should be less than critical (${context.thresholds.critical})`
    );
  }

  return { manifest, commands, context, configPath, warnings };
}

const domainFileCache = new Map<string, { mtimeMs: number; rules: string[] }>();

/**
 * Parse a domain rule file (.md).
 *
 * Extracts rules from bullet points (lines starting with "- ") and free text.
 * Ignores headings (#) and empty lines.
 * Uses a memory cache based on file modification time.
 */
export async function parseDomainFile(filePath: string): Promise<string[]> {
  let content: string;
  try {
    const stats = await fs.promises.stat(filePath);
    const cached = domainFileCache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs) {
      return cached.rules;
    }
    content = await fs.promises.readFile(filePath, "utf-8");
    content = content.replace(/\r\n/g, "\n");
    
    const rules = parseDomainFileContent(content);
    domainFileCache.set(filePath, { mtimeMs: stats.mtimeMs, rules });
    return rules;
  } catch {
    return [];
  }
}

function parseDomainFileContent(content: string): string[] {
  const lines = content.split("\n");
  const rules: string[] = [];
  let currentRule = "";
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
    }

    // Ignore headings but break the current rule
    // Only match headings (starts with # followed by space, or ##+) to avoid breaking on `#comment` inside rules
    if (!inCodeBlock && /^#+(\s|$)/.test(trimmed)) {
      if (currentRule) {
        rules.push(currentRule.trim());
        currentRule = "";
      }
      continue;
    }

    // A list marker starts a new rule ONLY if it's not indented (starts at beginning of line)
    const match = line.match(/^([-*+]|\d+\.)\s+(.*)/);
    
    if (!inCodeBlock && match) {
      if (currentRule) {
        rules.push(currentRule.trim());
      }
      currentRule = match[2]; // Start new rule without the list marker
    } else {
      // If we're inside a rule, append the line (preserve leading spaces for code blocks and nested lists)
      if (currentRule) {
        currentRule += "\n" + line;
      } else if (trimmed !== "") {
        // Fix: If we aren't in a rule yet but encounter text, start a new rule
        currentRule = line;
      }
    }
  }

  if (currentRule) {
    rules.push(currentRule.trim());
  }

  return rules;
}

/**
 * Reload config from disk. Used when config might have changed
 * (e.g., user edited manifest.json via /carly command).
 */
export async function reloadConfig(configPath: string): Promise<CarlyConfig> {
  return await loadConfig(configPath);
}
