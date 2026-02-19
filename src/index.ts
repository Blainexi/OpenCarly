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
import { discoverConfig } from "./config/discovery";
import { loadConfig, type CarlyConfig } from "./config/manifest";
import type { SessionConfig } from "./config/schema";
import { matchDomains, type MatchResult } from "./engine/matcher";
import { loadRules } from "./engine/loader";
import { getBracket } from "./engine/brackets";
import { trimMessageHistory } from "./engine/trimmer";
import { formatRules } from "./formatter/formatter";
import {
  getOrCreateSession,
  updateSessionActivity,
  saveSession,
  applySessionOverrides,
  cleanStaleSessions,
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
  /** Injection stats per session for DEVMODE */
  stats: Map<string, InjectionStats>;
}

interface InjectionStats {
  totalRulesInjected: number;
  totalPromptsProcessed: number;
  domainsLoadedThisPrompt: string[];
  commandsLoadedThisPrompt: string[];
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
 * Parts can be text content or other types; we only care about text.
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

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export const OpenCarly: Plugin = async ({ directory, client }) => {
  // Create structured logger
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

  // Log warnings from config validation
  for (const warning of config.warnings) {
    await log("warn", warning, { configPath: discovery.configPath });
  }

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
  });

  // Initialize plugin state
  const state: PluginState = {
    config,
    sessions: new Map(),
    lastMatch: new Map(),
    lastPrompt: new Map(),
    stats: new Map(),
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
    // Event hook: track session lifecycle
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

      // Extract prompt text from parts
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

      // Update session activity
      updateSessionActivity(currentSession, promptText);

      // Apply session overrides to manifest
      const effectiveManifest = applySessionOverrides(
        state.config.manifest,
        currentSession
      );

      // Run domain matcher
      const matchResult = matchDomains(promptText, effectiveManifest);

      // Cache results for the system.transform hook
      state.lastMatch.set(sessionID, matchResult);
      state.lastPrompt.set(sessionID, promptText);

      // Log match results at debug level
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

      // Get session for prompt count
      const session = state.sessions.get(sessionID);
      const promptCount = session?.promptCount ?? 1;

      // Apply session overrides
      const effectiveManifest = session
        ? applySessionOverrides(state.config.manifest, session)
        : state.config.manifest;

      // Determine context bracket
      const bracket = getBracket(promptCount, state.config.context);

      // Build effective config with overridden manifest
      const effectiveConfig: CarlyConfig = {
        ...state.config,
        manifest: effectiveManifest,
      };

      // Load all rules
      const loaded = loadRules(matchResult, effectiveConfig, bracket, promptCount);

      // Override devmode from effective manifest
      loaded.devmode = effectiveManifest.devmode;
      loaded.contextEnabled = effectiveManifest.context.state === "active";
      loaded.commandsEnabled = effectiveManifest.commands.state === "active";

      // Track stats
      const totalRules =
        countRules(loaded.alwaysOn) +
        countRules(loaded.matched) +
        countRules(loaded.commands) +
        loaded.bracketRules.length;

      const prevStats = state.stats.get(sessionID);
      const stats: InjectionStats = {
        totalRulesInjected: (prevStats?.totalRulesInjected ?? 0) + totalRules,
        totalPromptsProcessed: (prevStats?.totalPromptsProcessed ?? 0) + 1,
        domainsLoadedThisPrompt: [
          ...Object.keys(loaded.alwaysOn),
          ...Object.keys(loaded.matched),
        ],
        commandsLoadedThisPrompt: Object.keys(loaded.commands),
      };
      state.stats.set(sessionID, stats);

      // Attach stats to loaded rules for DEVMODE display
      loaded.injectionStats = {
        rulesThisPrompt: totalRules,
        totalRulesSession: stats.totalRulesInjected,
        totalPromptsSession: stats.totalPromptsProcessed,
        avgRulesPerPrompt: Math.round(
          stats.totalRulesInjected / stats.totalPromptsProcessed
        ),
      };

      // Format and inject
      const formatted = formatRules(loaded);
      output.system.push(formatted);

      // Cleanup cached match (one-shot per message)
      state.lastMatch.delete(sessionID);
      state.lastPrompt.delete(sessionID);
    },

    // -----------------------------------------------------------------
    // experimental.chat.messages.transform: smart tool output trimming
    // -----------------------------------------------------------------
    "experimental.chat.messages.transform": async (_input, output) => {
      // Smart trim: score each tool output in history and trim the
      // lowest-scoring ones. Also strips stale <carly-rules> blocks.
      // Factors: age, superseded reads, post-read edits, output size,
      // tool type (ephemeral vs persistent).
      const trimConfig = state.config.context.trimming;

      const trimStats = trimMessageHistory(
        output.messages as Parameters<typeof trimMessageHistory>[0],
        trimConfig
      );

      if (trimStats.partsTrimmed > 0 || trimStats.carlyBlocksStripped > 0) {
        await log("debug", "History trimmed", {
          partsTrimmed: trimStats.partsTrimmed,
          tokensSaved: trimStats.tokensSaved,
          carlyBlocksStripped: trimStats.carlyBlocksStripped,
          mode: trimConfig.mode,
        });
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
  };
};

// Default export for single-export plugin files
export default OpenCarly;
