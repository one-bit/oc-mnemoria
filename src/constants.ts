/**
 * oc-mnemoria — Centralized Constants
 *
 * All tunable configuration values, thresholds, limits, and magic strings
 * live here. Change any value in this file to adjust plugin behavior
 * without hunting through the codebase.
 */

import type { AgentName } from "./types.js";

// ─── Agent Defaults ──────────────────────────────────────────────────────────

/** Default agent name when none is provided by context or session. */
export const DEFAULT_AGENT: AgentName = "build";

// ─── Session Tracking ────────────────────────────────────────────────────────

/**
 * Maximum number of concurrent sessions to track before evicting the oldest.
 * Prevents unbounded memory growth in long-running processes.
 */
export const MAX_TRACKED_SESSIONS = 100;

/**
 * Maximum number of per-agent chain/parent entries in the Mind singleton.
 * Uses LRU eviction when exceeded.
 */
export const MAX_CHAIN_MAP_SIZE = 50;

// ─── Intent Classification ───────────────────────────────────────────────────

/**
 * Minimum weighted score from intent pattern matching before an intent
 * is considered strong enough to persist. Lower = more intents stored.
 */
export const INTENT_MIN_SCORE = 2;

/**
 * Minimum message length (characters) required for intent storage.
 * Messages shorter than this are ignored regardless of score.
 */
export const INTENT_MIN_MESSAGE_LENGTH = 20;

/**
 * Maximum message length (characters) to process for intent extraction.
 * Messages longer than this are skipped to avoid expensive regex work.
 */
export const INTENT_MAX_MESSAGE_LENGTH = 5000;

/**
 * Minimum message length (characters) to even attempt intent extraction.
 * Messages shorter than this are too brief to carry meaningful intent.
 */
export const INTENT_MIN_EXTRACT_LENGTH = 10;

/**
 * Maximum character length for the extracted goal string.
 * Goals are truncated to this length before storage.
 */
export const INTENT_GOAL_MAX_LENGTH = 200;

/**
 * Jaccard similarity threshold (0–1) for intent deduplication.
 * If a new intent's word overlap with the last stored intent exceeds
 * this value, the new intent is considered a duplicate and skipped.
 * Higher = more aggressive dedup (fewer intents stored).
 */
export const INTENT_DEDUP_SIMILARITY = 0.7;

// ─── Memory Markers ──────────────────────────────────────────────────────────

/**
 * Prefix used on summary lines to mark an entry as forgotten.
 * The compact operation uses this to identify entries to remove.
 */
export const FORGOTTEN_MARKER_PREFIX = "[FORGOTTEN] ";

// ─── Summary & Content Truncation ────────────────────────────────────────────

/**
 * Maximum character length for observation summaries stored via `mind.remember()`.
 * Prevents CLI argument overflow on extremely long summaries.
 */
export const SUMMARY_MAX_LENGTH = 200;

/**
 * Maximum character length for the extracted goal in `mind.setIntent()`.
 * This is the summary field, not the full content.
 */
export const INTENT_SUMMARY_MAX_LENGTH = 100;

/**
 * Maximum character length when displaying user goal content
 * in the system prompt's "Past User Goals" section.
 */
export const GOAL_DISPLAY_MAX_LENGTH = 150;

// ─── System Prompt Context Limits ────────────────────────────────────────────

/**
 * Maximum number of recent observations to include in the
 * system prompt's "Recent Context" section.
 */
export const CONTEXT_MAX_RECENT_OBSERVATIONS = 10;

/**
 * Maximum number of relevant memories to include in the
 * system prompt's "Relevant Memories" section.
 */
export const CONTEXT_MAX_RELEVANT_MEMORIES = 5;

/**
 * Maximum number of past user intents to include in the
 * system prompt's "Past User Goals" section.
 */
export const CONTEXT_MAX_PAST_INTENTS = 3;

// ─── Tool Defaults ───────────────────────────────────────────────────────────

/** Default result limit for the `search_memory` tool. */
export const SEARCH_DEFAULT_LIMIT = 10;

/** Default result limit for the `timeline` tool. */
export const TIMELINE_DEFAULT_LIMIT = 20;

/** Default reverse order for the `timeline` tool (newest first). */
export const TIMELINE_DEFAULT_REVERSE = true;

// ─── CLI Execution ───────────────────────────────────────────────────────────

/** Name of the mnemoria CLI binary on PATH. */
export const MNEMORIA_BIN = "mnemoria";

/**
 * Maximum number of retries for transient CLI failures
 * (lock contention, timeouts). Permanent errors are never retried.
 */
export const CLI_MAX_RETRIES = 2;

/**
 * Base delay (ms) between CLI retries. Doubled on each attempt
 * (exponential backoff: 100ms, 200ms, 400ms, ...).
 */
export const CLI_RETRY_BASE_DELAY_MS = 100;

/**
 * Default timeout (ms) for a single CLI command execution.
 * Commands that take longer than this are killed.
 */
export const CLI_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Maximum stdout/stderr buffer size (bytes) for CLI commands.
 * Prevents memory exhaustion on unexpectedly large output.
 * Default: 10 MB.
 */
export const CLI_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Timeout (ms) for the `mnemoria --help` availability check.
 * Shorter than the default command timeout since this should be instant.
 */
export const CLI_AVAILABILITY_TIMEOUT_MS = 5_000;

/**
 * TTL (ms) for the full-store export cache used by enrichment.
 * Cached exports are reused within this window to avoid redundant
 * subprocess invocations during rapid search/timeline calls.
 */
export const EXPORT_CACHE_TTL_MS = 2_000;

// ─── Token Estimation ────────────────────────────────────────────────────────

/**
 * Whitespace-to-length ratio above which text is considered "code-like"
 * (lots of indentation/newlines). Code-like text uses fewer chars per token.
 */
export const TOKEN_CODE_WHITESPACE_RATIO = 0.3;

/**
 * Whitespace-to-length ratio below which text is considered "dense"
 * (compact prose, no indentation). Dense text uses more chars per token.
 */
export const TOKEN_DENSE_WHITESPACE_RATIO = 0.12;

/** Estimated characters per token for code-like content. */
export const TOKEN_CHARS_PER_TOKEN_CODE = 3.5;

/** Estimated characters per token for dense/compact text. */
export const TOKEN_CHARS_PER_TOKEN_DENSE = 4.5;

/** Estimated characters per token for mixed content. */
export const TOKEN_CHARS_PER_TOKEN_MIXED = 4.0;

/**
 * Conservative chars-per-token ratio used for truncation.
 * Uses the lowest ratio to avoid over-truncating.
 */
export const TOKEN_CHARS_PER_TOKEN_CONSERVATIVE = 3.5;

// ─── Millisecond Helpers ─────────────────────────────────────────────────────

/** Number of milliseconds in one day. Used for age-based compaction. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
