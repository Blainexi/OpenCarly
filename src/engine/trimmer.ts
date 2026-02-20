/**
 * OpenCarly Smart Tool Output Trimmer
 *
 * Multi-factor scoring system that determines which tool outputs in
 * conversation history are safe to trim. Replaces stale outputs with
 * compact summaries to reduce token usage without degrading AI quality.
 *
 * Factors considered:
 * - Age (turns since message)
 * - Superseded file reads (same file read again more recently)
 * - Post-read file edits (file was modified after being read)
 * - Output size (larger = better trim candidate)
 * - Tool type (ephemeral tools like bash/glob are safer to trim)
 * - Tiny output protection (don't bother trimming small outputs)
 */

import { TRIM_THRESHOLDS, type TrimmingConfig } from "../config/schema";

// ---------------------------------------------------------------------------
// Types for the message structure from OpenCode SDK
// ---------------------------------------------------------------------------

/**
 * Minimal types mirroring the OpenCode SDK Part/Message shapes.
 * We use structural typing so we don't need to import the SDK directly.
 */

interface ToolStateCompleted {
  status: "completed";
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: {
    start: number;
    end: number;
    compacted?: number;
  };
}

interface ToolStateOther {
  status: "pending" | "running" | "error";
  input: Record<string, unknown>;
  [key: string]: unknown;
}

type ToolState = ToolStateCompleted | ToolStateOther;

interface ToolPart {
  type: "tool";
  tool: string;
  callID: string;
  state: ToolState;
  [key: string]: unknown;
}

interface TextPart {
  type: "text";
  text: string;
  [key: string]: unknown;
}

type AnyPart = ToolPart | TextPart | { type: string; [key: string]: unknown };

interface TransformMessage {
  info: {
    role: "user" | "assistant";
    time: { created: number };
    [key: string]: unknown;
  };
  parts: AnyPart[];
}

// ---------------------------------------------------------------------------
// TrimContext: pre-pass to catalog file operations
// ---------------------------------------------------------------------------

interface FileOp {
  messageIndex: number;
  op: "read" | "edit" | "write";
}

class TrimContext {
  private fileOps: Map<string, FileOp[]> = new Map();

  constructor(messages: TransformMessage[]) {
    for (let mi = 0; mi < messages.length; mi++) {
      for (const part of messages[mi].parts) {
        if (part.type !== "tool") continue;

        const toolPart = part as ToolPart;
        if (toolPart.state.status !== "completed" && toolPart.state.status !== "error") continue;

        const filePath = toolPart.state.input.filePath as string | undefined;
        if (!filePath) continue;

        if (toolPart.tool === "read" || toolPart.tool === "edit" || toolPart.tool === "write") {
          const ops = this.fileOps.get(filePath);
          const entry: FileOp = { messageIndex: mi, op: toolPart.tool as FileOp["op"] };
          if (ops) {
            ops.push(entry);
          } else {
            this.fileOps.set(filePath, [entry]);
          }
        }
      }
    }
  }

  /** Check if the same file was read in a later message */
  hasNewerRead(filePath: string, messageIndex: number): boolean {
    const ops = this.fileOps.get(filePath);
    if (!ops) return false;
    return ops.some((op) => op.op === "read" && op.messageIndex > messageIndex);
  }

  /** Check if the file was edited or written after this message */
  wasEditedAfter(filePath: string, messageIndex: number): boolean {
    const ops = this.fileOps.get(filePath);
    if (!ops) return false;
    return ops.some(
      (op) =>
        (op.op === "edit" || op.op === "write") &&
        op.messageIndex > messageIndex
    );
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Ephemeral tool types that are cheap to re-run */
const EPHEMERAL_TOOLS = new Set(["bash", "glob", "grep"]);

/** Minimum token estimate to bother trimming */
const MIN_TRIM_TOKENS = 100;

/**
 * Rough token estimate from string length.
 * ~4 chars per token is a reasonable approximation for code/text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Score a tool part for trimming relevance.
 *
 * Returns 0-100 where lower = more trimmable.
 * Parts that should never be trimmed return 100+.
 */
function scoreToolPart(
  toolPart: ToolPart,
  messageIndex: number,
  totalMessages: number,
  context: TrimContext
): number {
  const state = toolPart.state;

  // Only trim completed tool outputs
  if (state.status !== "completed") return 200;

  const completed = state as ToolStateCompleted;

  // Already trimmed by us or by OpenCode's own compaction
  if (completed.time.compacted) return 200;

  // Don't bother trimming tiny outputs
  const tokenEstimate = estimateTokens(completed.output);
  if (tokenEstimate < MIN_TRIM_TOKENS) return 200;

  let score = 100;
  const turnsAgo = totalMessages - 1 - messageIndex;

  // --- Factor 1: Age decay (6 points per turn) ---
  score -= turnsAgo * 6;

  // --- Factor 2: Superseded file reads ---
  if (toolPart.tool === "read") {
    const filePath = toolPart.state.input.filePath as string | undefined;
    if (filePath && context.hasNewerRead(filePath, messageIndex)) {
      score -= 60;
    }
  }

  // --- Factor 3: File was edited after this read ---
  if (toolPart.tool === "read") {
    const filePath = toolPart.state.input.filePath as string | undefined;
    if (filePath && context.wasEditedAfter(filePath, messageIndex)) {
      score -= 50;
    }
  }

  // --- Factor 4: Output size (larger = better trim candidate) ---
  if (tokenEstimate > 2000) {
    score -= 15;
  } else if (tokenEstimate > 500) {
    score -= 8;
  }

  // --- Factor 5: Ephemeral tool types ---
  if (EPHEMERAL_TOOLS.has(toolPart.tool)) {
    score -= 10;
  }

  return Math.max(0, score);
}

// ---------------------------------------------------------------------------
// Trim summary generation
// ---------------------------------------------------------------------------

/**
 * Build a compact summary to replace trimmed tool output.
 */
function buildTrimSummary(toolPart: ToolPart, tokensSaved: number): string {
  const completed = toolPart.state as ToolStateCompleted;
  const title = completed.title || toolPart.tool;

  if (toolPart.tool === "read") {
    const filePath = (toolPart.state.input.filePath as string) || "unknown file";
    const lineCount = completed.output.split("\n").length;
    return (
      `[Trimmed by OpenCarly] Read ${filePath} (${lineCount} lines, ~${tokensSaved} tokens saved)\n` +
      `Re-read this file if its contents are needed.`
    );
  }

  if (toolPart.tool === "bash") {
    const command = (toolPart.state.input.command as string) || "unknown command";
    // Show first 80 chars of command
    const shortCmd = command.length > 80 ? command.slice(0, 77) + "..." : command;
    return (
      `[Trimmed by OpenCarly] Ran: ${shortCmd} (~${tokensSaved} tokens saved)\n` +
      `Re-run this command if output is needed.`
    );
  }

  if (toolPart.tool === "glob" || toolPart.tool === "grep") {
    const pattern = (toolPart.state.input.pattern as string) || "";
    return (
      `[Trimmed by OpenCarly] ${toolPart.tool}: ${pattern} (~${tokensSaved} tokens saved)\n` +
      `Re-run this search if results are needed.`
    );
  }

  // Generic fallback
  return (
    `[Trimmed by OpenCarly] ${title} (~${tokensSaved} tokens saved)\n` +
    `Tool output trimmed from history.`
  );
}

// ---------------------------------------------------------------------------
// Main trim function
// ---------------------------------------------------------------------------

export interface TrimStats {
  /** Number of tool outputs trimmed */
  partsTrimmed: number;
  /** Estimated tokens saved from tool output trimming (excludes carly blocks) */
  tokensSaved: number;
  /** Number of carly-rules blocks stripped */
  carlyBlocksStripped: number;
  /** Estimated tokens saved from carly-rules block removal */
  carlyTokensSaved: number;
}

/**
 * Trim stale tool outputs and carly-rules blocks from message history.
 *
 * Algorithm:
 * 1. Build TrimContext (catalog all file operations for cross-referencing)
 * 2. For each message (except the last preserveLastN):
 *    - Strip <carly-rules> from text parts
 *    - For each completed tool part without a compacted timestamp:
 *      - Calculate relevance score
 *      - If score < threshold: replace output with compact summary
 * 3. Return stats for logging
 */
export function trimMessageHistory(
  messages: TransformMessage[],
  config: TrimmingConfig
): TrimStats {
  const stats: TrimStats = {
    partsTrimmed: 0,
    tokensSaved: 0,
    carlyBlocksStripped: 0,
    carlyTokensSaved: 0,
  };

  if (!config.enabled) return stats;

  const threshold = TRIM_THRESHOLDS[config.mode] ?? 40;
  const totalMessages = messages.length;
  const protectedStart = Math.max(0, totalMessages - config.preserveLastN);

  // Step 1: Build context for cross-referencing file operations
  const context = new TrimContext(messages);

  // Step 2: Process each message
  for (let mi = 0; mi < totalMessages; mi++) {
    const message = messages[mi];

    for (let pi = 0; pi < message.parts.length; pi++) {
      const part = message.parts[pi];

      // --- Strip <carly-rules> from text parts (all messages) ---
      if (part.type === "text") {
        const textPart = part as TextPart;
        if (textPart.text.includes("<carly-rules>")) {
          const tokensBefore = estimateTokens(textPart.text);
          const textBefore = textPart.text;
          textPart.text = textPart.text
            .replace(/<carly-rules>[\s\S]*?<\/carly-rules>/g, "")
            .trim();
          
          if (textPart.text !== textBefore) {
            const tokensAfter = estimateTokens(textPart.text);
            stats.carlyBlocksStripped++;
            stats.carlyTokensSaved += Math.max(0, tokensBefore - tokensAfter);
          }
        }
        continue;
      }

      // --- Tool output trimming (skip protected messages) ---
      if (mi >= protectedStart) continue;
      if (part.type !== "tool") continue;

      const toolPart = part as ToolPart;
      const score = scoreToolPart(toolPart, mi, totalMessages, context);

      if (score < threshold) {
        const completed = toolPart.state as ToolStateCompleted;
        const tokensBefore = estimateTokens(completed.output);
        const summary = buildTrimSummary(toolPart, tokensBefore);
        const tokensAfter = estimateTokens(summary);

        // Replace output with summary
        completed.output = summary;
        completed.time.compacted = Date.now();

        stats.partsTrimmed++;
        stats.tokensSaved += Math.max(0, tokensBefore - tokensAfter);
      }
    }
  }

  return stats;
}
