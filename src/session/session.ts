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
  type StatsConfig,
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
  tokenStats: {
    tokensSkippedBySelection: number;
    tokensInjected: number;
    tokensTrimmedFromHistory: number;
    tokensTrimmedCarlyBlocks: number;
    totalTokensSaved: number;
  };
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

function calculateTokensSaved(tokenStats: SessionFileData["tokenStats"]): number {
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
    cumulative.tokensSkippedBySelection += session.tokensSaved || 0;
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
 * Update cumulative stats with the current session's stats.
 * Called on every prompt to keep stats current.
 */
export function updateCumulativeStats(
  configPath: string,
  session: SessionConfig
): CumulativeStats {
  const stats = loadCumulativeStats(configPath);

  // Update cumulative totals
  stats.cumulative.tokensSkippedBySelection +=
    session.tokenStats.tokensSkippedBySelection;
  stats.cumulative.tokensInjected += session.tokenStats.tokensInjected;
  stats.cumulative.tokensTrimmedFromHistory +=
    session.tokenStats.tokensTrimmedFromHistory;
  stats.cumulative.tokensTrimmedCarlyBlocks +=
    session.tokenStats.tokensTrimmedCarlyBlocks;
  stats.cumulative.totalTokensSaved =
    stats.cumulative.tokensSkippedBySelection +
    stats.cumulative.tokensTrimmedFromHistory +
    stats.cumulative.tokensTrimmedCarlyBlocks;

  // Calculate tokens saved for this session
  const sessionTokensSaved =
    session.tokenStats.tokensSkippedBySelection +
    session.tokenStats.tokensTrimmedFromHistory +
    session.tokenStats.tokensTrimmedCarlyBlocks;

  // Update or add current session in the list
  const existingIdx = stats.sessions.findIndex(
    (s) => s.sessionId === session.id
  );
  const sessionSummary = {
    sessionId: session.id,
    date: session.started,
    tokensSaved: sessionTokensSaved,
    promptsProcessed: session.tokenStats.promptsProcessed,
  };

  if (existingIdx >= 0) {
    stats.sessions[existingIdx] = sessionSummary;
  } else {
    stats.sessions.push(sessionSummary);
  }

  saveCumulativeStats(configPath, stats);
  return stats;
}

/**
 * Filter sessions by duration based on stats config.
 */
export function filterSessionsByDuration(
  stats: CumulativeStats,
  config: StatsConfig
): {
  filteredSessions: typeof stats.sessions;
  filteredTotal: number;
  durationLabel: string;
} {
  const now = Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;

  let cutoff: number | null = null;
  let label = "all sessions";

  switch (config.trackDuration) {
    case "week":
      cutoff = now - 7 * msPerDay;
      label = "last 7 days";
      break;
    case "month":
      cutoff = now - 30 * msPerDay;
      label = "last 30 days";
      break;
    case "all":
    default:
      cutoff = null;
      label = "all sessions";
      break;
  }

  let filteredSessions = stats.sessions;
  let filteredTotal = stats.cumulative.totalTokensSaved;

  if (cutoff !== null) {
    filteredSessions = stats.sessions.filter((s) => {
      const sessionTime = new Date(s.date).getTime();
      return sessionTime >= cutoff!;
    });

    filteredTotal = filteredSessions.reduce(
      (sum, s) => sum + s.tokensSaved,
      0
    );
  }

  return {
    filteredSessions,
    filteredTotal,
    durationLabel: label,
  };
}

export type { CumulativeStats } from "../config/schema";
