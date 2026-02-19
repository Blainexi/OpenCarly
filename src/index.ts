/**
 * OpenCarly - Context Augmentation & Reinforcement Layer for OpenCode
 *
 * Dynamic rules that load when relevant, disappear when not.
 * Replicates CARL (https://github.com/ChristopherKahler/carl) for OpenCode.
 *
 * Hook flow per user message:
 * 1. chat.message -> scan prompt for keywords + star-commands, update session
 * 2. experimental.chat.system.transform -> load rules, format, inject into system prompt
 */

import type { Plugin } from "@opencode-ai/plugin";
import { discoverConfig } from "./config/discovery";
import { loadConfig, type CarlyConfig } from "./config/manifest";
import type { SessionConfig } from "./config/schema";
import { matchDomains, type MatchResult } from "./engine/matcher";
import { loadRules } from "./engine/loader";
import { getBracket } from "./engine/brackets";
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

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export const OpenCarly: Plugin = async ({ directory }) => {
  // Discover config
  const discovery = discoverConfig(directory);
  if (!discovery) {
    // No .opencarly/ found - plugin is inert (no hooks)
    return {};
  }

  // Load config
  let config: CarlyConfig;
  try {
    config = loadConfig(discovery.configPath);
  } catch (_err) {
    // Invalid config - plugin is inert
    return {};
  }

  // Initialize plugin state
  const state: PluginState = {
    config,
    sessions: new Map(),
    lastMatch: new Map(),
    lastPrompt: new Map(),
  };

  // Clean stale sessions on startup
  try {
    cleanStaleSessions(discovery.configPath);
  } catch {
    // Non-critical, ignore
  }

  return {
    // -----------------------------------------------------------------
    // Event hook: track session lifecycle
    // -----------------------------------------------------------------
    event: async ({ event }) => {
      if (event.type === "session.created") {
        // Clean stale sessions when a new one starts
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

      if (isNew) {
        state.sessions.set(sessionID, session);
      } else if (!state.sessions.has(sessionID)) {
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

      // Format and inject
      const formatted = formatRules(loaded);
      output.system.push(formatted);

      // Cleanup cached match (one-shot per message)
      state.lastMatch.delete(sessionID);
      state.lastPrompt.delete(sessionID);
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
