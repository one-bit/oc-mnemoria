/**
 * Utility functions for oc-mnemoria.
 *
 * Extraction, classification, and text helpers used by the plugin hooks.
 */

import { randomBytes } from "node:crypto";
import type { EntryType, UserIntent } from "../types.js";

// ─── ID / token utilities ────────────────────────────────────────────────────

/** Generate a random 16-character hex ID. */
export function generateId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Improved token estimate.
 *
 * Uses a content-aware heuristic instead of a flat 4 chars/token ratio:
 * - Whitespace-heavy text (code with indentation): ~3.5 chars/token
 * - Dense text (natural language): ~4.5 chars/token
 * - Mixed/default: ~4 chars/token
 *
 * Falls back gracefully — always returns at least 0.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  // Count whitespace ratio to detect code vs prose
  const whitespaceCount = (text.match(/\s/g) ?? []).length;
  const whitespaceRatio = whitespaceCount / text.length;

  // Code-like content has more whitespace (indentation, newlines)
  let charsPerToken: number;
  if (whitespaceRatio > 0.3) {
    charsPerToken = 3.5; // code-like
  } else if (whitespaceRatio < 0.12) {
    charsPerToken = 4.5; // dense/compact text
  } else {
    charsPerToken = 4.0; // mixed
  }

  return Math.ceil(text.length / charsPerToken);
}

/** Truncate text to fit within a token budget. */
export function truncateToTokens(text: string, maxTokens: number): string {
  // Use conservative estimate (3.5 chars/token) to avoid over-truncation
  const maxChars = Math.floor(maxTokens * 3.5);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "...";
}

// ─── Tool output extraction ──────────────────────────────────────────────────

interface ExtractedInfo {
  summary: string;
  content: string;
  filePaths: string[];
  findings: string[];
  patterns: string[];
}

/** Extract key information from tool output based on the tool name. */
export function extractKeyInfo(
  toolName: string,
  output: string,
  args?: Record<string, unknown>
): ExtractedInfo {
  switch (toolName) {
    case "read":
      return extractFileReadInfo(output, args);
    case "bash":
      return extractBashInfo(output, args);
    case "edit":
      return extractEditInfo(output, args);
    case "write":
      return extractWriteInfo(output, args);
    case "grep":
    case "glob":
      return extractSearchInfo(toolName, output, args);
    default:
      return {
        summary: `Tool ${toolName} executed`,
        content: truncateToTokens(output, 200),
        filePaths: [],
        findings: [],
        patterns: [],
      };
  }
}

function extractFileReadInfo(
  output: string,
  args?: Record<string, unknown>
): ExtractedInfo {
  const filePath = getArgFilePath(args);
  const lines = output.split("\n");
  const lineCount = lines.length;

  // Extract function-like patterns
  const funcPattern = /(?:function|const|let|var|class|def|fn|pub fn|async fn)\s+(\w+)/g;
  const functions: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = funcPattern.exec(output)) !== null) {
    functions.push(match[1]);
  }

  // Truncate large outputs
  let content = output;
  if (lineCount > 50) {
    const head = lines.slice(0, 20).join("\n");
    const tail = lines.slice(-20).join("\n");
    content = `${head}\n\n... (${lineCount - 40} lines omitted) ...\n\n${tail}`;
  }

  return {
    summary: `Read file: ${filePath.split("/").pop()} (${lineCount} lines)`,
    content: truncateToTokens(content, 500),
    filePaths: [filePath],
    findings: functions.length > 0 ? [`Functions: ${functions.slice(0, 5).join(", ")}`] : [],
    patterns: [],
  };
}

function extractBashInfo(
  output: string,
  args?: Record<string, unknown>
): ExtractedInfo {
  const command = (args?.command as string) || "unknown";
  const lines = output.split("\n");

  const hasError =
    /error|fail|fatal|panic|exception/i.test(output) && !/0 error/i.test(output);
  const hasSuccess =
    /success|passed|complete|done|ok/i.test(output) && !hasError;

  // Extract file paths
  const pathPattern = /(?:^|\s)((?:\.\/|\/)?[\w\-./]+\.\w{1,10})(?:\s|$|:)/gm;
  const filePaths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(output)) !== null) {
    filePaths.push(match[1]);
  }

  // Truncate large outputs
  let content = output;
  if (lines.length > 30) {
    const head = lines.slice(0, 10).join("\n");
    const tail = lines.slice(-10).join("\n");
    content = `${head}\n\n... (${lines.length - 20} lines omitted) ...\n\n${tail}`;
  }

  const status = hasError ? "with errors" : hasSuccess ? "succeeded" : "";

  return {
    summary: `Ran: ${command.slice(0, 60)}${status ? ` (${status})` : ""}`,
    content: truncateToTokens(content, 300),
    filePaths: [...new Set(filePaths)].slice(0, 10),
    findings: hasError ? ["Command produced errors"] : hasSuccess ? ["Command succeeded"] : [],
    patterns: [],
  };
}

function extractEditInfo(
  output: string,
  args?: Record<string, unknown>
): ExtractedInfo {
  const filePath = getArgFilePath(args);
  const isNew = /created|new file/i.test(output);

  return {
    summary: `${isNew ? "Created" : "Edited"}: ${filePath.split("/").pop()}`,
    content: truncateToTokens(output, 200),
    filePaths: [filePath],
    findings: [],
    patterns: [],
  };
}

function extractWriteInfo(
  output: string,
  args?: Record<string, unknown>
): ExtractedInfo {
  const filePath = getArgFilePath(args);

  return {
    summary: `Wrote file: ${filePath.split("/").pop()}`,
    content: truncateToTokens(output, 200),
    filePaths: [filePath],
    findings: [],
    patterns: [],
  };
}

function getArgFilePath(args?: Record<string, unknown>): string {
  const filePath =
    (args?.filePath as string | undefined) ||
    (args?.path as string | undefined) ||
    (args?.file as string | undefined);
  return filePath || "unknown";
}

function extractSearchInfo(
  toolName: string,
  output: string,
  args?: Record<string, unknown>
): ExtractedInfo {
  const query = (args?.pattern as string) || (args?.query as string) || "";
  const lines = output.split("\n").filter((l) => l.trim());
  const resultCount = lines.length;

  // Extract file paths from search results
  const pathPattern = /^([\w\-./]+\.\w{1,10})/gm;
  const filePaths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(output)) !== null) {
    filePaths.push(match[1]);
  }

  return {
    summary: `${toolName}: "${query.slice(0, 40)}" (${resultCount} results)`,
    content: truncateToTokens(output, 300),
    filePaths: [...new Set(filePaths)].slice(0, 10),
    findings: [`Found ${resultCount} results for "${query.slice(0, 40)}"`],
    patterns: query ? [query] : [],
  };
}

// ─── Classification ──────────────────────────────────────────────────────────

/** Classify a tool's output into an observation type. */
export function classifyObservationType(
  toolName: string,
  output: string
): EntryType {
  const hasError =
    /error|fail|fatal|panic|exception/i.test(output) && !/0 error/i.test(output);
  const hasSuccess = /success|passed|complete|done/i.test(output);
  const hasWarning = /warn|warning|deprecat/i.test(output);

  if (hasError) return "problem";
  if (hasWarning) return "warning";
  if (hasSuccess) return "success";

  switch (toolName) {
    case "read":
    case "grep":
    case "glob":
      return "discovery";
    case "edit":
      return /fix|bug|patch/i.test(output) ? "bugfix" : "refactor";
    case "write":
      return "feature";
    case "bash":
      return "discovery";
    default:
      return "discovery";
  }
}

// ─── User intent extraction ──────────────────────────────────────────────────

/**
 * Intent categories with their keyword patterns, weights, and goal prefixes.
 * Higher weight = more specific intent. When multiple categories match,
 * the one with the highest total score wins.
 */
const INTENT_CATEGORIES: Array<{
  name: string;
  prefix: string;
  patterns: Array<{ regex: RegExp; weight: number }>;
}> = [
  {
    name: "bugfix",
    prefix: "Fix",
    patterns: [
      { regex: /\bbug\b/i, weight: 3 },
      { regex: /\bfix\b/i, weight: 2 },
      { regex: /\bbroken\b/i, weight: 3 },
      { regex: /\berror\b/i, weight: 2 },
      { regex: /\bissue\b/i, weight: 1 },
    ],
  },
  {
    name: "refactor",
    prefix: "Refactor",
    patterns: [
      { regex: /\brefactor\b/i, weight: 3 },
      { regex: /\bimprove\b/i, weight: 2 },
      { regex: /\bclean\b/i, weight: 2 },
      { regex: /\boptimiz/i, weight: 2 },
    ],
  },
  {
    name: "testing",
    prefix: "Test",
    patterns: [
      { regex: /\btests?\b/i, weight: 2 },
      { regex: /\bspec\b/i, weight: 3 },
      { regex: /\bcoverage\b/i, weight: 3 },
    ],
  },
  {
    name: "feature",
    prefix: "Implement",
    patterns: [
      { regex: /\badd\b/i, weight: 1 },
      { regex: /\bimplement\b/i, weight: 3 },
      { regex: /\bcreate\b/i, weight: 2 },
      { regex: /\bbuild\b/i, weight: 1 },
      { regex: /\bnew\b/i, weight: 1 },
    ],
  },
  {
    name: "exploration",
    prefix: "Understand",
    patterns: [
      { regex: /\bexplain\b/i, weight: 3 },
      { regex: /\bwhat\b/i, weight: 1 },
      { regex: /\bhow\b/i, weight: 1 },
      { regex: /\bwhy\b/i, weight: 2 },
      { regex: /\bdescribe\b/i, weight: 3 },
    ],
  },
];

/** Extract the user's intent from their message using weighted scoring. */
export function extractUserIntent(message: string): UserIntent {
  let goal = message.slice(0, 200);

  const filePaths: string[] = [];
  const pathPattern = /(?:^|\s)((?:\.\/|\/)?[\w\-./]+\.\w{1,10})(?:\s|$)/gm;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(message)) !== null) {
    filePaths.push(match[1]);
  }

  const context: string[] = [];

  // Score each category and pick the highest
  let bestScore = 0;
  let bestCategory: (typeof INTENT_CATEGORIES)[number] | null = null;

  for (const category of INTENT_CATEGORIES) {
    let score = 0;
    for (const { regex, weight } of category.patterns) {
      if (regex.test(message)) {
        score += weight;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  if (bestCategory && bestScore > 0) {
    context.push(bestCategory.name);
    goal = `${bestCategory.prefix}: ${goal}`;
  }

  return { goal, context, filePaths };
}
