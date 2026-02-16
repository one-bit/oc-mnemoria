/**
 * Utility functions for oc-mnemoria.
 *
 * Text and intent helpers used by the plugin hooks.
 */

import { randomBytes } from "node:crypto";
import type { UserIntent } from "../types.js";
import {
  INTENT_MIN_SCORE,
  INTENT_MIN_MESSAGE_LENGTH,
  INTENT_GOAL_MAX_LENGTH,
  TOKEN_CODE_WHITESPACE_RATIO,
  TOKEN_DENSE_WHITESPACE_RATIO,
  TOKEN_CHARS_PER_TOKEN_CODE,
  TOKEN_CHARS_PER_TOKEN_DENSE,
  TOKEN_CHARS_PER_TOKEN_MIXED,
  TOKEN_CHARS_PER_TOKEN_CONSERVATIVE,
} from "../constants.js";

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
  let whitespaceCount = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 160) {
      whitespaceCount++;
    }
  }
  const whitespaceRatio = whitespaceCount / text.length;

  // Code-like content has more whitespace (indentation, newlines)
  let charsPerToken: number;
  if (whitespaceRatio > TOKEN_CODE_WHITESPACE_RATIO) {
    charsPerToken = TOKEN_CHARS_PER_TOKEN_CODE;
  } else if (whitespaceRatio < TOKEN_DENSE_WHITESPACE_RATIO) {
    charsPerToken = TOKEN_CHARS_PER_TOKEN_DENSE;
  } else {
    charsPerToken = TOKEN_CHARS_PER_TOKEN_MIXED;
  }

  return Math.ceil(text.length / charsPerToken);
}

/** Truncate text to fit within a token budget. */
export function truncateToTokens(text: string, maxTokens: number): string {
  // Use conservative estimate (3.5 chars/token) to avoid over-truncation
  const maxChars = Math.floor(maxTokens * TOKEN_CHARS_PER_TOKEN_CONSERVATIVE);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "...";
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
  const messageLower = message.toLowerCase();
  let goal = message.slice(0, INTENT_GOAL_MAX_LENGTH);

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
      if (regex.test(messageLower)) {
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

  const shouldStore = bestScore >= INTENT_MIN_SCORE && message.length >= INTENT_MIN_MESSAGE_LENGTH;

  return { goal, context, filePaths, score: bestScore, shouldStore };
}
