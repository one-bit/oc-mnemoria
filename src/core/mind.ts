/**
 * Mind — per-agent memory manager.
 *
 * Each opencode agent (plan, build, ask, review, ...) gets its own isolated
 * mnemoria store under `.opencode/memory/<agent>/`. The Mind class wraps
 * a MnemoriaCli instance and adds chain-linking (intent tracking) on top.
 */

import { join } from "node:path";
import { MnemoriaCli } from "./mnemoria-cli.js";
import {
  DEFAULT_CONFIG,
  type AgentName,
  type EntryType,
  type MemoryStats,
  type Observation,
  type ObservationMetadata,
  type PluginConfig,
  type SearchResult,
  type TimelineOptions,
  type UserIntent,
} from "../types.js";
import { generateId, estimateTokens, truncateToTokens } from "../utils/helpers.js";

export class Mind {
  private cli: MnemoriaCli;
  private currentChainId: string | null = null;
  private currentParentId: string | null = null;
  private config: PluginConfig;
  private agent: AgentName;

  private constructor(cli: MnemoriaCli, agent: AgentName, config: PluginConfig) {
    this.cli = cli;
    this.agent = agent;
    this.config = config;
  }

  /**
   * Open (or create) a mind for the given agent.
   */
  static async open(
    agent: AgentName,
    config: Partial<PluginConfig> = {}
  ): Promise<Mind> {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    const projectDir = process.env.OPENCODE_PROJECT_DIR || process.cwd();
    const basePath = join(projectDir, mergedConfig.memoryDir, agent);

    const cli = new MnemoriaCli(basePath);
    await cli.ensureReady();

    return new Mind(cli, agent, mergedConfig);
  }

  /** The agent this mind belongs to. */
  getAgent(): AgentName {
    return this.agent;
  }

  /** The current intent chain ID. */
  getCurrentChainId(): string | null {
    return this.currentChainId;
  }

  /** The path to the memory store. */
  getMemoryPath(): string {
    return this.cli.storePath;
  }

  /**
   * Store a new observation.
   *
   * The content field is composed from the summary and any additional
   * metadata so that the full-text search index covers everything useful.
   */
  async remember(input: {
    type: EntryType;
    summary: string;
    content: string;
    tool?: string;
    metadata?: ObservationMetadata;
  }): Promise<string> {
    // Build a rich content string for the mnemoria store.
    const parts: string[] = [input.content];

    if (input.tool) {
      parts.push(`\nTool: ${input.tool}`);
    }
    if (input.metadata?.filePaths?.length) {
      parts.push(`Files: ${input.metadata.filePaths.join(", ")}`);
    }
    if (input.metadata?.findings?.length) {
      parts.push(`Findings: ${input.metadata.findings.join("; ")}`);
    }
    if (input.metadata?.patterns?.length) {
      parts.push(`Patterns: ${input.metadata.patterns.join("; ")}`);
    }
    if (this.currentChainId) {
      parts.push(`ChainId: ${this.currentChainId}`);
    }

    const fullContent = parts.join("\n");

    const id = await this.cli.add(input.type, input.summary, fullContent);
    this.currentParentId = id;
    return id;
  }

  /**
   * Store an observation linked to the current intent chain.
   */
  async rememberWithContext(input: {
    type: EntryType;
    summary: string;
    content: string;
    tool?: string;
    metadata?: ObservationMetadata;
  }): Promise<string> {
    const enrichedMetadata: ObservationMetadata = {
      ...input.metadata,
      sessionId: this.currentChainId ?? undefined,
    };

    return this.remember({
      ...input,
      metadata: enrichedMetadata,
    });
  }

  /**
   * Set the user's intent for this conversation turn.
   * Creates a new chain ID that links subsequent observations.
   */
  async setIntent(message: string, extractedGoal: string): Promise<string> {
    this.currentChainId = generateId();
    this.currentParentId = null;

    const id = await this.cli.add(
      "intent",
      `Intent: ${extractedGoal.slice(0, 100)}`,
      `User message: ${message}\nExtracted goal: ${extractedGoal}\nChainId: ${this.currentChainId}`
    );

    this.currentParentId = id;
    return id;
  }

  /**
   * Search memories.
   */
  async search(query: string, limit = 10): Promise<SearchResult[]> {
    return this.cli.search(query, limit);
  }

  /**
   * Ask a question about past memories.
   */
  async ask(question: string): Promise<string> {
    return this.cli.ask(question);
  }

  /**
   * Get a timeline of memories.
   */
  async timeline(options?: Partial<TimelineOptions>): Promise<Observation[]> {
    const entries = await this.cli.timeline(options);
    return entries.map((e) => ({
      id: e.id,
      type: e.entry_type,
      summary: e.summary,
      content: e.content,
      timestamp: e.timestamp,
      agent: this.agent,
    }));
  }

  /**
   * Get memory statistics.
   */
  async stats(): Promise<MemoryStats> {
    return this.cli.stats();
  }

  /**
   * Build context for system prompt injection.
   * Returns recent observations capped by token budget.
   */
  async getContext(query?: string): Promise<{
    recentObservations: Observation[];
    relevantMemories: SearchResult[];
    tokenCount: number;
  }> {
    const maxObs = this.config.maxContextObservations;
    const maxTokens = this.config.maxContextTokens;

    // Get recent timeline entries
    const entries = await this.cli.timeline({ limit: maxObs, reverse: true });

    let tokenCount = 0;
    const recentObservations: Observation[] = [];

    for (const entry of entries) {
      const text = `[${entry.entry_type}] ${entry.summary}`;
      const tokens = estimateTokens(text);
      if (tokenCount + tokens > maxTokens) break;
      tokenCount += tokens;

      recentObservations.push({
        id: entry.id,
        type: entry.entry_type,
        summary: entry.summary,
        content: entry.content,
        timestamp: entry.timestamp,
        agent: this.agent,
      });
    }

    // Optionally search for relevant memories
    let relevantMemories: SearchResult[] = [];
    if (query) {
      relevantMemories = await this.cli.search(query, 5);
    }

    return { recentObservations, relevantMemories, tokenCount };
  }
}

// ─── Singleton cache per agent ───────────────────────────────────────────────

const mindCache = new Map<AgentName, Mind>();

/**
 * Get or create a Mind instance for the given agent.
 * Uses a singleton cache so the same agent always returns the same instance.
 */
export async function getMind(
  agent: AgentName,
  config?: Partial<PluginConfig>
): Promise<Mind> {
  const cached = mindCache.get(agent);
  if (cached) return cached;

  const mind = await Mind.open(agent, config);
  mindCache.set(agent, mind);
  return mind;
}

/**
 * Reset the cache for a specific agent (or all agents).
 */
export function resetMind(agent?: AgentName): void {
  if (agent) {
    mindCache.delete(agent);
  } else {
    mindCache.clear();
  }
}
