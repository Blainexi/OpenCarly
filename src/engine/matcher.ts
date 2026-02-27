/**
 * OpenCarly Domain Matcher
 *
 * Scans user prompts for domain recall keywords and star-commands.
 * Handles global and per-domain exclusions.
 */

import type { Manifest } from "../config/schema";
import { minimatch } from "minimatch";

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
  const matches = prompt.matchAll(/(?:^|\s)\*([a-zA-Z]\w*)/g);
  for (const match of matches) {
    commands.push(match[1].toLowerCase());
  }

  return [...new Set(commands)]; // deduplicate
}

// ---------------------------------------------------------------------------
// Path and Glob Matching
// ---------------------------------------------------------------------------

export function isPathMatch(filePath: string, patterns: string[]): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/");
  for (const pattern of patterns) {
    let p = pattern;
    if (!p.startsWith("**") && !p.startsWith("/") && p.includes("/")) {
      p = "**/" + p;
    }
    
    if (minimatch(normalizedPath, p, { matchBase: !p.includes("/") })) {
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
  const paths = new Set<string>();
  
  // Use matchAll to avoid allocating a huge array from split()
  const matches = prompt.matchAll(/\S+/g);
  for (const match of matches) {
    const word = match[0];
    let cleanWord = word.replace(/[:,][0-9]+(?:[:,][0-9]+)?$/, "").replace(/[.,;:!?)$'"]+$/, "").replace(/^['"(]+/, "");
    
    // Force V8 to allocate a new flat string instead of retaining a slice of the potentially massive prompt
    cleanWord = Buffer.from(cleanWord).toString();
    
    if (cleanWord.includes("/") || /\.(ts|js|jsx|tsx|py|go|rs|java|c|cpp|h|hpp|md|json|yml|yaml|txt|sh|html|css|scss|less|toml)$/i.test(cleanWord)) {
      paths.add(cleanWord);
    }
  }
  
  return Array.from(paths);
}

// ---------------------------------------------------------------------------
// Keyword matching
// ---------------------------------------------------------------------------

const regexCache = new Map<string, RegExp>();

function getCachedRegex(keywordLower: string): RegExp {
  if (regexCache.has(keywordLower)) return regexCache.get(keywordLower)!;
  
  const escaped = keywordLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = "(?<=^|\\W)";
  const suffix = "(?=\\W|$)";
  const regex = new RegExp(prefix + escaped + suffix, "i");
  
  regexCache.set(keywordLower, regex);
  return regex;
}

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

    if (!promptLower.includes(keywordLower)) continue;

    const regex = getCachedRegex(keywordLower);
    if (regex.test(promptLower)) {
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
