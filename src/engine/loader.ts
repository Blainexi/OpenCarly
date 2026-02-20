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

  /** Cumulative token savings for the session (populated by plugin entry point) */
  tokenSavings: {
    /** Tokens saved by not loading all rules every prompt */
    skippedBySelection: number;
    /** Tokens trimmed from conversation history (tool outputs) */
    trimmedFromHistory: number;
    /** Tokens trimmed from stale carly-rules blocks */
    trimmedCarlyBlocks: number;
    /** Total tokens of rules actually injected this session */
    tokensInjected: number;
    /** Baseline: what all rules would cost per prompt */
    baselinePerPrompt: number;
    /** Total estimated savings */
    totalSaved: number;
    /** Prompts processed */
    promptsProcessed: number;
    /** Whether *stats command is active (show full report) */
    showFullReport: boolean;
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
// Baseline calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the "all rules loaded every prompt" baseline.
 * This is what you'd get if you put everything in AGENTS.md.
 * Returns estimated tokens per prompt.
 */
export function calculateBaseline(config: CarlyConfig): number {
  const { manifest, commands, configPath } = config;
  let totalRuleText = 0;

  // All domain rules
  for (const [, domain] of Object.entries(manifest.domains)) {
    if (domain.state === "inactive") continue;
    const filePath = path.join(configPath, domain.file);
    const rules = parseDomainFile(filePath);
    for (const rule of rules) {
      totalRuleText += rule.length;
    }
  }

  // All star-command rules
  for (const [, cmd] of Object.entries(commands)) {
    for (const rule of cmd.rules) {
      totalRuleText += rule.length;
    }
  }

  // All bracket rules
  const { context } = config;
  const bracketRuleLengths = [
    context.brackets.fresh.rules.join("").length,
    context.brackets.moderate.rules.join("").length,
    context.brackets.depleted.rules.join("").length,
  ];
  totalRuleText += bracketRuleLengths.reduce((a, b) => a + b, 0);

  // Convert chars to estimated tokens
  return Math.ceil(totalRuleText / 4);
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
    tokenSavings: null,
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
