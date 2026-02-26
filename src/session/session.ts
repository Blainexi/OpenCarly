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

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.promises.writeFile(tmpPath, data, "utf-8");
  await fs.promises.rename(tmpPath, filePath);
}

class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;
  async acquire(): Promise<() => void> {
    if (this.locked) await new Promise<void>(resolve => this.queue.push(resolve));
    this.locked = true;
    return () => {
      if (this.queue.length > 0) { const next = this.queue.shift(); if (next) next(); }
      else { this.locked = false; }
    };
  }
}
const sessionMutex = new Mutex();

const SESSIONS_DIR = "sessions";
const STATS_FILE = "stats.json";
const STALE_SESSION_HOURS = 720;

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
  // Sanitize the sessionId to prevent path traversal
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(getSessionsDir(configPath), `${safeId}.json`);
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
export async function saveSession(
  configPath: string,
  session: SessionConfig
): Promise<void> {
  const release = await sessionMutex.acquire();
  try {
    const filePath = getSessionFilePath(configPath, session.id);
    await atomicWrite(filePath, JSON.stringify(session, null, 2));
  } finally {
    release();
  }
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
export async function cleanStaleSessions(configPath: string): Promise<number> {
  const sessionsDir = path.join(configPath, SESSIONS_DIR);

  if (!fs.existsSync(sessionsDir)) {
    return 0;
  }

  const cutoff = Date.now() - STALE_SESSION_HOURS * 60 * 60 * 1000;
  let cleaned = 0;

  const files = await fs.promises.readdir(sessionsDir);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const filePath = path.join(sessionsDir, file);
    try {
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const session = JSON.parse(raw);
      const lastActivity = new Date(session.lastActivity).getTime();

      if (lastActivity < cutoff) {
        await fs.promises.rm(filePath, { recursive: true, force: true });
        cleaned++;
      }
    } catch {
      // Remove corrupted files too
      try {
        await fs.promises.rm(filePath, { recursive: true, force: true });
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
  lastActivity?: string;
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
    (tokenStats.tokensSkippedBySelection || 0) +
    (tokenStats.tokensTrimmedFromHistory || 0) +
    (tokenStats.tokensTrimmedCarlyBlocks || 0)
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
export function loadCumulativeStats(
  configPath: string,
  trackDuration: "all" | "week" | "month" = "all"
): CumulativeStats {
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
          lastActivity: sessionData.lastActivity || sessionData.started,
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
  let sessions = Array.from(sessionMap.values());

  let cumulative: CumulativeStats["cumulative"];

  if (trackDuration !== "all") {
    const cutoff = new Date();
    if (trackDuration === "week") {
      cutoff.setDate(cutoff.getDate() - 7);
    } else if (trackDuration === "month") {
      cutoff.setMonth(cutoff.getMonth() - 1);
    }
    const cutoffTime = cutoff.getTime();
    sessions = sessions.filter(s => new Date(s.lastActivity || s.date).getTime() >= cutoffTime);
    
    // For specific durations, recalculate to only include sessions within the timeframe
    cumulative = calculateCumulativeStats(sessions);
  } else {
    // For "all" time, use the persistent running total to avoid truncation after 100 sessions
    cumulative = { ...statsJson.cumulative };
  }
  
  sessions.sort((a, b) => {
    const timeA = new Date(a.lastActivity || a.date).getTime();
    const timeB = new Date(b.lastActivity || b.date).getTime();
    return timeB - timeA;
  });
  if (sessions.length > 100) {
    sessions = sessions.slice(0, 100);
  }

  return {
    version: statsJson.version,
    cumulative,
    sessions,
  };
}

/**
 * Save cumulative stats to stats.json.
 */
export async function saveCumulativeStats(
  configPath: string,
  stats: CumulativeStats
): Promise<void> {
  const release = await sessionMutex.acquire();
  try {
    const statsPath = getStatsFilePath(configPath);
    await atomicWrite(statsPath, JSON.stringify(stats, null, 2));
  } finally {
    release();
  }
}

/**
 * Clear all stats by removing stats.json and all session files.
 */
export async function clearAllStats(configPath: string): Promise<void> {
  const release = await sessionMutex.acquire();
  try {
    const statsPath = getStatsFilePath(configPath);
    if (fs.existsSync(statsPath)) {
      try {
        await fs.promises.unlink(statsPath);
      } catch {}
    }

    const sessionsDir = getSessionsDir(configPath);
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            await fs.promises.unlink(path.join(sessionsDir, file));
          } catch {}
        }
      }
    }
  } finally {
    release();
  }
}

/**
 * Update cumulative stats with the current session's stats.
 * Called on every prompt to keep stats current.
 */
export async function updateCumulativeStats(
  configPath: string,
  session: any,
  trackDuration: "all" | "week" | "month",
  currentDelta?: {
    tokensSkippedBySelection?: number;
    tokensTrimmedFromHistory?: number;
    tokensTrimmedCarlyBlocks?: number;
    tokensInjected?: number;
    tokensSaved?: number;
  }
): Promise<CumulativeStats> {
  const release = await sessionMutex.acquire();
  try {
    const statsPath = getStatsFilePath(configPath);
    let stats: CumulativeStats;
    try {
      const raw = readJsonFileSafe(statsPath);
      stats = raw ? CumulativeStatsSchema.parse(raw) : { version: 1, cumulative: { tokensSkippedBySelection: 0, tokensInjected: 0, tokensTrimmedFromHistory: 0, tokensTrimmedCarlyBlocks: 0, totalTokensSaved: 0 }, sessions: [] };
    } catch {
      stats = { version: 1, cumulative: { tokensSkippedBySelection: 0, tokensInjected: 0, tokensTrimmedFromHistory: 0, tokensTrimmedCarlyBlocks: 0, totalTokensSaved: 0 }, sessions: [] };
    }
    
    const tokensSaved = calculateTokensSaved(session.tokenStats);
    const existingIndex = stats.sessions.findIndex(s => s.sessionId === session.id);
    
    const summary: CumulativeSessionSummary = {
      sessionId: session.id,
      date: session.started,
      lastActivity: session.lastActivity,
      tokensSaved,
      promptsProcessed: session.tokenStats.promptsProcessed,
      tokensSkippedBySelection: session.tokenStats.tokensSkippedBySelection,
      tokensTrimmedFromHistory: session.tokenStats.tokensTrimmedFromHistory,
      tokensTrimmedCarlyBlocks: session.tokenStats.tokensTrimmedCarlyBlocks,
      tokensInjected: session.tokenStats.tokensInjected,
      rulesInjected: session.tokenStats.rulesInjected || 0,
    };
    
    const isReEntering = existingIndex === -1 && session.tokenStats.promptsProcessed > 1;
    let isReset = false;

    // We preserve the previous cumulative totals
    const prevCumulativeTokensSkipped = stats.cumulative.tokensSkippedBySelection || 0;
    const prevCumulativeTokensTrimmedHistory = stats.cumulative.tokensTrimmedFromHistory || 0;
    const prevCumulativeTokensTrimmedCarlyBlocks = stats.cumulative.tokensTrimmedCarlyBlocks || 0;
    const prevCumulativeTokensInjected = stats.cumulative.tokensInjected || 0;
    const prevCumulativeTotalSaved = stats.cumulative.totalTokensSaved || 0;
    
    if (existingIndex >= 0) {
      const oldSession = stats.sessions[existingIndex];
      isReset = session.tokenStats.promptsProcessed < (oldSession.promptsProcessed || 0);

      if (!isReset) {
        // If it's an existing session and not reset, subtract the old values first before adding new ones
        stats.cumulative.tokensSkippedBySelection = prevCumulativeTokensSkipped - (oldSession.tokensSkippedBySelection || 0);
        stats.cumulative.tokensTrimmedFromHistory = prevCumulativeTokensTrimmedHistory - (oldSession.tokensTrimmedFromHistory || 0);
        stats.cumulative.tokensTrimmedCarlyBlocks = prevCumulativeTokensTrimmedCarlyBlocks - (oldSession.tokensTrimmedCarlyBlocks || 0);
        stats.cumulative.tokensInjected = prevCumulativeTokensInjected - (oldSession.tokensInjected || 0);
        stats.cumulative.totalTokensSaved = prevCumulativeTotalSaved - (oldSession.tokensSaved || 0);
      } else {
        // It's a reset. Keep current totals, do not subtract old session to preserve historical stats
        stats.cumulative.tokensSkippedBySelection = prevCumulativeTokensSkipped;
        stats.cumulative.tokensTrimmedFromHistory = prevCumulativeTokensTrimmedHistory;
        stats.cumulative.tokensTrimmedCarlyBlocks = prevCumulativeTokensTrimmedCarlyBlocks;
        stats.cumulative.tokensInjected = prevCumulativeTokensInjected;
        stats.cumulative.totalTokensSaved = prevCumulativeTotalSaved;
      }
      
      stats.sessions[existingIndex] = summary;
    } else {
      stats.sessions.push(summary);
      // Keep current totals, we will add the new session's values below if not re-entering
      stats.cumulative.tokensSkippedBySelection = prevCumulativeTokensSkipped;
      stats.cumulative.tokensTrimmedFromHistory = prevCumulativeTokensTrimmedHistory;
      stats.cumulative.tokensTrimmedCarlyBlocks = prevCumulativeTokensTrimmedCarlyBlocks;
      stats.cumulative.tokensInjected = prevCumulativeTokensInjected;
      stats.cumulative.totalTokensSaved = prevCumulativeTotalSaved;
    }
    
    // Add the newly updated or pushed session to the cumulative totals
    if (!isReEntering) {
      stats.cumulative.tokensSkippedBySelection += summary.tokensSkippedBySelection || 0;
      stats.cumulative.tokensTrimmedFromHistory += summary.tokensTrimmedFromHistory || 0;
      stats.cumulative.tokensTrimmedCarlyBlocks += summary.tokensTrimmedCarlyBlocks || 0;
      stats.cumulative.tokensInjected += summary.tokensInjected || 0;
      stats.cumulative.totalTokensSaved += summary.tokensSaved || 0;
    } else if (currentDelta) {
      // If re-entering, only add the delta from the current prompt to avoid double-counting history
      stats.cumulative.tokensSkippedBySelection += currentDelta.tokensSkippedBySelection || 0;
      stats.cumulative.tokensTrimmedFromHistory += currentDelta.tokensTrimmedFromHistory || 0;
      stats.cumulative.tokensTrimmedCarlyBlocks += currentDelta.tokensTrimmedCarlyBlocks || 0;
      stats.cumulative.tokensInjected += currentDelta.tokensInjected || 0;
      stats.cumulative.totalTokensSaved += currentDelta.tokensSaved || 0;
    }

    // Filter based on trackDuration
    if (trackDuration !== "all") {
      const cutoff = new Date();
      if (trackDuration === "week") {
        cutoff.setDate(cutoff.getDate() - 7);
      } else if (trackDuration === "month") {
        cutoff.setMonth(cutoff.getMonth() - 1);
      }
      const cutoffTime = cutoff.getTime();
      stats.sessions = stats.sessions.filter(s => new Date(s.lastActivity || s.date).getTime() >= cutoffTime);
      stats.cumulative = calculateCumulativeStats(stats.sessions);
    }

    // Limit array size to prevent unbounded growth (max 100)
    stats.sessions.sort((a, b) => {
      const timeA = new Date(a.lastActivity || a.date).getTime();
      const timeB = new Date(b.lastActivity || b.date).getTime();
      return timeB - timeA;
    });
    if (stats.sessions.length > 100) {
      stats.sessions = stats.sessions.slice(0, 100);
    }
    
    await saveCumulativeStats(configPath, stats);
    return stats;
  } finally {
    release();
  }
}

export type { CumulativeStats } from "../config/schema";
