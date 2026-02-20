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

  /** Domains matched via file paths: { domainName: matchedPaths[] } */
  matchedPaths: Record<string, string[]>;

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

/**
 * Detect star-commands in the prompt.
 * e.g. "*brief *dev explain this" -> ["brief", "dev"]
 */
export function detectStarCommands(prompt: string): string[] {
  const commands: string[] = [];
  
  // Use matchAll to avoid global RegExp state mutation race conditions
  const matches = prompt.matchAll(/\*([a-zA-Z]\w*)/g);
  for (const match of matches) {
    commands.push(match[1].toLowerCase());
  }

  return [...new Set(commands)]; // deduplicate
}

// ---------------------------------------------------------------------------
// Path and Glob Matching
// ---------------------------------------------------------------------------

const globRegexCache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  if (globRegexCache.has(glob)) return globRegexCache.get(glob)!;

  let escaped = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (/[.+^${}()|[\]\\]/.test(c)) {
      escaped += "\\" + c;
    } else {
      escaped += c;
    }
  }
  const regexStr = "^" + escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".") + "$";
  const regex = new RegExp(regexStr);
  globRegexCache.set(glob, regex);
  return regex;
}

/**
 * Check if a file path matches any of the given glob patterns.
 */
export function isPathMatch(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(filePath)) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts possible file paths from a user prompt.
 * Looks for words containing `/` or a file extension (like `.ts`).
 */
function extractPathsFromPrompt(prompt: string): string[] {
  const words = prompt.split(/\s+/);
  const paths: string[] = [];
  
  for (const word of words) {
    // Strip trailing punctuation
    const cleanWord = word.replace(/[.,;:!?)$'"]+$/, "").replace(/^['"(]+/, "");
    if (cleanWord.includes("/") || /\.[a-z0-9]{1,4}$/i.test(cleanWord)) {
      paths.push(cleanWord);
    }
  }
  
  return [...new Set(paths)];
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

    // Escape regex special chars and do boundary match
    const escaped = keywordLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|\\W)${escaped}($|\\W)`, "i").test(promptLower)) {
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
export function matchDomains(
  prompt: string, 
  manifest: Manifest, 
  activeFiles: string[] = []
): MatchResult {
  const result: MatchResult = {
    matched: {},
    matchedPaths: {},
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

  // Extract possible paths from user prompt and combine with activeFiles
  const promptPaths = extractPathsFromPrompt(prompt);
  const allActiveFiles = [...new Set([...activeFiles, ...promptPaths])];

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

    // Check file paths first
    if (domain.paths && domain.paths.length > 0) {
      const pathMatches: string[] = [];
      for (const file of allActiveFiles) {
        if (isPathMatch(file, domain.paths)) {
          pathMatches.push(file);
        }
      }
      
      if (pathMatches.length > 0) {
        result.matchedPaths[name] = pathMatches;
        // Skip keyword recall check if path triggered it
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
