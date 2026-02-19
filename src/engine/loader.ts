/**
 * OpenCarly Rule Loader
 *
 * Loads rules from domain .md files, star-commands, and context brackets
 * based on match results from the matcher.
 */

import * as path from "path";
import { parseDomainFile } from "../config/manifest";
import type { CarlyConfig } from "../config/manifest";
import type { MatchResult } from "./matcher";
import type { BracketResult } from "./brackets";
import type { BracketName, DomainConfig } from "../config/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoadedRules {
  /** Always-on domain rules: { domainName: rules[] } */
  alwaysOn: Record<string, string[]>;

  /** Keyword-matched domain rules: { domainName: rules[] } */
  matched: Record<string, string[]>;

  /** Star-command rules: { commandName: rules[] } */
  commands: Record<string, string[]>;

  /** Context bracket rules for the current bracket */
  bracketRules: string[];

  /** Current context bracket name */
  bracket: BracketName;

  /** Prompt count info for display */
  promptCount: number;

  /** Bracket threshold for display */
  bracketThreshold: number;

  /** Keywords that triggered each matched domain */
  matchedKeywords: Record<string, string[]>;

  /** Domains excluded and why */
  excludedDomains: Record<string, string[]>;

  /** Global exclusion keywords found */
  globalExcluded: string[];

  /** Whether DEVMODE is active */
  devmode: boolean;

  /** Whether context bracket system is enabled */
  contextEnabled: boolean;

  /** Whether commands system is enabled */
  commandsEnabled: boolean;

  /** Domains that are available but not loaded (for summary) */
  availableDomains: Array<{ name: string; recall: string[] }>;

  /** Injection stats for DEVMODE display (populated by plugin entry point) */
  injectionStats: {
    rulesThisPrompt: number;
    totalRulesSession: number;
    totalPromptsSession: number;
    avgRulesPerPrompt: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Domain rule loading
// ---------------------------------------------------------------------------

/**
 * Load rules from a single domain's .md file.
 */
function loadDomainRules(
  _domainName: string,
  domain: DomainConfig,
  configPath: string
): string[] {
  const filePath = path.join(configPath, domain.file);
  return parseDomainFile(filePath);
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

/**
 * Load all rules based on match results, config, and current bracket.
 */
export function loadRules(
  matchResult: MatchResult,
  config: CarlyConfig,
  bracket: BracketResult,
  promptCount: number
): LoadedRules {
  const { manifest, commands, configPath } = config;

  const loaded: LoadedRules = {
    alwaysOn: {},
    matched: {},
    commands: {},
    bracketRules: [],
    bracket: bracket.name,
    promptCount,
    bracketThreshold: bracket.threshold,
    matchedKeywords: matchResult.matched,
    excludedDomains: matchResult.excluded,
    globalExcluded: matchResult.globalExcluded,
    devmode: manifest.devmode,
    contextEnabled: manifest.context.state === "active",
    commandsEnabled: manifest.commands.state === "active",
    availableDomains: [],
    injectionStats: null,
  };

  // Load always-on domain rules
  for (const domainName of matchResult.alwaysOn) {
    const domain = manifest.domains[domainName];
    if (domain) {
      const rules = loadDomainRules(domainName, domain, configPath);
      if (rules.length > 0) {
        loaded.alwaysOn[domainName] = rules;
      }
    }
  }

  // Load keyword-matched domain rules
  for (const domainName of Object.keys(matchResult.matched)) {
    const domain = manifest.domains[domainName];
    if (domain) {
      const rules = loadDomainRules(domainName, domain, configPath);
      if (rules.length > 0) {
        loaded.matched[domainName] = rules;
      }
    }
  }

  // Load star-command rules
  if (manifest.commands.state === "active" && matchResult.starCommands.length > 0) {
    for (const cmdName of matchResult.starCommands) {
      const cmd = commands[cmdName];
      if (cmd && cmd.rules.length > 0) {
        loaded.commands[cmdName] = cmd.rules;
      }
    }
  }

  // Load context bracket rules
  if (manifest.context.state === "active") {
    loaded.bracketRules = bracket.rules;
  }

  // Collect available but not loaded domains (for summary)
  for (const [name, domain] of Object.entries(manifest.domains)) {
    if (domain.state === "inactive") continue;
    if (domain.alwaysOn) continue;

    // Skip if already matched or excluded
    if (matchResult.matched[name]) continue;
    if (matchResult.excluded[name]) continue;

    if (domain.recall.length > 0) {
      loaded.availableDomains.push({ name, recall: domain.recall });
    }
  }

  return loaded;
}
