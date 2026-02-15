/**
 * Mind — shared hive-mind memory manager.
 *
 * All agents share a single mnemoria store at `.opencode/memory/`. Each
 * memory entry is tagged with the agent that created it, so agents can
 * see each other's memories while still knowing who recorded what.
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
} from "../types.js";
import { generateId, estimateTokens } from "../utils/helpers.js";

/** Parse an agent name from content that starts with "Agent: <name>\n". */
function parseAgentFromContent(content: string): AgentName | undefined {
  const match = content.match(/^Agent:\s*(\S+)/);
  return match?.[1] as AgentName | undefined;
}

export class Mind {
  private cli: MnemoriaCli;
  private currentChainId: string | null = null;
  private currentParentId: string | null = null;
  private config: PluginConfig;

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
   *
   * The agent name is embedded in the content as an `Agent: <name>` line
   * so it's indexed by the full-text engine and visible on retrieval.
   */
  async remember(input: {
    type: EntryType;
    summary: string;
    content: string;
    agent?: AgentName;
    tool?: string;
    metadata?: ObservationMetadata;
  }): Promise<string> {
    // Build a rich content string for the mnemoria store.
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
    agent?: AgentName;
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
  async setIntent(
    message: string,
    extractedGoal: string,
    agent?: AgentName
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
   * Search the shared memory. Results may come from any agent.
   */
  async search(query: string, limit = 10): Promise<SearchResult[]> {
    return this.cli.search(query, limit);
  }

  /**
   * Ask a question against the shared memory.
   */
  async ask(question: string): Promise<string> {
    return this.cli.ask(question);
  }

  /**
   * Get a timeline of memories from all agents.
   * The agent name is parsed from each entry's content.
   */
  async timeline(options?: Partial<TimelineOptions>): Promise<Observation[]> {
    const entries = await this.cli.timeline(options);
    return entries.map((e) => ({
      id: e.id,
      type: e.entry_type,
      summary: e.summary,
      content: e.content,
      timestamp: e.timestamp,
      agent: parseAgentFromContent(e.content),
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
        agent: parseAgentFromContent(entry.content),
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

// ─── Singleton ───────────────────────────────────────────────────────────────

let mindInstance: Mind | null = null;

/**
 * Get or create the shared Mind instance.
 * All agents share this single instance (and single mnemoria store).
 */
export async function getMind(
  config?: Partial<PluginConfig>
): Promise<Mind> {
  if (mindInstance) return mindInstance;

  mindInstance = await Mind.open(config);
  return mindInstance;
}

/**
 * Reset the shared Mind singleton (for testing).
 */
export function resetMind(): void {
  mindInstance = null;
}
