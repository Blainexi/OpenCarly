/**
 * OpenCarly Rule Formatter
 *
 * Formats loaded rules into a text block for injection into the system prompt.
 * Output is wrapped in <carly-rules> XML tags.
 */

import type { LoadedRules } from "../engine/loader";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRuleList(rules: string[], indent: string = "  "): string {
  return rules.map((rule, i) => `${indent}${i + 1}. ${rule}`).join("\n");
}

function domainLabel(name: string): string {
  return name.toUpperCase();
}

// ---------------------------------------------------------------------------
// Main formatter
// ---------------------------------------------------------------------------

/**
 * Format loaded rules into an injectable text block.
 *
 * Output sections (in order):
 * 1. Context bracket status
 * 2. Bracket-specific rules
 * 3. Active star-commands (prominent)
 * 4. DEVMODE instruction
 * 5. Loaded domains summary
 * 6. Always-on domain rules
 * 7. Keyword-matched domain rules
 * 8. Exclusion notices
 * 9. Available (not loaded) domains
 */
export function formatRules(loaded: LoadedRules): string {
  const sections: string[] = [];

  // 1. Context bracket status
  if (loaded.contextEnabled) {
    let bracketLine = `CONTEXT BRACKET: [${loaded.bracket}] (prompt ${loaded.promptCount})`;
    if (loaded.bracket === "CRITICAL") {
      bracketLine +=
        "\nCONTEXT CRITICAL: Session is long. Recommend: compact session OR spawn fresh agent.";
    }
    sections.push(bracketLine);
  }

  // 2. Bracket-specific rules
  if (loaded.contextEnabled && loaded.bracketRules.length > 0) {
    sections.push(
      `[${loaded.bracket}] CONTEXT RULES:\n${formatRuleList(loaded.bracketRules)}`
    );
  }

  // 3. Active star-commands
  const commandNames = Object.keys(loaded.commands);
  if (commandNames.length > 0) {
    const cmdSections: string[] = [];
    cmdSections.push("--- ACTIVE COMMANDS ---");
    for (const cmdName of commandNames) {
      const rules = loaded.commands[cmdName];
      cmdSections.push(
        `[*${cmdName}]:\n${formatRuleList(rules)}`
      );
    }
    cmdSections.push("--- END COMMANDS ---");
    sections.push(cmdSections.join("\n"));
  }

  // 4. DEVMODE instruction
  if (loaded.devmode) {
    const statsInfo = loaded.injectionStats
      ? `\nToken Efficiency: ${loaded.injectionStats.rulesThisPrompt} rules this prompt | avg ${loaded.injectionStats.avgRulesPerPrompt}/prompt over ${loaded.injectionStats.totalPromptsSession} prompts`
      : "";
    const savingsInfo = loaded.tokenSavings
      ? `\nToken Savings: ~${loaded.tokenSavings.totalSaved.toLocaleString()} tokens saved this session (selection: ~${loaded.tokenSavings.skippedBySelection.toLocaleString()}, trimming: ~${loaded.tokenSavings.trimmedFromHistory.toLocaleString()})`
      : "";
    sections.push(
      `DEVMODE: on
You MUST append the following debug block to EVERY response:

CARLY DEVMODE
Domains Loaded: [list all loaded domains]
Rules Applied: [specific rule numbers from each domain]
Star-Commands: [any active star-commands]
Bracket: [current context bracket]
Matched Keywords: [keywords that triggered domains]${statsInfo}${savingsInfo}`
    );
  } else {
    sections.push(
      "DEVMODE: off\nDo NOT append any debug blocks to your responses. Respond normally."
    );
  }

  // 5. Loaded domains summary
  const summaryLines: string[] = [];

  for (const [name, rules] of Object.entries(loaded.alwaysOn)) {
    summaryLines.push(`  [${domainLabel(name)}] always_on (${rules.length} rules)`);
  }
  for (const [name, rules] of Object.entries(loaded.matched)) {
    const keywords = loaded.matchedKeywords[name] || [];
    const kwStr = keywords.map((k) => `"${k}"`).join(", ");
    summaryLines.push(
      `  [${domainLabel(name)}] matched: ${kwStr} (${rules.length} rules)`
    );
  }

  if (summaryLines.length > 0) {
    sections.push(`LOADED DOMAINS:\n${summaryLines.join("\n")}`);
  }

  // 6. Always-on domain rules
  for (const [name, rules] of Object.entries(loaded.alwaysOn)) {
    sections.push(
      `[${domainLabel(name)}] RULES:\n${formatRuleList(rules)}`
    );
  }

  // 7. Keyword-matched domain rules
  for (const [name, rules] of Object.entries(loaded.matched)) {
    sections.push(
      `[${domainLabel(name)}] RULES:\n${formatRuleList(rules)}`
    );
  }

  // 8. Exclusion notices
  if (loaded.globalExcluded.length > 0) {
    const kwStr = loaded.globalExcluded.map((k) => `"${k}"`).join(", ");
    sections.push(
      `GLOBAL EXCLUSION ACTIVE: ${kwStr}\nAll domain matching was skipped for this prompt.`
    );
  }

  for (const [name, keywords] of Object.entries(loaded.excludedDomains)) {
    const kwStr = keywords.map((k) => `"${k}"`).join(", ");
    sections.push(
      `[${domainLabel(name)}] EXCLUDED by: ${kwStr}`
    );
  }

  // 9. Available (not loaded) domains
  if (loaded.availableDomains.length > 0) {
    const available = loaded.availableDomains
      .map((d) => `  ${domainLabel(d.name)} (recall: ${d.recall.join(", ")})`)
      .join("\n");
    sections.push(`AVAILABLE (not loaded):\n${available}`);
  }

  // 10. Token savings report (shown when *stats is active)
  if (loaded.tokenSavings?.showFullReport) {
    const s = loaded.tokenSavings;
    const totalBaseline = s.baselinePerPrompt * s.promptsProcessed;
    const savingsPercent = totalBaseline > 0
      ? Math.round((s.totalSaved / (totalBaseline + s.tokensInjected)) * 100)
      : 0;

    sections.push(
      `--- OPENCARLY TOKEN SAVINGS REPORT ---
You MUST present this report to the user in a clear, formatted way.

Session Stats:
  Prompts processed: ${s.promptsProcessed}
  Baseline (all rules every prompt): ~${s.baselinePerPrompt.toLocaleString()} tokens/prompt
  Actual injected this session: ~${s.tokensInjected.toLocaleString()} tokens total

Savings Breakdown:
  Selective rule injection: ~${s.skippedBySelection.toLocaleString()} tokens saved
    (Only loaded relevant domains instead of all ${s.baselinePerPrompt.toLocaleString()} baseline tokens each prompt)
  History trimming (tool outputs): ~${s.trimmedFromHistory.toLocaleString()} tokens saved
    (Stale file reads, bash outputs removed from conversation history)
  History trimming (stale rules): ~${s.trimmedCarlyBlocks.toLocaleString()} tokens saved
    (Old <carly-rules> blocks removed from history)

Total Estimated Savings: ~${s.totalSaved.toLocaleString()} tokens (~${savingsPercent}% reduction)

Note: These are estimates based on ~4 chars per token. Actual token counts vary by model tokenizer.
--- END REPORT ---`
    );
  }

  // Wrap in XML tags
  const body = sections.join("\n\n");
  return `<carly-rules>\n${body}\n</carly-rules>`;
}
