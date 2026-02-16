/**
 * oc-mnemoria — OpenCode Plugin
 *
 * Persistent shared memory ("hive mind") for OpenCode agents, powered by
 * the mnemoria Rust engine (v0.3.1+). All agents share a single memory
 * store — each entry is tagged with the agent that created it via
 * mnemoria's native --agent flag.
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { getMind } from "./core/mind.js";
import { MnemoriaCli } from "./core/mnemoria-cli.js";
import {
  extractUserIntent,
} from "./utils/helpers.js";
import { ENTRY_TYPES } from "./types.js";
import type { AgentName, EntryType, SearchResult } from "./types.js";
import {
  DEFAULT_AGENT,
  MAX_TRACKED_SESSIONS,
  INTENT_DEDUP_SIMILARITY,
  INTENT_MIN_EXTRACT_LENGTH,
  INTENT_MAX_MESSAGE_LENGTH,
  SEARCH_DEFAULT_LIMIT,
  TIMELINE_DEFAULT_LIMIT,
  TIMELINE_DEFAULT_REVERSE,
  CONTEXT_MAX_RECENT_OBSERVATIONS,
  CONTEXT_MAX_RELEVANT_MEMORIES,
  CONTEXT_MAX_PAST_INTENTS,
  GOAL_DISPLAY_MAX_LENGTH,
} from "./constants.js";

/** Counter for hook failures (aids debugging). */
let hookFailureCount = 0;

/** Resolve an unknown agent value to a valid AgentName. */
function resolveAgent(value: unknown, fallback: AgentName = DEFAULT_AGENT): AgentName {
  if (typeof value === "string" && value.length > 0) return value as AgentName;
  return fallback;
}

/** Strip common intent prefixes before comparison. */
function stripIntentPrefix(goal: string): string {
  return goal.replace(/^(Fix|Refactor|Test|Implement|Understand):\s*/i, "");
}

/**
 * Check if the new intent is similar to the last stored intent for this session.
 * Returns true if the intents are likely duplicates.
 */
function isSimilarIntent(newGoal: string, lastGoal: string): boolean {
  const newWords = new Set(stripIntentPrefix(newGoal).toLowerCase().split(/\s+/));
  const lastWords = new Set(stripIntentPrefix(lastGoal).toLowerCase().split(/\s+/));

  let intersection = 0;
  for (const word of lastWords) {
    if (newWords.has(word)) intersection++;
  }

  const union = newWords.size + lastWords.size - intersection;
  if (union === 0) return true;

  const similarity = intersection / union;
  return similarity >= INTENT_DEDUP_SIMILARITY;
}

/** Encapsulated session state — prevents unbounded growth of loose Maps. */
class SessionTracker {
  private agents = new Map<string, AgentName>();
  private lastIntents = new Map<string, string>();

  setAgent(sessionID: string, agent: AgentName): void {
    this.agents.delete(sessionID);
    this.agents.set(sessionID, agent);
    if (this.agents.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.agents.keys().next().value;
      if (oldest !== undefined) {
        this.agents.delete(oldest);
        this.lastIntents.delete(oldest);
      }
    }
  }

  getAgent(sessionID?: string): AgentName {
    if (sessionID) return this.agents.get(sessionID) ?? DEFAULT_AGENT;
    return DEFAULT_AGENT;
  }

  getLastIntent(sessionID: string): string | undefined {
    return this.lastIntents.get(sessionID);
  }

  setLastIntent(sessionID: string, goal: string): void {
    this.lastIntents.set(sessionID, goal);
  }
}

const sessions = new SessionTracker();

const OcMnemoria: Plugin = async (_input: PluginInput) => {
  const available = await MnemoriaCli.isAvailable();
  if (!available) {
    console.error(
      "[oc-mnemoria] WARNING: 'mnemoria' CLI not found on PATH. " +
        "Install it with: cargo install mnemoria"
    );
  } else {
    console.error("[oc-mnemoria] Plugin loaded successfully!");
  }

  return {
    tool: {
      remember: tool({
        description:
          "Store important information in the shared memory for future sessions. " +
          "All agents share one memory store — entries are tagged with the creating agent.",
        args: {
          type: tool.schema
            .enum([...ENTRY_TYPES])
            .describe("Type of observation"),
          summary: tool.schema
            .string()
            .describe("Brief summary of what to remember"),
          content: tool.schema
            .string()
            .describe("Detailed content to store"),
        },
        async execute(args, context) {
          const mind = await getMind();
          const agentName = resolveAgent(context.agent);
          const id = await mind.remember({
            type: args.type as EntryType,
            summary: args.summary,
            content: args.content,
            agent: agentName,
          });
          return `Stored in memory (${agentName}): ${args.summary} (id: ${id})`;
        },
      }),

      search_memory: tool({
        description:
          "Search the shared memory using keyword or semantic search. " +
          "Results may come from any agent unless filtered. " +
          "Do NOT use wildcards like * — only search for specific topics or keywords.",
        args: {
          query: tool.schema
            .string()
            .describe(
              "Specific topic or keyword to search for (no wildcards)"
            ),
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum results (default: 10)"),
          agent: tool.schema
            .string()
            .optional()
            .describe(
              "Filter results to a specific agent (plan, build, ask, review). If omitted, searches all agents."
            ),
        },
        async execute(args) {
          if (args.query.includes("*")) {
            return "Error: Wildcard characters like * are not supported. Please search for a specific topic or keyword instead.";
          }

          const mind = await getMind();
          const results = await mind.search(
            args.query,
            args.limit ?? SEARCH_DEFAULT_LIMIT,
            args.agent ? resolveAgent(args.agent) : undefined
          );

          if (results.length === 0) {
            return "No memories found matching that query.";
          }

          const output = results
            .map(
              (r, i) =>
                `${i + 1}. [${r.entry.entry_type}] (${r.entry.agent_name}) ${r.entry.summary}\n   Score: ${r.score.toFixed(2)}`
            )
            .join("\n\n");

          return `Found ${results.length} memories:\n\n${output}`;
        },
      }),

      ask_memory: tool({
        description:
          "Ask a question about past sessions and get an answer from the shared memory",
        args: {
          question: tool.schema
            .string()
            .describe("Question to ask about past interactions"),
          agent: tool.schema
            .string()
            .optional()
            .describe(
              "Filter to a specific agent's memories (plan, build, ask, review). If omitted, searches all."
            ),
        },
        async execute(args) {
          const mind = await getMind();
          return await mind.ask(
            args.question,
            args.agent ? resolveAgent(args.agent) : undefined
          );
        },
      }),

      memory_stats: tool({
        description: "Get statistics about the shared memory store",
        args: {},
        async execute() {
          const mind = await getMind();
          const stats = await mind.stats();

          return (
            `Memory Statistics:\n` +
            `- Total entries: ${stats.total_entries}\n` +
            `- File size: ${(stats.file_size_bytes / 1024).toFixed(1)} KB\n` +
            `- Oldest: ${stats.oldest_timestamp ? new Date(stats.oldest_timestamp).toISOString() : "N/A"}\n` +
            `- Newest: ${stats.newest_timestamp ? new Date(stats.newest_timestamp).toISOString() : "N/A"}`
          );
        },
      }),

      timeline: tool({
        description:
          "Get memories in chronological order from the shared store. " +
          "Entries from all agents are shown unless filtered.",
        args: {
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum number of memories to return (default: 20)"),
          since: tool.schema
            .number()
            .optional()
            .describe("Start timestamp (Unix epoch in milliseconds)"),
          until: tool.schema
            .number()
            .optional()
            .describe("End timestamp (Unix epoch in milliseconds)"),
          reverse: tool.schema
            .boolean()
            .optional()
            .describe("Reverse order (newest first, default: true)"),
          agent: tool.schema
            .string()
            .optional()
            .describe(
              "Filter to a specific agent (plan, build, ask, review). If omitted, shows all."
            ),
        },
        async execute(args) {
          const mind = await getMind();
          const observations = await mind.timeline(
            {
              limit: args.limit ?? TIMELINE_DEFAULT_LIMIT,
              since: args.since,
              until: args.until,
              reverse: args.reverse ?? TIMELINE_DEFAULT_REVERSE,
            },
            args.agent ? resolveAgent(args.agent) : undefined
          );

          if (observations.length === 0) {
            return "No memories found in timeline.";
          }

          const output = observations
            .map((obs, i) => {
              const date =
                obs.timestamp > 0
                  ? new Date(obs.timestamp).toISOString()
                  : "unknown";
              const agentTag = obs.agent ? ` (${obs.agent})` : "";
              return `${i + 1}. [${obs.type}]${agentTag} ${obs.summary}\n   Date: ${date}`;
            })
            .join("\n\n");

          return `Timeline (${observations.length} memories):\n\n${output}`;
        },
      }),

      forget: tool({
        description:
          "Mark a memory as forgotten/obsolete. Since the store is append-only, " +
          "this records a marker rather than physically deleting. Use this when " +
          "a previously stored memory is incorrect, outdated, or no longer relevant.",
        args: {
          id: tool.schema
            .string()
            .optional()
            .describe("Entry ID to forget (recommended; avoids summary collisions)"),
          summary: tool.schema
            .string()
            .optional()
            .describe("The summary of the memory to forget (should match the original)"),
          reason: tool.schema
            .string()
            .describe("Why this memory should be forgotten"),
        },
        async execute(args, context) {
          if (!args.id && !args.summary) {
            return "Error: Provide either 'id' (recommended) or 'summary' to forget a memory.";
          }

          const mind = await getMind();
          const agentName = resolveAgent(context.agent);
          const result = await mind.forget(
            {
              id: args.id as string | undefined,
              summary: args.summary as string | undefined,
            },
            args.reason,
            agentName
          );
          return (
            `Marked as forgotten (${agentName}): ${result.forgottenSummary} ` +
            `(id: ${result.forgottenId}, marker id: ${result.markerId})`
          );
        },
      }),

      compact: tool({
        description:
          "Compact the memory store by removing forgotten markers/entries and optionally pruning old memories. " +
          "Use this to keep long-running stores tidy and performant.",
        args: {
          maxAgeDays: tool.schema
            .number()
            .optional()
            .describe(
              "If provided, remove entries older than this many days during compaction"
            ),
        },
        async execute(args) {
          const mind = await getMind();
          const result = await mind.compact(args.maxAgeDays as number | undefined);
          const ageHint =
            typeof args.maxAgeDays === "number"
              ? ` (max age: ${args.maxAgeDays} days)`
              : "";
          return `Compaction complete${ageHint}: kept ${result.kept}, removed ${result.removed}.`;
        },
      }),
    },

    "chat.message": async (hookInput, hookOutput) => {
      try {
        const sessionID = hookInput.sessionID;
        const agentName = resolveAgent(hookInput.agent);

        // Always track the session agent (cheap in-memory operation)
        sessions.setAgent(sessionID, agentName);

        const message = hookOutput.message;
        const mind = await getMind();

        let messageText = "";
        if (typeof message === "string") {
          messageText = message;
        } else if (message && typeof message === "object") {
          if ("text" in message) {
            messageText = message.text as string;
          } else if ("content" in message) {
            messageText = message.content as string;
          }
        }

        if (
          messageText &&
          messageText.length > INTENT_MIN_EXTRACT_LENGTH &&
          messageText.length < INTENT_MAX_MESSAGE_LENGTH
        ) {
          const intent = extractUserIntent(messageText);

          // Check deduplication - skip if similar to last intent in this session
          if (intent.shouldStore) {
            const lastIntent = sessions.getLastIntent(sessionID);
            if (lastIntent && isSimilarIntent(intent.goal, lastIntent)) {
              return; // Skip - similar intent already stored
            }

            await mind.setIntent(messageText, intent.goal, agentName);
            sessions.setLastIntent(sessionID, intent.goal);
            console.error(
              `[oc-mnemoria] [${agentName}] Set intent: ${intent.goal.slice(0, 50)}`
            );
          }
        }
      } catch (err) {
        hookFailureCount++;
        console.error(
          `[oc-mnemoria] Failed to capture intent (failure #${hookFailureCount}):`,
          err instanceof Error ? err.message : err
        );
      }
    },

    "experimental.chat.system.transform": async (_hookInput, hookOutput) => {
      try {
        const mind = await getMind();

        hookOutput.system.push(
          "",
          "## Memory Guidance",
          "You have access to a persistent shared memory (hive mind). All agents (plan, build, ask, review) share one memory store.",
          "Each entry is tagged with the agent that created it. You can filter by agent when searching or viewing the timeline.",
          "",
          "Before responding to the user:",
          "1. Consider if past sessions contain relevant context — use 'search_memory' to find related memories",
          "2. Use 'ask_memory' to answer questions about previous work or decisions",
          "3. Memories from other agents may contain useful context for your task",
          "",
          "After providing your response, proactively use 'remember' to store:",
          "- Key decisions made and why",
          "- Important findings or discoveries",
          "- Solutions to problems encountered",
          "- Any context the user might want to reference in future sessions",
          ""
        );

        // Single getContext() call — extract intent for a targeted search
        const context = await mind.getContext();

        // Extract the latest intent to use as a relevance query
        const intentObs = context.recentObservations.find(
          (obs) => obs.type === "intent"
        );
        const intentQuery = intentObs?.summary.replace(/^Intent:\s*/i, "") ?? undefined;

        // Only search for relevant memories if we have an intent query
        let relevantMemories: SearchResult[] = [];
        if (intentQuery) {
          relevantMemories = await mind.search(intentQuery, 5);
        }

        const sections: string[] = [];

        if (context.recentObservations.length > 0) {
          const recentLines = context.recentObservations
            .slice(0, CONTEXT_MAX_RECENT_OBSERVATIONS)
            .map((obs) => {
              const agentTag = obs.agent ? ` (${obs.agent})` : "";
              return `- [${obs.type}]${agentTag} ${obs.summary}`;
            });

          sections.push(
            "## Recent Context (from shared memory)",
            ...recentLines,
            ""
          );
        }

        // Add relevant memories if the search found matches
        if (relevantMemories.length > 0) {
          const relevantLines = relevantMemories
            .slice(0, CONTEXT_MAX_RELEVANT_MEMORIES)
            .map((r) => {
              const agentTag = r.entry.agent_name ? ` (${r.entry.agent_name})` : "";
              return `- [${r.entry.entry_type}]${agentTag} ${r.entry.summary}`;
            });
          sections.push("## Relevant Memories", ...relevantLines, "");
        }

        const intentObservations = context.recentObservations.filter(
          (obs) => obs.type === "intent"
        );
        if (intentObservations.length > 0) {
          const intentLines = intentObservations
            .slice(0, CONTEXT_MAX_PAST_INTENTS)
            .map((obs) => {
              const agentTag = obs.agent ? ` (via ${obs.agent})` : "";
              return `- User goal${agentTag}: ${obs.content.slice(0, GOAL_DISPLAY_MAX_LENGTH)}`;
            });
          sections.push("## Past User Goals", ...intentLines, "");
        }

        if (sections.length > 0) {
          hookOutput.system.push("", ...sections);
        }
      } catch (err) {
        console.error("[oc-mnemoria] Failed to inject context:", err);
      }
    },
  };
};

export default OcMnemoria;
