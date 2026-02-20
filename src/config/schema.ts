/**
 * OpenCarly Configuration Schemas
 *
 * Zod schemas for all configuration files:
 * - manifest.json (domain registry, settings)
 * - commands.json (star-command definitions)
 * - context.json (context bracket thresholds and rules)
 * - sessions/*.json (per-session state)
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Domain Configuration (inside manifest.json)
// ---------------------------------------------------------------------------

export const DomainConfigSchema = z.object({
  /** Whether this domain is active */
  state: z.enum(["active", "inactive"]).default("active"),

  /** If true, domain rules load on every prompt (no keyword matching) */
  alwaysOn: z.boolean().default(false),

  /** Keywords that trigger this domain (substring match, case-insensitive) */
  recall: z.array(z.string()).default([]),

  /** Keywords that prevent this domain from loading */
  exclude: z.array(z.string()).default([]),

  /** File paths/globs that trigger this domain (e.g., ["*.tsx", "src/components/*"]) */
  paths: z.array(z.string()).default([]),

  /** Path to the domain rule file, relative to .opencarly/ */
  file: z.string(),
});

export type DomainConfig = z.infer<typeof DomainConfigSchema>;

// ---------------------------------------------------------------------------
// Manifest (manifest.json)
// ---------------------------------------------------------------------------

export const ManifestSchema = z.object({
  /** Schema version for forward compatibility */
  version: z.literal(1).default(1),

  /** Enable DEVMODE debug output */
  devmode: z.boolean().default(false),

  /** Global exclusion keywords - if any match, skip ALL domain matching */
  globalExclude: z.array(z.string()).default([]),

  /** Domain definitions */
  domains: z.record(z.string(), DomainConfigSchema).default({}),

  /** Whether star-commands system is enabled */
  commands: z
    .object({
      state: z.enum(["active", "inactive"]).default("active"),
    })
    .default({}),

  /** Whether context bracket system is enabled */
  context: z
    .object({
      state: z.enum(["active", "inactive"]).default("active"),
    })
    .default({}),
});

export type Manifest = z.infer<typeof ManifestSchema>;

// ---------------------------------------------------------------------------
// Star-Command (commands.json)
// ---------------------------------------------------------------------------

export const StarCommandSchema = z.object({
  /** Description of what this command does */
  description: z.string().optional(),

  /** Rules injected when this command is invoked */
  rules: z.array(z.string()),
});

export type StarCommand = z.infer<typeof StarCommandSchema>;

export const CommandsFileSchema = z.record(z.string(), StarCommandSchema);

export type CommandsFile = z.infer<typeof CommandsFileSchema>;

// ---------------------------------------------------------------------------
// Context Brackets (context.json)
// ---------------------------------------------------------------------------

export const ContextBracketSchema = z.object({
  /** Whether this bracket is enabled */
  enabled: z.boolean().default(true),

  /** Rules injected when this bracket is active */
  rules: z.array(z.string()).default([]),
});

export type ContextBracket = z.infer<typeof ContextBracketSchema>;

// ---------------------------------------------------------------------------
// Tool Output Trimming (inside context.json)
// ---------------------------------------------------------------------------

export const TrimmingConfigSchema = z.object({
  /** Whether tool output trimming is enabled */
  enabled: z.boolean().default(true),

  /**
   * Trimming aggressiveness mode:
   * - conservative: only trims very stale/superseded outputs (threshold=20)
   * - moderate: good balance of savings vs safety (threshold=40)
   * - aggressive: trims most things beyond preserveLastN (threshold=60)
   */
  mode: z.enum(["conservative", "moderate", "aggressive"]).default("moderate"),

  /** Hard floor: never trim tool outputs in the last N messages */
  preserveLastN: z.number().min(1).default(3),
});

export type TrimmingConfig = z.infer<typeof TrimmingConfigSchema>;

// ---------------------------------------------------------------------------
// Stats Tracking (inside context.json)
// ---------------------------------------------------------------------------

export const StatsConfigSchema = z.object({
  /**
   * Duration to track stats:
   * - "all": All sessions (default)
   * - "month": Only sessions from last 30 days
   * - "week": Only sessions from last 7 days
   */
  trackDuration: z.enum(["all", "month", "week"]).default("all"),
});

export type StatsConfig = z.infer<typeof StatsConfigSchema>;

/** Map trimming mode to score threshold */
export const TRIM_THRESHOLDS: Record<string, number> = {
  conservative: 20,
  moderate: 40,
  aggressive: 60,
};

export const ContextFileSchema = z.object({
  /** Prompt count thresholds for bracket transitions */
  thresholds: z
    .object({
      moderate: z.number().default(15),
      depleted: z.number().default(35),
      critical: z.number().default(50),
    })
    .default({}),

  /** Bracket definitions */
  brackets: z
    .object({
      fresh: ContextBracketSchema.default({ enabled: true, rules: [] }),
      moderate: ContextBracketSchema.default({ enabled: true, rules: [] }),
      depleted: ContextBracketSchema.default({ enabled: true, rules: [] }),
    })
    .default({}),

  /** Smart tool output trimming configuration */
  trimming: TrimmingConfigSchema.default({}),

  /** Token stats tracking configuration */
  stats: StatsConfigSchema.default({}),
});

export type ContextFile = z.infer<typeof ContextFileSchema>;

// ---------------------------------------------------------------------------
// Token Stats (tracked per session, persisted in session file)
// ---------------------------------------------------------------------------

export const TokenStatsSchema = z.object({
  /** Total tokens saved by selective rule injection (all rules minus loaded rules) */
  tokensSkippedBySelection: z.number().default(0),

  /** Total tokens of rules actually injected into the system prompt */
  tokensInjected: z.number().default(0),

  /** Total tokens trimmed from conversation history (tool outputs) */
  tokensTrimmedFromHistory: z.number().default(0),

  /** Total tokens trimmed from stale <carly-rules> blocks in history */
  tokensTrimmedCarlyBlocks: z.number().default(0),

  /** Number of prompts processed */
  promptsProcessed: z.number().default(0),

  /** Number of rules injected across all prompts */
  rulesInjected: z.number().default(0),

  /** Baseline: tokens that would be used if all rules loaded every prompt */
  baselineTokensPerPrompt: z.number().default(0),
});

export type TokenStats = z.infer<typeof TokenStatsSchema>;

// ---------------------------------------------------------------------------
// Cumulative Stats (persisted in stats.json)
// ---------------------------------------------------------------------------

export const CumulativeSessionSummarySchema = z.object({
  sessionId: z.string(),
  date: z.string(),
  tokensSaved: z.number(),
  promptsProcessed: z.number(),
  tokensSkippedBySelection: z.number().default(0),
  tokensTrimmedFromHistory: z.number().default(0),
  tokensTrimmedCarlyBlocks: z.number().default(0),
  tokensInjected: z.number().default(0),
  rulesInjected: z.number().default(0),
});

export type CumulativeSessionSummary = z.infer<typeof CumulativeSessionSummarySchema>;

export const CumulativeStatsSchema = z.object({
  version: z.number().default(1),
  cumulative: z
    .object({
      tokensSkippedBySelection: z.number().default(0),
      tokensInjected: z.number().default(0),
      tokensTrimmedFromHistory: z.number().default(0),
      tokensTrimmedCarlyBlocks: z.number().default(0),
      totalTokensSaved: z.number().default(0),
    })
    .default({}),
  sessions: z.array(CumulativeSessionSummarySchema).default([]),
});

export type CumulativeStats = z.infer<typeof CumulativeStatsSchema>;

// ---------------------------------------------------------------------------
// Session Override
// ---------------------------------------------------------------------------

export const SessionOverrideSchema = z.object({
  /** Override DEVMODE for this session (null = inherit from manifest) */
  devmode: z.boolean().nullable().default(null),

  /** Per-domain state overrides (null = inherit from manifest) */
  domainStates: z.record(z.string(), z.boolean().nullable()).default({}),
});

export type SessionOverride = z.infer<typeof SessionOverrideSchema>;

// ---------------------------------------------------------------------------
// Session Config (sessions/*.json)
// ---------------------------------------------------------------------------

export const SessionConfigSchema = z.object({
  /** Session ID from OpenCode */
  id: z.string(),

  /** ISO timestamp when session was created */
  started: z.string(),

  /** Working directory for this session */
  cwd: z.string(),

  /** Short label derived from cwd (project directory name) */
  label: z.string(),

  /** User-editable session title (auto-generated from first prompt) */
  title: z.string().nullable().default(null),

  /** Number of prompts processed in this session */
  promptCount: z.number().default(0),

  /** ISO timestamp of last activity */
  lastActivity: z.string(),

  /** Files recently read or edited by tools in this session */
  activeFiles: z.array(z.string()).default([]),

  /** Session-specific overrides */
  overrides: SessionOverrideSchema.default({}),

  /** Cumulative token savings stats for this session */
  tokenStats: TokenStatsSchema.default({}),
});

export type SessionConfig = z.infer<typeof SessionConfigSchema>;

// ---------------------------------------------------------------------------
// Bracket Names
// ---------------------------------------------------------------------------

export type BracketName = "FRESH" | "MODERATE" | "DEPLETED" | "CRITICAL";
