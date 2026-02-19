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
  type SessionConfig,
  type Manifest,
} from "../config/schema";

const SESSIONS_DIR = "sessions";
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
