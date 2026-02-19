/**
 * Engine module exports
 */

export { matchDomains, detectStarCommands, type MatchResult } from "./matcher";
export { loadRules, type LoadedRules } from "./loader";
export { getBracket, type BracketResult } from "./brackets";
export { trimMessageHistory, type TrimStats } from "./trimmer";
