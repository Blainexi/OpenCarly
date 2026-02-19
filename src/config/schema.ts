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
});

export type ContextFile = z.infer<typeof ContextFileSchema>;

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

  /** Session-specific overrides */
  overrides: SessionOverrideSchema.default({}),
});

export type SessionConfig = z.infer<typeof SessionConfigSchema>;

// ---------------------------------------------------------------------------
// Bracket Names
// ---------------------------------------------------------------------------

export type BracketName = "FRESH" | "MODERATE" | "DEPLETED" | "CRITICAL";
