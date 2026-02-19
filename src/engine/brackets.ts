/**
 * OpenCarly Context Bracket Resolution
 *
 * Maps prompt count to a context bracket (FRESH, MODERATE, DEPLETED, CRITICAL).
 * Uses configurable thresholds from context.json.
 */

import type { ContextFile, BracketName } from "../config/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BracketResult {
  /** Current bracket name */
  name: BracketName;

  /** Rules for the current bracket */
  rules: string[];

  /** The threshold that was crossed (for display) */
  threshold: number;
}

// ---------------------------------------------------------------------------
// Bracket resolution
// ---------------------------------------------------------------------------

/**
 * Determine the active context bracket based on prompt count.
 *
 * Brackets (from least to most urgent):
 * - FRESH: promptCount < moderate threshold
 * - MODERATE: promptCount >= moderate but < depleted
 * - DEPLETED: promptCount >= depleted but < critical
 * - CRITICAL: promptCount >= critical (uses DEPLETED rules + warning)
 */
export function getBracket(
  promptCount: number,
  context: ContextFile
): BracketResult {
  const { thresholds, brackets } = context;

  if (promptCount >= thresholds.critical) {
    // CRITICAL uses depleted rules (same as CARL behavior)
    return {
      name: "CRITICAL",
      rules: brackets.depleted.enabled ? brackets.depleted.rules : [],
      threshold: thresholds.critical,
    };
  }

  if (promptCount >= thresholds.depleted) {
    return {
      name: "DEPLETED",
      rules: brackets.depleted.enabled ? brackets.depleted.rules : [],
      threshold: thresholds.depleted,
    };
  }

  if (promptCount >= thresholds.moderate) {
    return {
      name: "MODERATE",
      rules: brackets.moderate.enabled ? brackets.moderate.rules : [],
      threshold: thresholds.moderate,
    };
  }

  return {
    name: "FRESH",
    rules: brackets.fresh.enabled ? brackets.fresh.rules : [],
    threshold: 0,
  };
}
