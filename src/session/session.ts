/**
 * OpenCarly Session Management
 *
 * Handles per-session state tracking, overrides, and stale session cleanup.
 * Session files are stored at .opencarly/sessions/{sessionId}.json
 */

import * as fs from "fs";
import * as path from "path";
import {
  SessionConfigSchema,
  CumulativeStatsSchema,
  type SessionConfig,
  type Manifest,
  type CumulativeStats,
  type CumulativeSessionSummary,
  type TokenStats,
} from "../config/schema";

const SESSIONS_DIR = "sessions";
const STATS_FILE = "stats.json";
const STALE_SESSION_HOURS = 24;

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

/**
 * Get the sessions directory path, creating it if needed.
 */
function getSessionsDir(configPath: string): string {
  const dir = path.join(configPath, SESSIONS_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get path to a specific session file.
 */
function getSessionFilePath(configPath: string, sessionId: string): string {
  return path.join(getSessionsDir(configPath), `${sessionId}.json`);
}

/**
 * Load an existing session from disk. Returns null if not found.
 */
export function loadSession(
  configPath: string,
  sessionId: string
): SessionConfig | null {
  const filePath = getSessionFilePath(configPath, sessionId);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return SessionConfigSchema.parse(JSON.parse(raw));
  } catch {
    // Corrupted session file - remove it and return null
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore cleanup errors
    }
    return null;
  }
}

/**
 * Create a new session config.
 */
export function createSession(
  sessionId: string,
  cwd: string
): SessionConfig {
  const now = new Date().toISOString();
  const label = path.basename(cwd) || "unknown";

  return SessionConfigSchema.parse({
    id: sessionId,
    started: now,
    cwd,
    label,
    title: null,
    promptCount: 0,
    lastActivity: now,
    overrides: {},
  });
}

/**
 * Get or create a session. Returns the session and whether it was newly created.
 */
export function getOrCreateSession(
  configPath: string,
  sessionId: string,
  cwd: string
): { session: SessionConfig; isNew: boolean } {
  const existing = loadSession(configPath, sessionId);

  if (existing) {
    return { session: existing, isNew: false };
  }

  const session = createSession(sessionId, cwd);
  return { session, isNew: true };
}

/**
 * Save a session to disk.
 */
export function saveSession(
  configPath: string,
  session: SessionConfig
): void {
  const filePath = getSessionFilePath(configPath, session.id);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Session updates
// ---------------------------------------------------------------------------

/**
 * Update session activity: bump prompt count, update lastActivity, set title.
 */
export function updateSessionActivity(
  session: SessionConfig,
  promptText?: string
): void {
  session.promptCount++;
  session.lastActivity = new Date().toISOString();

  // Auto-title from first user prompt (truncated to 60 chars)
  if (session.title === null && promptText && session.promptCount <= 3) {
    const cleaned = promptText.replace(/\s+/g, " ").trim();
    session.title = cleaned.length > 60 ? cleaned.slice(0, 57) + "..." : cleaned;
  }
}

// ---------------------------------------------------------------------------
// Session overrides
// ---------------------------------------------------------------------------

/**
 * Apply session overrides to a manifest.
 * Returns a new manifest object with overrides applied.
 * Session overrides take precedence over manifest values.
 */
export function applySessionOverrides(
  manifest: Manifest,
  session: SessionConfig
): Manifest {
  // Deep clone the manifest to avoid mutating the original
  const result: Manifest = JSON.parse(JSON.stringify(manifest));

  // Override devmode if session has a non-null override
  if (session.overrides.devmode !== null) {
    result.devmode = session.overrides.devmode;
  }

  // Override per-domain states
  for (const [domainName, stateOverride] of Object.entries(
    session.overrides.domainStates
  )) {
    if (stateOverride !== null && result.domains[domainName]) {
      result.domains[domainName].state = stateOverride ? "active" : "inactive";
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Stale session cleanup
// ---------------------------------------------------------------------------

/**
 * Remove session files older than STALE_SESSION_HOURS.
 */
export function cleanStaleSessions(configPath: string): number {
  const sessionsDir = path.join(configPath, SESSIONS_DIR);

  if (!fs.existsSync(sessionsDir)) {
    return 0;
  }

  const cutoff = Date.now() - STALE_SESSION_HOURS * 60 * 60 * 1000;
  let cleaned = 0;

  const files = fs.readdirSync(sessionsDir);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const filePath = path.join(sessionsDir, file);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const session = JSON.parse(raw);
      const lastActivity = new Date(session.lastActivity).getTime();

      if (lastActivity < cutoff) {
        fs.unlinkSync(filePath);
        cleaned++;
      }
    } catch {
      // Remove corrupted files too
      try {
        fs.unlinkSync(filePath);
        cleaned++;
      } catch {
        // ignore
      }
    }
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// Cumulative Stats
// ---------------------------------------------------------------------------

/**
 * Get the cumulative stats file path.
 */
function getStatsFilePath(configPath: string): string {
  return path.join(configPath, STATS_FILE);
}

/**
 * Read JSON file, returning null if doesn't exist or invalid.
 */
function readJsonFileSafe(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface SessionFileData {
  id: string;
  started: string;
  promptCount: number;
  tokenStats: TokenStats;
}

interface SessionFile {
  path: string;
  name: string;
}

function getSessionFiles(sessionsDir: string): SessionFile[] {
  if (!fs.existsSync(sessionsDir)) {
    return [];
  }
  const files = fs.readdirSync(sessionsDir);
  return files
    .filter((f) => f.endsWith(".json"))
    .map((name) => ({
      path: path.join(sessionsDir, name),
      name,
    }));
}

function calculateTokensSaved(tokenStats: TokenStats): number {
  return (
    tokenStats.tokensSkippedBySelection +
    tokenStats.tokensTrimmedFromHistory +
    tokenStats.tokensTrimmedCarlyBlocks
  );
}

function calculateCumulativeStats(
  sessions: CumulativeStats["sessions"],
): CumulativeStats["cumulative"] {
  const cumulative = {
    tokensSkippedBySelection: 0,
    tokensInjected: 0,
    tokensTrimmedFromHistory: 0,
    tokensTrimmedCarlyBlocks: 0,
    totalTokensSaved: 0,
  };

  for (const session of sessions) {
    cumulative.tokensSkippedBySelection += session.tokensSkippedBySelection || 0;
    cumulative.tokensTrimmedFromHistory += session.tokensTrimmedFromHistory || 0;
    cumulative.tokensTrimmedCarlyBlocks += session.tokensTrimmedCarlyBlocks || 0;
    cumulative.tokensInjected += session.tokensInjected || 0;
    cumulative.totalTokensSaved += session.tokensSaved || 0;
  }

  return cumulative;
}

/**
 * Load cumulative stats from stats.json and session files.
 * Returns defaults if no data exists.
 */
export function loadCumulativeStats(configPath: string): CumulativeStats {
  const statsPath = getStatsFilePath(configPath);
  const raw = readJsonFileSafe(statsPath);

  let statsJson: CumulativeStats;
  if (raw) {
    try {
      statsJson = CumulativeStatsSchema.parse(raw);
    } catch {
      try {
        statsJson = CumulativeStatsSchema.parse({});
      } catch {
        statsJson = {
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
      }
    }
  } else {
    try {
      statsJson = CumulativeStatsSchema.parse({});
    } catch {
      statsJson = {
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
    }
  }

  // Load sessions from session files
  const sessionsDir = getSessionsDir(configPath);
  const sessionFiles = getSessionFiles(sessionsDir);
  const sessionMap = new Map<string, CumulativeStats["sessions"][0]>();

  // Add sessions from stats.json first
  for (const session of statsJson.sessions) {
    sessionMap.set(session.sessionId, session);
  }

  // Merge sessions from session files
  for (const sessionFile of sessionFiles) {
    const sessionData = readJsonFileSafe(sessionFile.path) as
      | SessionFileData
      | null;
    if (sessionData && sessionData.id && sessionData.tokenStats) {
      const existing = sessionMap.get(sessionData.id);
      if (!existing) {
        // Session not in stats.json, add it
        sessionMap.set(sessionData.id, {
          sessionId: sessionData.id,
          date: sessionData.started,
          tokensSaved: calculateTokensSaved(sessionData.tokenStats),
          promptsProcessed: sessionData.promptCount || 0,
          tokensSkippedBySelection: sessionData.tokenStats.tokensSkippedBySelection || 0,
          tokensTrimmedFromHistory: sessionData.tokenStats.tokensTrimmedFromHistory || 0,
          tokensTrimmedCarlyBlocks: sessionData.tokenStats.tokensTrimmedCarlyBlocks || 0,
          tokensInjected: sessionData.tokenStats.tokensInjected || 0,
          rulesInjected: sessionData.tokenStats.rulesInjected || 0,
        });
      }
    }
  }

  // Recalculate cumulative totals from merged sessions
  const sessions = Array.from(sessionMap.values());
  const cumulative = calculateCumulativeStats(sessions);

  return {
    version: statsJson.version,
    cumulative,
    sessions,
  };
}

/**
 * Save cumulative stats to stats.json.
 */
export function saveCumulativeStats(
  configPath: string,
  stats: CumulativeStats
): void {
  const statsPath = getStatsFilePath(configPath);
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2), "utf-8");
}

/**
 * Clear all stats by removing stats.json and all session files.
 */
export function clearAllStats(configPath: string): void {
  const statsPath = getStatsFilePath(configPath);
  if (fs.existsSync(statsPath)) {
    try {
      fs.unlinkSync(statsPath);
    } catch {}
  }

  const sessionsDir = getSessionsDir(configPath);
  if (fs.existsSync(sessionsDir)) {
    const files = fs.readdirSync(sessionsDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        try {
          fs.unlinkSync(path.join(sessionsDir, file));
        } catch {}
      }
    }
  }
}

/**
 * Update cumulative stats with the current session's stats.
 * Called on every prompt to keep stats current.
 */
export function updateCumulativeStats(
  configPath: string,
  session: SessionConfig
): CumulativeStats {
  const stats = loadCumulativeStats(configPath);
  
  const tokensSaved = calculateTokensSaved(session.tokenStats);
  const existingIndex = stats.sessions.findIndex(s => s.sessionId === session.id);
  
  const summary: CumulativeSessionSummary = {
    sessionId: session.id,
    date: session.started,
    tokensSaved,
    promptsProcessed: session.tokenStats.promptsProcessed,
    tokensSkippedBySelection: session.tokenStats.tokensSkippedBySelection,
    tokensTrimmedFromHistory: session.tokenStats.tokensTrimmedFromHistory,
    tokensTrimmedCarlyBlocks: session.tokenStats.tokensTrimmedCarlyBlocks,
    tokensInjected: session.tokenStats.tokensInjected,
    rulesInjected: session.tokenStats.rulesInjected || 0,
  };
  
  if (existingIndex >= 0) {
    stats.sessions[existingIndex] = summary;
  } else {
    stats.sessions.push(summary);
  }
  
  stats.cumulative.tokensSkippedBySelection = 0;
  stats.cumulative.tokensTrimmedFromHistory = 0;
  stats.cumulative.tokensTrimmedCarlyBlocks = 0;
  stats.cumulative.tokensInjected = 0;
  stats.cumulative.totalTokensSaved = 0;
  
  for (const s of stats.sessions) {
    stats.cumulative.tokensSkippedBySelection += s.tokensSkippedBySelection || 0;
    stats.cumulative.tokensTrimmedFromHistory += s.tokensTrimmedFromHistory || 0;
    stats.cumulative.tokensTrimmedCarlyBlocks += s.tokensTrimmedCarlyBlocks || 0;
    stats.cumulative.tokensInjected += s.tokensInjected || 0;
    stats.cumulative.totalTokensSaved += s.tokensSaved;
  }
  
  saveCumulativeStats(configPath, stats);
  return stats;
}

export type { CumulativeStats } from "../config/schema";
