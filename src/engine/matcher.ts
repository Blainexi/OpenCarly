/**
 * OpenCarly Domain Matcher
 *
 * Scans user prompts for domain recall keywords and star-commands.
 * Handles global and per-domain exclusions.
 */

import type { Manifest } from "../config/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MatchResult {
  /** Domains matched via recall keywords: { domainName: matchedKeywords[] } */
  matched: Record<string, string[]>;

  /** Domains excluded by per-domain exclusion: { domainName: excludingKeywords[] } */
  excluded: Record<string, string[]>;

  /** Global exclusion keywords that were found (blocks all matching) */
  globalExcluded: string[];

  /** Star-commands detected (lowercase, without asterisk) */
  starCommands: string[];

  /** Always-on domains that are active */
  alwaysOn: string[];
}

// ---------------------------------------------------------------------------
// Star-command detection
// ---------------------------------------------------------------------------

const STAR_COMMAND_REGEX = /\*([a-zA-Z]\w*)/g;

/**
 * Detect star-commands in the prompt.
 * e.g. "*brief *dev explain this" -> ["brief", "dev"]
 */
export function detectStarCommands(prompt: string): string[] {
  const commands: string[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  STAR_COMMAND_REGEX.lastIndex = 0;

  while ((match = STAR_COMMAND_REGEX.exec(prompt)) !== null) {
    commands.push(match[1].toLowerCase());
  }

  return [...new Set(commands)]; // deduplicate
}

// ---------------------------------------------------------------------------
// Keyword matching
// ---------------------------------------------------------------------------

/**
 * Check if any keywords from the list appear in the prompt (case-insensitive substring match).
 * Returns the list of matching keywords.
 */
function findMatchingKeywords(
  prompt: string,
  keywords: string[]
): string[] {
  const promptLower = prompt.toLowerCase();
  const matches: string[] = [];

  for (const keyword of keywords) {
    const keywordLower = keyword.toLowerCase().trim();
    if (keywordLower === "") continue;

    // Escape regex special chars and do substring match
    const escaped = keywordLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(escaped).test(promptLower)) {
      matches.push(keyword);
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Main matching function
// ---------------------------------------------------------------------------

/**
 * Match domains against a user prompt.
 *
 * Algorithm:
 * 1. Check globalExclude - if any match, skip all domain matching
 * 2. Collect always-on active domains
 * 3. For each active, non-alwaysOn domain:
 *    a. Check per-domain exclude keywords
 *    b. Check recall keywords
 * 4. Detect star-commands
 */
export function matchDomains(prompt: string, manifest: Manifest): MatchResult {
  const result: MatchResult = {
    matched: {},
    excluded: {},
    globalExcluded: [],
    starCommands: [],
    alwaysOn: [],
  };

  // 1. Check global exclusions
  if (manifest.globalExclude.length > 0) {
    const globalMatches = findMatchingKeywords(prompt, manifest.globalExclude);
    if (globalMatches.length > 0) {
      result.globalExcluded = globalMatches;
      // Still detect star-commands even when globally excluded
      result.starCommands = detectStarCommands(prompt);
      return result;
    }
  }

  // 2-3. Process each domain
  for (const [name, domain] of Object.entries(manifest.domains)) {
    // Skip inactive domains
    if (domain.state === "inactive") continue;

    // Collect always-on domains
    if (domain.alwaysOn) {
      result.alwaysOn.push(name);
      continue; // always-on domains don't need keyword matching
    }

    // Check per-domain exclusions
    if (domain.exclude.length > 0) {
      const excludeMatches = findMatchingKeywords(prompt, domain.exclude);
      if (excludeMatches.length > 0) {
        result.excluded[name] = excludeMatches;
        continue;
      }
    }

    // Check recall keywords
    if (domain.recall.length > 0) {
      const recallMatches = findMatchingKeywords(prompt, domain.recall);
      if (recallMatches.length > 0) {
        result.matched[name] = recallMatches;
      }
    }
  }

  // 4. Detect star-commands
  result.starCommands = detectStarCommands(prompt);

  return result;
}
