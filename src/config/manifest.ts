/**
 * OpenCarly Config Loader
 *
 * Parses and validates manifest.json, commands.json, and context.json
 * from the discovered .opencarly/ directory.
 */

import * as fs from "fs";
import * as path from "path";
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
 * Load all configuration from a .opencarly/ directory.
 * Validates against Zod schemas. Throws on invalid config.
 */
export function loadConfig(configPath: string): CarlyConfig {
  // manifest.json (required)
  const manifestPath = path.join(configPath, "manifest.json");
  const manifestRaw = readJsonFile(manifestPath);
  if (manifestRaw === null) {
    throw new Error(`OpenCarly: manifest.json not found at ${manifestPath}`);
  }
  const manifest = ManifestSchema.parse(manifestRaw);

  // commands.json (optional - defaults to empty)
  const commandsPath = path.join(configPath, "commands.json");
  const commandsRaw = readJsonFile(commandsPath);
  const commands =
    commandsRaw !== null ? CommandsFileSchema.parse(commandsRaw) : {};

  // context.json (optional - defaults to empty with default thresholds)
  const contextPath = path.join(configPath, "context.json");
  const contextRaw = readJsonFile(contextPath);
  const context =
    contextRaw !== null
      ? ContextFileSchema.parse(contextRaw)
      : ContextFileSchema.parse({});

  return { manifest, commands, context, configPath };
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
