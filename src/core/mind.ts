/**
 * Mind — shared hive-mind memory manager.
 *
 * All agents share a single mnemoria store at `.opencode/mnemoria/`. Each
 * memory entry is tagged with the agent that created it via mnemoria's
 * native `--agent` flag, so agents can see each other's memories while
 * still knowing who recorded what.
 */

import { join } from "node:path";
import { MnemoriaCli } from "./mnemoria-cli.js";
import {
  DEFAULT_CONFIG,
  type AgentName,
  type EntryType,
  type MemoryEntry,
  type MemoryStats,
  type Observation,
  type ObservationMetadata,
  type PluginConfig,
  type SearchResult,
  type TimelineOptions,
} from "../types.js";
import { generateId, estimateTokens } from "../utils/helpers.js";
import {
  MAX_CHAIN_MAP_SIZE,
  FORGOTTEN_MARKER_PREFIX,
  SUMMARY_MAX_LENGTH,
  INTENT_SUMMARY_MAX_LENGTH,
  MS_PER_DAY,
} from "../constants.js";

export class Mind {
  private cli: MnemoriaCli;
  private chainIds = new Map<string, string>();
  private parentIds = new Map<string, string>();
  private config: PluginConfig;

  private constructor(cli: MnemoriaCli, config: PluginConfig) {
    this.cli = cli;
    this.config = config;
  }

  private sessionKey(agent: AgentName): string {
    return agent;
  }

  /** Evict the oldest entry when the map exceeds the size cap. */
  private evictIfNeeded(map: Map<string, string>): void {
    if (map.size > MAX_CHAIN_MAP_SIZE) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) {
        map.delete(oldest);
      }
    }
  }

  /** Touch an entry to move it to the end (most-recently-used). */
  private touchKey(map: Map<string, string>, key: string): void {
    const value = map.get(key);
    if (value !== undefined) {
      map.delete(key);
      map.set(key, value);
    }
  }

  /**
   * Open (or create) the shared hive-mind store.
   */
  static async open(config: Partial<PluginConfig> = {}): Promise<Mind> {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    const projectDir = process.env.OPENCODE_PROJECT_DIR || process.cwd();
    const basePath = join(projectDir, mergedConfig.memoryDir);

    const cli = new MnemoriaCli(basePath);
    await cli.ensureReady();

    return new Mind(cli, mergedConfig);
  }

  /** The current intent chain ID for a given agent. */
  getCurrentChainId(agent?: AgentName): string | null {
    if (!agent) return null;
    const key = this.sessionKey(agent);
    this.touchKey(this.chainIds, key);
    return this.chainIds.get(key) ?? null;
  }

  /** The path to the memory store. */
  getMemoryPath(): string {
    return this.cli.storePath;
  }

  /**
   * Store a new observation, tagged with the agent that created it.
   */
  async remember(input: {
    type: EntryType;
    summary: string;
    content: string;
    agent: AgentName;
    tool?: string;
    metadata?: ObservationMetadata;
  }): Promise<string> {
    const parts: string[] = [input.content];
    const sessionKey = this.sessionKey(input.agent);
    const chainId = this.chainIds.get(sessionKey);

    if (input.tool) {
      parts.push(`Tool: ${input.tool}`);
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
    if (chainId) {
      parts.push(`ChainId: ${chainId}`);
    }

    const fullContent = parts.join("\n");
    const truncatedSummary = input.summary.slice(0, SUMMARY_MAX_LENGTH);

    const id = await this.cli.add(
      input.type,
      truncatedSummary,
      fullContent,
      input.agent
    );
    this.parentIds.set(sessionKey, id);
    this.evictIfNeeded(this.parentIds);
    return id;
  }

  /**
   * Store an observation linked to the current intent chain.
   */
  async rememberWithContext(input: {
    type: EntryType;
    summary: string;
    content: string;
    agent: AgentName;
    tool?: string;
    metadata?: ObservationMetadata;
  }): Promise<string> {
    const chainId = this.chainIds.get(this.sessionKey(input.agent));
    const enrichedMetadata: ObservationMetadata = {
      ...input.metadata,
      sessionId: chainId ?? undefined,
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
  async setIntent(
    message: string,
    extractedGoal: string,
    agent: AgentName
  ): Promise<string> {
    const sessionKey = this.sessionKey(agent);
    const newChainId = generateId();
    this.chainIds.set(sessionKey, newChainId);
    this.evictIfNeeded(this.chainIds);
    this.parentIds.delete(sessionKey);

    const id = await this.cli.add(
      "intent",
      `Intent: ${extractedGoal.slice(0, INTENT_SUMMARY_MAX_LENGTH)}`,
      `User message: ${message}\nExtracted goal: ${extractedGoal}\nChainId: ${newChainId}`,
      agent
    );

    this.parentIds.set(sessionKey, id);
    this.evictIfNeeded(this.parentIds);
    return id;
  }

  /**
   * Mark a memory as forgotten/obsolete.
   *
   * Since the store is append-only, this records a "forgotten" marker
   * entry rather than physically deleting. Markers are ID-based to avoid
   * accidental deletion when multiple entries share the same summary.
   */
  async forget(
    target: { id?: string; summary?: string },
    reason: string,
    agent: AgentName
  ): Promise<{ markerId: string; forgottenId: string; forgottenSummary: string }> {
    if (!target.id && !target.summary) {
      throw new Error("forget requires either an entry id or summary");
    }

    const allEntries = await this.cli.exportAll();
    const entry = this.resolveForgetTarget(allEntries, target);

    const markerId = await this.cli.add(
      "warning",
      `${FORGOTTEN_MARKER_PREFIX}${entry.id}`,
      `Reason: ${reason}\nOriginal id: ${entry.id}\nOriginal summary: ${entry.summary}`,
      agent
    );

    return {
      markerId,
      forgottenId: entry.id,
      forgottenSummary: entry.summary,
    };
  }

  /**
   * Search the shared memory. Optionally filter by agent.
   * Results are enriched with full content when available.
   */
  async search(query: string, limit = 10, agent?: AgentName): Promise<SearchResult[]> {
    const results = await this.cli.search(query, limit, agent);
    return this.cli.enrichSearchResults(results);
  }

  /**
   * Ask a question against the shared memory. Optionally filter by agent.
   */
  async ask(question: string, agent?: AgentName): Promise<string> {
    return this.cli.ask(question, agent);
  }

  /**
   * Get a timeline of memories. Optionally filter by agent.
   * Entries are enriched with full content when available.
   */
  async timeline(options?: Partial<TimelineOptions>, agent?: AgentName): Promise<Observation[]> {
    const rawEntries = await this.cli.timeline(options, agent);
    const entries = await this.cli.enrichTimelineEntries(rawEntries);
    return entries.map((e) => ({
      id: e.id,
      type: e.entry_type,
      summary: e.summary,
      content: e.content,
      timestamp: e.timestamp,
      agent: e.agent_name as AgentName,
    }));
  }

  /**
   * Get memory statistics for the shared store.
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

    const entries = await this.cli.timeline({ limit: maxObs, reverse: true });

    let tokenCount = 0;
    const recentObservations: Observation[] = [];

    for (const entry of entries) {
      const text = `[${entry.entry_type}] (${entry.agent_name}) ${entry.summary}`;
      const tokens = estimateTokens(text);
      if (tokenCount + tokens > maxTokens) break;
      tokenCount += tokens;

      recentObservations.push({
        id: entry.id,
        type: entry.entry_type,
        summary: entry.summary,
        content: entry.content,
        timestamp: entry.timestamp,
        agent: entry.agent_name as AgentName,
      });
    }

    let relevantMemories: SearchResult[] = [];
    if (query) {
      relevantMemories = await this.cli.search(query, 5);
    }

    return { recentObservations, relevantMemories, tokenCount };
  }

  /**
   * Compact the memory store by removing forgotten/obsolete entries
   * and optionally pruning entries older than a given age.
   *
   * @param maxAgeDays - If provided, remove entries older than this many days
   * @returns Object with counts of kept and removed entries
   */
  async compact(maxAgeDays?: number): Promise<{ kept: number; removed: number }> {
    const allEntries = await this.cli.exportAll();

    // Collect entries that have been marked as forgotten.
    const forgottenIds = new Set<string>();
    const forgottenSummaries = new Set<string>();
    for (const entry of allEntries) {
      if (entry.summary.startsWith(FORGOTTEN_MARKER_PREFIX)) {
        const idFromSummary = entry.summary
          .slice(FORGOTTEN_MARKER_PREFIX.length)
          .trim();
        if (idFromSummary) {
          forgottenIds.add(idFromSummary);
        }

        const originalId = entry.content.match(/Original id:\s*(\S+)/);
        if (originalId?.[1]) {
          forgottenIds.add(originalId[1].trim());
        }

        const original = entry.content.match(/Original summary:\s*(.+)/);
        if (original?.[1]) {
          forgottenSummaries.add(original[1].trim());
        }
      }
    }

    const cutoff = maxAgeDays
      ? Date.now() - maxAgeDays * MS_PER_DAY
      : 0;

    // Filter: keep entries that are not forgotten and not too old
    const kept = allEntries.filter((entry) => {
      // Remove [FORGOTTEN] markers themselves
      if (entry.summary.startsWith(FORGOTTEN_MARKER_PREFIX)) return false;
      // Remove entries whose IDs match a forgotten marker
      if (forgottenIds.has(entry.id)) return false;
      // Remove entries whose summaries match a forgotten marker
      if (forgottenSummaries.has(entry.summary)) return false;
      // Remove entries older than the cutoff (if specified)
      if (cutoff > 0 && entry.timestamp > 0 && entry.timestamp < cutoff) return false;
      return true;
    });

    const removed = allEntries.length - kept.length;

    if (removed > 0) {
      // Rebuild the store: delete and re-add all kept entries
      await this.cli.rebuild(kept);
    }

    return { kept: kept.length, removed };
  }

  private resolveForgetTarget(
    allEntries: MemoryEntry[],
    target: { id?: string; summary?: string }
  ): MemoryEntry {
    const nonMarkers = allEntries.filter(
      (entry) => !entry.summary.startsWith(FORGOTTEN_MARKER_PREFIX)
    );

    if (target.id) {
      const byId = nonMarkers.find((entry) => entry.id === target.id);
      if (!byId) {
        throw new Error(`No memory entry found with id: ${target.id}`);
      }
      return byId;
    }

    const summary = target.summary ?? "";
    const matches = nonMarkers.filter((entry) => entry.summary === summary);
    if (matches.length === 0) {
      throw new Error(`No memory entry found with summary: ${summary}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Summary is ambiguous (${matches.length} matches). Please use entry id instead.`
      );
    }
    return matches[0];
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let mindPromise: Promise<Mind> | null = null;

/**
 * Get or create the shared Mind instance.
 * All agents share this single instance (and single mnemoria store).
 *
 * The promise itself is cached to prevent a race condition where two
 * concurrent callers both trigger Mind.open() before either resolves.
 */
export async function getMind(
  config?: Partial<PluginConfig>
): Promise<Mind> {
  if (!mindPromise) {
    mindPromise = Mind.open(config).catch((err) => {
      mindPromise = null; // Clear cache so next call retries
      throw err;
    });
  }
  return mindPromise;
}

/**
 * Reset the shared Mind singleton (for testing).
 */
export function resetMind(): void {
  mindPromise = null;
}
