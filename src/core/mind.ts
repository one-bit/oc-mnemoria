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

/** Pending observation for the batch queue. */
interface PendingObservation {
  type: EntryType;
  summary: string;
  content: string;
  agent: AgentName;
}

/** How long (ms) to wait before flushing the batch queue. */
const BATCH_FLUSH_DELAY_MS = 500;
/** Maximum batch size before forcing an immediate flush. */
const BATCH_MAX_SIZE = 20;

export class Mind {
  private cli: MnemoriaCli;
  private currentChainId: string | null = null;
  private currentParentId: string | null = null;
  private config: PluginConfig;

  // Batch queue for auto-captured observations
  private batchQueue: PendingObservation[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  private constructor(cli: MnemoriaCli, config: PluginConfig) {
    this.cli = cli;
    this.config = config;
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

  /** The current intent chain ID. */
  getCurrentChainId(): string | null {
    return this.currentChainId;
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
    if (this.currentChainId) {
      parts.push(`ChainId: ${this.currentChainId}`);
    }

    const fullContent = parts.join("\n");

    const id = await this.cli.add(
      input.type,
      input.summary,
      fullContent,
      input.agent
    );
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
    agent: AgentName;
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
   * Queue an observation for batched writing.
   * Observations are flushed after BATCH_FLUSH_DELAY_MS or when the
   * queue reaches BATCH_MAX_SIZE, whichever comes first.
   */
  queueObservation(input: {
    type: EntryType;
    summary: string;
    content: string;
    agent: AgentName;
  }): void {
    this.batchQueue.push(input);

    // Force flush if we've hit the max batch size
    if (this.batchQueue.length >= BATCH_MAX_SIZE) {
      void this.flushBatch();
      return;
    }

    // Otherwise, schedule a delayed flush
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        void this.flushBatch();
      }, BATCH_FLUSH_DELAY_MS);
    }
  }

  /**
   * Flush all pending observations to the store.
   */
  async flushBatch(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.flushing || this.batchQueue.length === 0) return;

    this.flushing = true;
    const batch = this.batchQueue.splice(0);
    let nextIndex = 0;

    try {
      // Write all entries sequentially (mnemoria uses file locks)
      for (; nextIndex < batch.length; nextIndex++) {
        const obs = batch[nextIndex];
        await this.cli.add(obs.type, obs.summary, obs.content, obs.agent);
      }
    } catch (err) {
      // Re-queue entries that were not written yet so observations are not lost.
      const remaining = batch.slice(nextIndex);
      if (remaining.length > 0) {
        this.batchQueue.unshift(...remaining);
      }
      console.error(`[oc-mnemoria] Failed to flush batch (${batch.length} entries):`, err);
    } finally {
      this.flushing = false;

      // If new observations were queued while flushing, ensure another flush runs.
      if (this.batchQueue.length > 0 && !this.batchTimer) {
        this.batchTimer = setTimeout(() => {
          void this.flushBatch();
        }, BATCH_FLUSH_DELAY_MS);
      }
    }
  }

  /** Number of observations waiting in the batch queue. */
  get pendingCount(): number {
    return this.batchQueue.length;
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
    this.currentChainId = generateId();
    this.currentParentId = null;

    const id = await this.cli.add(
      "intent",
      `Intent: ${extractedGoal.slice(0, 100)}`,
      `User message: ${message}\nExtracted goal: ${extractedGoal}\nChainId: ${this.currentChainId}`,
      agent
    );

    this.currentParentId = id;
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
      `[FORGOTTEN] ${entry.id}`,
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
      if (entry.summary.startsWith("[FORGOTTEN] ")) {
        const idFromSummary = entry.summary
          .slice("[FORGOTTEN] ".length)
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
      ? Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
      : 0;

    // Filter: keep entries that are not forgotten and not too old
    const kept = allEntries.filter((entry) => {
      // Remove [FORGOTTEN] markers themselves
      if (entry.summary.startsWith("[FORGOTTEN] ")) return false;
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
      (entry) => !entry.summary.startsWith("[FORGOTTEN] ")
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
    mindPromise = Mind.open(config);
  }
  return mindPromise;
}

/**
 * Reset the shared Mind singleton (for testing).
 */
export function resetMind(): void {
  mindPromise = null;
}
