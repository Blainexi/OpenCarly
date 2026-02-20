/**
 * OpenCarly - Context Augmentation & Reinforcement Layer for OpenCode
 *
 * Dynamic rules that load when relevant, disappear when not.
 * Replicates CARL (https://github.com/ChristopherKahler/carl) for OpenCode.
 *
 * Hook flow per user message:
 * 1. chat.message -> scan prompt for keywords + star-commands, update session
 * 2. experimental.chat.system.transform -> load rules, format, inject into system prompt
 * 3. experimental.chat.messages.transform -> smart trim stale tool outputs + carly-rules
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { discoverConfig } from "./config/discovery";
import { loadConfig, type CarlyConfig } from "./config/manifest";
import type { SessionConfig, TokenStats } from "./config/schema";
import { matchDomains, type MatchResult } from "./engine/matcher";
import { loadRules, calculateBaseline } from "./engine/loader";
import { getBracket } from "./engine/brackets";
import { trimMessageHistory } from "./engine/trimmer";
import { formatRules } from "./formatter/formatter";
import {
  getOrCreateSession,
  updateSessionActivity,
  saveSession,
  applySessionOverrides,
  cleanStaleSessions,
  loadCumulativeStats,
  updateCumulativeStats,
  filterSessionsByDuration,
  clearAllStats,
  type CumulativeStats,
} from "./session/session";

// ---------------------------------------------------------------------------
// Plugin state (shared between hooks via closure)
// ---------------------------------------------------------------------------

interface PluginState {
  config: CarlyConfig;
  sessions: Map<string, SessionConfig>;
  /** Match result from the latest chat.message hook, keyed by sessionID */
  lastMatch: Map<string, MatchResult>;
  /** Prompt text from the latest chat.message, keyed by sessionID */
  lastPrompt: Map<string, string>;
  /** Most recently active session ID (for hooks without sessionID) */
  activeSessionID: string | null;
  /** Baseline: estimated tokens if all rules loaded every prompt */
  baselineTokensPerPrompt: number;
  /** Cumulative stats from all sessions (loaded from stats.json) */
  cumulativeStats: CumulativeStats;
  /**
   * When user invokes *stats, store a preformatted report here keyed by sessionID.
   * experimental.chat.messages.transform will emit it as a synthetic assistant message.
   */
  pendingStatsReportBySession: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Logger helper
// ---------------------------------------------------------------------------

type LogFn = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
) => Promise<void>;

function createLogger(
  client: { app: { log: (opts: { body: { service: string; level: string; message: string; extra?: Record<string, unknown> } }) => Promise<unknown> } }
): LogFn {
  return async (level, message, extra) => {
    try {
      await client.app.log({
        body: {
          service: "opencarly",
          level,
          message,
          extra,
        },
      });
    } catch {
      // Logging failure should never crash the plugin
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain text from message parts.
 */
function extractPromptText(parts: Array<{ type: string; [key: string]: unknown }>): string {
  const textParts: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push(part.text);
    }
  }
  return textParts.join("\n");
}

/**
 * Count total rules across a record of domain -> rules[].
 */
function countRules(domains: Record<string, string[]>): number {
  let count = 0;
  for (const rules of Object.values(domains)) {
    count += rules.length;
  }
  return count;
}

/**
 * Estimate tokens from a rule array (~4 chars per token).
 */
function estimateRuleTokens(rules: Record<string, string[]>): number {
  let chars = 0;
  for (const ruleList of Object.values(rules)) {
    for (const rule of ruleList) {
      chars += rule.length;
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Estimate tokens from a string.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build a token savings report string for direct injection into system prompt.
 * This ensures the report displays reliably regardless of Plan Mode or AI following rules.
 */
function buildTokenReport(
  stats: {
    tokensSkippedBySelection: number;
    tokensInjected: number;
    tokensTrimmedFromHistory: number;
    tokensTrimmedCarlyBlocks: number;
    promptsProcessed: number;
    baselineTokensPerPrompt: number;
  },
  _baselinePerPrompt: number,
  filtered: {
    filteredSessions: Array<{
      sessionId: string;
      date: string;
      tokensSaved: number;
      promptsProcessed: number;
    }>;
    filteredTotal: number;
    durationLabel: string;
  }
): string {
  // Current session stats
  const totalSaved =
    stats.tokensSkippedBySelection +
    stats.tokensTrimmedFromHistory +
    stats.tokensTrimmedCarlyBlocks;

  // Format session history (most recent first, last 10)
  const recentSessions = filtered.filteredSessions
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 10)
    .map((s) => {
      const date = new Date(s.date).toISOString().split("T")[0];
      return `  ${s.sessionId.slice(0, 12)}... | ${date} | ~${s.tokensSaved.toLocaleString()} tokens | ${s.promptsProcessed} prompts`;
    })
    .join("\n");

  return `
============================================================
OPENCARLY TOKEN SAVINGS REPORT
============================================================

CURRENT SESSION:
  Prompts processed: ${stats.promptsProcessed}
  Tokens saved this session: ~${totalSaved.toLocaleString()}
  - Selective rule injection: ~${stats.tokensSkippedBySelection.toLocaleString()}
  - History trimming: ~${(
    stats.tokensTrimmedFromHistory + stats.tokensTrimmedCarlyBlocks
  ).toLocaleString()}

ALL-TIME (filtered by: ${filtered.durationLabel}, ${filtered.filteredSessions.length} sessions):
  Total tokens saved: ~${filtered.filteredTotal.toLocaleString()}
  Average per session: ~${Math.round(filtered.filteredTotal / Math.max(1, filtered.filteredSessions.length)).toLocaleString()}

SESSION HISTORY:
${recentSessions || "  (no previous sessions)"}

============================================================
`;
}

async function generateStatsReport(configPath: string, activeSessionId?: string): Promise<string> {
  const stats = loadCumulativeStats(configPath);
  
  let currentSessionSummary = activeSessionId 
    ? stats.sessions.find(s => s.sessionId === activeSessionId)
    : stats.sessions[stats.sessions.length - 1];
  
  let currentTokenStats = {
    tokensSkippedBySelection: 0,
    tokensTrimmedFromHistory: 0,
    tokensTrimmedCarlyBlocks: 0,
    tokensInjected: 0,
  };
  
  const targetSessionId = activeSessionId || currentSessionSummary?.sessionId;
  
  if (targetSessionId) {
    const path = await import("path");
    const sessionPath = path.join(configPath, "sessions", `${targetSessionId}.json`);
    try {
      const fs = await import("fs");
      const sessionData = JSON.parse(await fs.promises.readFile(sessionPath, "utf-8"));
      currentTokenStats = {
        tokensSkippedBySelection: sessionData.tokenStats?.tokensSkippedBySelection || 0,
        tokensTrimmedFromHistory: sessionData.tokenStats?.tokensTrimmedFromHistory || 0,
        tokensTrimmedCarlyBlocks: sessionData.tokenStats?.tokensTrimmedCarlyBlocks || 0,
        tokensInjected: sessionData.tokenStats?.tokensInjected || 0,
      };
      
      if (!currentSessionSummary) {
        currentSessionSummary = {
          sessionId: targetSessionId,
          date: sessionData.started || new Date().toISOString(),
          tokensSaved: (currentTokenStats.tokensSkippedBySelection + currentTokenStats.tokensTrimmedFromHistory + currentTokenStats.tokensTrimmedCarlyBlocks),
          promptsProcessed: sessionData.promptCount || 0,
          tokensSkippedBySelection: currentTokenStats.tokensSkippedBySelection,
          tokensTrimmedFromHistory: currentTokenStats.tokensTrimmedFromHistory,
          tokensTrimmedCarlyBlocks: currentTokenStats.tokensTrimmedCarlyBlocks,
          tokensInjected: currentTokenStats.tokensInjected,
          rulesInjected: sessionData.tokenStats?.rulesInjected || 0,
        };
      }
    } catch {
      // Ignore file not found or invalid JSON
    }
  }

  const formatNumber = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
  };

  const historyTrimmed = currentTokenStats.tokensTrimmedFromHistory + currentTokenStats.tokensTrimmedCarlyBlocks;

  let output = `# OPENCARLY TOKEN SAVINGS REPORT\n\n`;
  output += `## CURRENT SESSION\n`;
  output += `| Metric | Value |\n|--------|-------|\n`;
  output += `| Prompts processed | ${currentSessionSummary?.promptsProcessed || 0} |\n`;
  output += `| Tokens saved | ${formatNumber(currentSessionSummary?.tokensSaved || 0)} |\n`;
  output += `| - Selective rule injection | ${formatNumber(currentTokenStats.tokensSkippedBySelection)} |\n`;
  output += `| - History trimming | ${formatNumber(historyTrimmed)} |\n\n`;

  output += `## ALL-TIME\n`;
  output += `| Metric | Value |\n|--------|-------|\n`;
  output += `| Total tokens saved | ${formatNumber(stats.cumulative.totalTokensSaved)} |\n`;
  output += `| Sessions | ${stats.sessions.length} |\n`;
  output += `| Average per session | ${formatNumber(Math.round(stats.cumulative.totalTokensSaved / (stats.sessions.length || 1)))} |\n\n`;

  output += `## SESSION HISTORY\n`;
  for (const session of stats.sessions.slice().reverse()) {
    output += `- ${session.date?.split("T")[0] || "Unknown"}: ${formatNumber(session.tokensSaved)} tokens (${session.promptsProcessed} prompts)\n`;
  }

  return output;
}

// Plugin entry point
// ---------------------------------------------------------------------------

export const OpenCarly: Plugin = async ({ directory, client }) => {
  const log = createLogger(client as Parameters<typeof createLogger>[0]);

  // Discover config
  const discovery = discoverConfig(directory);
  if (!discovery) {
    await log("info", "No .opencarly/ config found - plugin inactive", {
      searchedFrom: directory,
    });
    return {};
  }

  await log("info", `Config found at ${discovery.configPath} (${discovery.scope})`, {
    configPath: discovery.configPath,
    scope: discovery.scope,
  });

  // Load config
  let config: CarlyConfig;
  try {
    config = loadConfig(discovery.configPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log("error", `Config loading failed: ${message}`, {
      configPath: discovery.configPath,
      error: message,
    });
    return {};
  }

  // Log warnings
  for (const warning of config.warnings) {
    await log("warn", warning, { configPath: discovery.configPath });
  }

  // Calculate baseline (all rules loaded every prompt)
  const baselineTokensPerPrompt = calculateBaseline(config);

  // Log startup summary
  const domainNames = Object.keys(config.manifest.domains);
  const commandNames = Object.keys(config.commands);
  await log("info", "OpenCarly initialized", {
    domains: domainNames,
    domainCount: domainNames.length,
    commands: commandNames,
    commandCount: commandNames.length,
    devmode: config.manifest.devmode,
    contextBrackets: config.manifest.context.state,
    commandsSystem: config.manifest.commands.state,
    baselineTokensPerPrompt,
  });

  // Initialize state
  const cumulativeStats = loadCumulativeStats(discovery.configPath);

  const state: PluginState = {
    config,
    sessions: new Map(),
    lastMatch: new Map(),
    lastPrompt: new Map(),
    activeSessionID: null,
    baselineTokensPerPrompt,
    cumulativeStats,
    pendingStatsReportBySession: new Map(),
  };

  // Clean stale sessions on startup
  try {
    const cleaned = cleanStaleSessions(discovery.configPath);
    if (cleaned > 0) {
      await log("debug", `Cleaned ${cleaned} stale session(s)`);
    }
  } catch {
    // Non-critical
  }

  return {
    // -----------------------------------------------------------------
    // Event hook: track session lifecycle and intercept commands
    // -----------------------------------------------------------------
        event: async ({ event }) => {
          if (event.type === "session.created") {
            try {
              cleanStaleSessions(discovery.configPath);
            } catch {
              // ignore
            }
          }
        },
    
        // -----------------------------------------------------------------
        // chat.message: scan prompt, detect keywords + star-commands
    // -----------------------------------------------------------------
    "chat.message": async (input, output) => {
      const { sessionID } = input;

      const promptText = extractPromptText(
        output.parts as Array<{ type: string; [key: string]: unknown }>
      );
      if (!promptText) return;

      // Get or create session
      const { session, isNew } = getOrCreateSession(
        discovery.configPath,
        sessionID,
        directory
      );

      if (isNew || !state.sessions.has(sessionID)) {
        state.sessions.set(sessionID, session);
      }

      const currentSession = state.sessions.get(sessionID)!;

      // Set baseline on session if not set
      if (currentSession.tokenStats.baselineTokensPerPrompt === 0) {
        currentSession.tokenStats.baselineTokensPerPrompt = state.baselineTokensPerPrompt;
      }

      // Update session activity
      updateSessionActivity(currentSession, promptText);

      // Apply session overrides
      const effectiveManifest = applySessionOverrides(
        state.config.manifest,
        currentSession
      );

      // Run domain matcher
      const matchResult = matchDomains(promptText, effectiveManifest);

      // Cache for system.transform hook
      state.lastMatch.set(sessionID, matchResult);
      state.lastPrompt.set(sessionID, promptText);
      state.activeSessionID = sessionID;

      // Log match results
      await log("debug", "Prompt matched", {
        sessionID,
        promptCount: currentSession.promptCount,
        alwaysOn: matchResult.alwaysOn,
        matched: Object.keys(matchResult.matched),
        excluded: Object.keys(matchResult.excluded),
        globalExcluded: matchResult.globalExcluded,
        starCommands: matchResult.starCommands,
      });

      // Persist session
      try {
        saveSession(discovery.configPath, currentSession);
      } catch {
        // Non-critical
      }
    },

    // -----------------------------------------------------------------
    // experimental.chat.system.transform: inject rules into system prompt
    // -----------------------------------------------------------------
    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID;
      if (!sessionID) return;

      const matchResult = state.lastMatch.get(sessionID);
      if (!matchResult) return;

      const session = state.sessions.get(sessionID);
      const promptCount = session?.promptCount ?? 1;
      const tokenStats: TokenStats = session?.tokenStats ?? {
        tokensSkippedBySelection: 0,
        tokensInjected: 0,
        tokensTrimmedFromHistory: 0,
        tokensTrimmedCarlyBlocks: 0,
        promptsProcessed: 0,
        rulesInjected: 0,
        baselineTokensPerPrompt: state.baselineTokensPerPrompt,
      };

      // Apply session overrides
      const effectiveManifest = session
        ? applySessionOverrides(state.config.manifest, session)
        : state.config.manifest;

      // Determine context bracket
      const bracket = getBracket(promptCount, state.config.context);

      // Build effective config
      const effectiveConfig: CarlyConfig = {
        ...state.config,
        manifest: effectiveManifest,
      };

      // Load rules
      const loaded = loadRules(matchResult, effectiveConfig, bracket, promptCount);

      // Override devmode from effective manifest
      loaded.devmode = effectiveManifest.devmode;
      loaded.contextEnabled = effectiveManifest.context.state === "active";
      loaded.commandsEnabled = effectiveManifest.commands.state === "active";

      // --- Token stats calculation ---
      const totalRulesThisPrompt =
        countRules(loaded.alwaysOn) +
        countRules(loaded.matched) +
        countRules(loaded.commands) +
        loaded.bracketRules.length;

      const tokensInjectedThisPrompt =
        estimateRuleTokens(loaded.alwaysOn) +
        estimateRuleTokens(loaded.matched) +
        estimateRuleTokens(loaded.commands) +
        estimateTokens(loaded.bracketRules.join(""));

      const tokensSkippedThisPrompt = Math.max(
        0,
        state.baselineTokensPerPrompt - tokensInjectedThisPrompt
      );

      // Accumulate stats
      tokenStats.tokensInjected += tokensInjectedThisPrompt;
      tokenStats.tokensSkippedBySelection += tokensSkippedThisPrompt;
      tokenStats.promptsProcessed += 1;
      tokenStats.rulesInjected = (tokenStats.rulesInjected || 0) + totalRulesThisPrompt;

      // Update session
      if (session) {
        session.tokenStats = tokenStats;
        try {
          saveSession(discovery.configPath, session);
          state.cumulativeStats = updateCumulativeStats(discovery.configPath, session);
        } catch {
          // Non-critical
        }
      }

      // Attach injection stats for DEVMODE display
      loaded.injectionStats = {
        rulesThisPrompt: totalRulesThisPrompt,
        totalRulesSession: tokenStats.rulesInjected || totalRulesThisPrompt,
        totalPromptsSession: tokenStats.promptsProcessed,
        avgRulesPerPrompt: tokenStats.promptsProcessed > 0
          ? Math.round((tokenStats.rulesInjected || 0) / tokenStats.promptsProcessed)
          : totalRulesThisPrompt,
      };

      // Attach token savings for *stats and DEVMODE
      const totalSaved =
        tokenStats.tokensSkippedBySelection +
        tokenStats.tokensTrimmedFromHistory +
        tokenStats.tokensTrimmedCarlyBlocks;

      const showFullReport = matchResult.starCommands.includes("stats");

      loaded.tokenSavings = {
        skippedBySelection: tokenStats.tokensSkippedBySelection,
        trimmedFromHistory: tokenStats.tokensTrimmedFromHistory,
        trimmedCarlyBlocks: tokenStats.tokensTrimmedCarlyBlocks,
        tokensInjected: tokenStats.tokensInjected,
        baselinePerPrompt: state.baselineTokensPerPrompt,
        totalSaved,
        promptsProcessed: tokenStats.promptsProcessed,
        showFullReport,
      };

      // Format and inject
      const formatted = formatRules(loaded);
      output.system.push(formatted);

      // If *stats command was used, build the report
      if (showFullReport && session) {
        const filtered = filterSessionsByDuration(
          state.cumulativeStats,
          state.config.context.stats
        );
        const report = buildTokenReport(
          tokenStats,
          state.baselineTokensPerPrompt,
          filtered
        );
        // Queue the report to be emitted as a synthetic assistant message
        // in experimental.chat.messages.transform (visible to the user, no AI tokens)
        state.pendingStatsReportBySession.set(sessionID, report);
      }

      // Persist session with updated stats
      if (session) {
        try {
          saveSession(discovery.configPath, session);
        } catch {
          // Non-critical
        }
      }

      // Cleanup cached match
      state.lastMatch.delete(sessionID);
      state.lastPrompt.delete(sessionID);
    },

    // -----------------------------------------------------------------
    // experimental.chat.messages.transform: smart tool output trimming
    // -----------------------------------------------------------------
    "experimental.chat.messages.transform": async (_input, output) => {
      // If there is a pending *stats report for the active session, emit it now
      if (state.activeSessionID) {
        const pending = state.pendingStatsReportBySession.get(state.activeSessionID);
        if (pending) {
          (output.messages as unknown as any[]).push({
            info: { role: "assistant" },
            parts: [{ type: "text", text: pending }],
          });
          state.pendingStatsReportBySession.delete(state.activeSessionID);
        }
      }

      const trimConfig = state.config.context.trimming;

      const trimStats = trimMessageHistory(
        output.messages as Parameters<typeof trimMessageHistory>[0],
        trimConfig
      );

      // Accumulate trim stats to the session
      if (trimStats.tokensSaved > 0 || trimStats.carlyBlocksStripped > 0) {
        const sessionID = state.activeSessionID;
        const session = sessionID ? state.sessions.get(sessionID) : undefined;

        if (session) {
          session.tokenStats.tokensTrimmedFromHistory += trimStats.tokensSaved;
          session.tokenStats.tokensTrimmedCarlyBlocks += trimStats.carlyTokensSaved;

          try {
            saveSession(discovery.configPath, session);
          } catch {
            // Non-critical
          }
        }

        await log("debug", "History trimmed", {
          partsTrimmed: trimStats.partsTrimmed,
          tokensSaved: trimStats.tokensSaved,
          carlyBlocksStripped: trimStats.carlyBlocksStripped,
          mode: trimConfig.mode,
        });
      }

      // Always update cumulative stats after messages transform completes
      const sessionID = state.activeSessionID;
      const session = sessionID ? state.sessions.get(sessionID) : undefined;
      if (session) {
        try {
          state.cumulativeStats = updateCumulativeStats(discovery.configPath, session);
        } catch {
          // Non-critical
        }
      }
    },

    // -----------------------------------------------------------------
    // Compaction hook: preserve CARLY context across compaction
    // -----------------------------------------------------------------
    "experimental.session.compacting": async (_input, output) => {
      output.context.push(
        "OpenCarly (dynamic rule injection) is active. " +
          "Rules are injected per-prompt based on keyword matching. " +
          "Preserve awareness that <carly-rules> blocks contain mandatory instructions."
      );
    },

    tool: {
      stats: tool({
        description: "Get OpenCarly token savings statistics",
        args: {},
        execute: async (_args: Record<string, never>, _context: { directory: string }): Promise<string> => {
          return generateStatsReport(discovery.configPath, state.activeSessionID || undefined);
        },
      }),
      clear_stats: tool({
        description: "Clear all OpenCarly token savings statistics",
        args: {},
        execute: async (_args: Record<string, never>, _context: { directory: string }): Promise<string> => {
          clearAllStats(discovery.configPath);
          
          state.cumulativeStats = {
            version: 1,
            cumulative: {
              tokensSkippedBySelection: 0,
              tokensInjected: 0,
              tokensTrimmedFromHistory: 0,
              tokensTrimmedCarlyBlocks: 0,
              totalTokensSaved: 0,
            },
            sessions: [],
          };
          
          for (const session of state.sessions.values()) {
            session.tokenStats = {
              tokensSkippedBySelection: 0,
              tokensInjected: 0,
              tokensTrimmedFromHistory: 0,
              tokensTrimmedCarlyBlocks: 0,
              promptsProcessed: 0,
              rulesInjected: 0,
              baselineTokensPerPrompt: state.baselineTokensPerPrompt,
            };
          }
          
          return "All OpenCarly token savings statistics have been successfully reset to zero.";
        },
      }),
    },
  };
};

// Default export for single-export plugin files
export default OpenCarly;
