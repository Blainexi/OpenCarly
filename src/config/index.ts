/**
 * Config module exports
 */

export { discoverConfig, type DiscoveryResult } from "./discovery";
export { loadConfig, reloadConfig, parseDomainFile, type CarlyConfig } from "./manifest";
export {
  ManifestSchema,
  DomainConfigSchema,
  CommandsFileSchema,
  StarCommandSchema,
  ContextFileSchema,
  ContextBracketSchema,
  TrimmingConfigSchema,
  StatsConfigSchema,
  TRIM_THRESHOLDS,
  TokenStatsSchema,
  CumulativeStatsSchema,
  CumulativeSessionSummarySchema,
  SessionConfigSchema,
  SessionOverrideSchema,
  type Manifest,
  type DomainConfig,
  type CommandsFile,
  type StarCommand,
  type ContextFile,
  type ContextBracket,
  type TrimmingConfig,
  type StatsConfig,
  type TokenStats,
  type CumulativeStats,
  type CumulativeSessionSummary,
  type SessionConfig,
  type SessionOverride,
  type BracketName,
} from "./schema";
