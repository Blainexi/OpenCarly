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
function readJsonFile(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
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
export function loadConfig(configPath: string): CarlyConfig {
  const warnings: string[] = [];

  // manifest.json (required)
  const manifestPath = path.join(configPath, "manifest.json");
  const manifestRaw = readJsonFile(manifestPath);
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
    if (!fs.existsSync(domainFilePath)) {
      warnings.push(
        `Domain "${name}" references file "${domain.file}" which does not exist`
      );
    }
  }

  // commands.json (optional - defaults to empty)
  const commandsPath = path.join(configPath, "commands.json");
  let commands: CommandsFile = {};
  const commandsRaw = readJsonFile(commandsPath);

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
  const contextRaw = readJsonFile(contextPath);

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

/**
 * Parse a domain rule file (.md).
 *
 * Extracts rules from bullet points (lines starting with "- ").
 * Ignores headings (#), empty lines, and other markdown.
 */
export function parseDomainFile(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const rules: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("- ")) {
      rules.push(trimmed.slice(2).trim());
    }
  }

  return rules;
}

/**
 * Reload config from disk. Used when config might have changed
 * (e.g., user edited manifest.json via /carly command).
 */
export function reloadConfig(configPath: string): CarlyConfig {
  return loadConfig(configPath);
}
