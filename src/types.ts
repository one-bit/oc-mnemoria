/**
 * Types for oc-mnemoria — aligned with the mnemoria Rust crate.
 */

/**
 * Memory entry types matching mnemoria's EntryType enum.
 */
export type EntryType =
  | "intent"
  | "discovery"
  | "decision"
  | "problem"
  | "solution"
  | "pattern"
  | "warning"
  | "success"
  | "refactor"
  | "bugfix"
  | "feature";

/**
 * A memory entry as returned by the mnemoria CLI (JSON output).
 */
export interface MemoryEntry {
  id: string;
  agent_name: string;
  entry_type: EntryType;
  summary: string;
  content: string;
  timestamp: number;
  checksum: number;
  prev_checksum: number;
}

/**
 * A search result from mnemoria.
 */
export interface SearchResult {
  id: string;
  entry: MemoryEntry;
  score: number;
}

/**
 * Statistics about a memory store.
 */
export interface MemoryStats {
  total_entries: number;
  file_size_bytes: number;
  oldest_timestamp: number | null;
  newest_timestamp: number | null;
}

/**
 * Options for timeline queries.
 */
export interface TimelineOptions {
  limit: number;
  since?: number;
  until?: number;
  reverse: boolean;
}

/**
 * Known opencode agent types. Extensible — any string is accepted.
 */
export type AgentName = "plan" | "build" | "ask" | "review" | (string & {});

/**
 * Configuration for the plugin.
 */
export interface PluginConfig {
  /** Parent directory passed to `mnemoria --path`. The CLI appends `mnemoria/` automatically. Default: ".opencode" */
  memoryDir: string;
  /** Maximum context observations injected into the system prompt. Default: 20 */
  maxContextObservations: number;
  /** Maximum token budget for context injection. Default: 2000 */
  maxContextTokens: number;
  /** Enable debug logging. Default: false */
  debug: boolean;
}

export const DEFAULT_CONFIG: PluginConfig = {
  memoryDir: ".opencode",
  maxContextObservations: 20,
  maxContextTokens: 2000,
  debug: false,
};

/**
 * Observation stored through the plugin (enriched with plugin-level metadata).
 */
export interface Observation {
  id: string;
  type: EntryType;
  summary: string;
  content: string;
  timestamp: number;
  /** The tool that produced this observation */
  tool?: string;
  /** The agent that owns this memory */
  agent?: AgentName;
  /** Metadata for chain linking */
  chainId?: string;
  parentId?: string;
  metadata?: ObservationMetadata;
}

export interface ObservationMetadata {
  callId?: string;
  filePaths?: string[];
  findings?: string[];
  patterns?: string[];
  sessionId?: string;
  userGoal?: string;
}

/**
 * What gets returned from extracting a user's intent.
 */
export interface UserIntent {
  goal: string;
  context: string[];
  filePaths: string[];
}
