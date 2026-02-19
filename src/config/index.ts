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
  SessionConfigSchema,
  SessionOverrideSchema,
  type Manifest,
  type DomainConfig,
  type CommandsFile,
  type StarCommand,
  type ContextFile,
  type ContextBracket,
  type SessionConfig,
  type SessionOverride,
  type BracketName,
} from "./schema";
