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
  extractKeyInfo,
  classifyObservationType,
  extractUserIntent,
} from "./utils/helpers.js";
import type { AgentName, EntryType } from "./types.js";

const DEFAULT_AGENT: AgentName = "build";

/** Maximum number of sessions to track before evicting the oldest. */
const MAX_SESSION_ENTRIES = 100;

/** Track the current agent per session (bounded to prevent memory leaks). */
const sessionAgentMap = new Map<string, AgentName>();

function setSessionAgent(sessionID: string, agent: AgentName): void {
  // Delete first so re-insertion moves the key to the end (Map preserves insertion order)
  sessionAgentMap.delete(sessionID);
  sessionAgentMap.set(sessionID, agent);

  // Evict oldest entries when the map exceeds the cap
  if (sessionAgentMap.size > MAX_SESSION_ENTRIES) {
    const oldest = sessionAgentMap.keys().next().value;
    if (oldest !== undefined) {
      sessionAgentMap.delete(oldest);
    }
  }
}

function getSessionAgent(sessionID?: string): AgentName {
  if (sessionID) {
    return sessionAgentMap.get(sessionID) ?? DEFAULT_AGENT;
  }
  return DEFAULT_AGENT;
}

// ─── Circuit Breaker for Hook CLI Calls ──────────────────────────────────────

/** Number of consecutive hook failures before the breaker opens. */
const BREAKER_THRESHOLD = 5;
/** How long (ms) the breaker stays open before allowing a retry. */
const BREAKER_RESET_MS = 60_000;

let hookFailureCount = 0;
let breakerOpenedAt = 0;

/**
 * Returns true if the circuit breaker is open (hooks should skip CLI calls).
 * After BREAKER_RESET_MS, the breaker half-opens to allow a single retry.
 */
function isBreakerOpen(): boolean {
  if (hookFailureCount < BREAKER_THRESHOLD) return false;
  // Half-open: allow a retry after the reset window
  if (Date.now() - breakerOpenedAt >= BREAKER_RESET_MS) return false;
  return true;
}

function recordHookSuccess(): void {
  hookFailureCount = 0;
  breakerOpenedAt = 0;
}

function recordHookFailure(): void {
  hookFailureCount++;
  if (hookFailureCount >= BREAKER_THRESHOLD) {
    const now = Date.now();
    const shouldOpen =
      breakerOpenedAt === 0 || now - breakerOpenedAt >= BREAKER_RESET_MS;

    if (shouldOpen) {
      breakerOpenedAt = now;
      console.error(
        `[oc-mnemoria] Circuit breaker opened after ${BREAKER_THRESHOLD} consecutive failures. ` +
          `Hooks will skip CLI calls for ${BREAKER_RESET_MS / 1000}s.`
      );
    }
  }
}

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
            .enum([
              "intent",
              "discovery",
              "decision",
              "problem",
              "solution",
              "pattern",
              "warning",
              "success",
              "refactor",
              "bugfix",
              "feature",
            ])
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
          const agentName = (context.agent as AgentName) || DEFAULT_AGENT;
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
            args.limit ?? 10,
            args.agent as AgentName | undefined
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
            args.agent as AgentName | undefined
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
              limit: args.limit ?? 20,
              since: args.since,
              until: args.until,
              reverse: args.reverse ?? true,
            },
            args.agent as AgentName | undefined
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
          const agentName = (context.agent as AgentName) || DEFAULT_AGENT;
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

    "tool.execute.after": async (hookInput, hookOutput) => {
      const toolName = hookInput.tool;
      const toolOutput = hookOutput.output;
      const sessionID = hookInput.sessionID;

      if (
        toolName === "read" ||
        toolName === "bash" ||
        toolName === "edit" ||
        toolName === "write" ||
        toolName === "grep" ||
        toolName === "glob"
      ) {
        if (isBreakerOpen()) return;

        try {
          const agentName = getSessionAgent(sessionID);
          const mind = await getMind();
          const extracted = extractKeyInfo(
            toolName,
            toolOutput,
            hookInput.args
          );
          const obsType = classifyObservationType(toolName, toolOutput);

          // Queue observation for batched writing instead of writing immediately.
          // This reduces CLI invocations during rapid tool use bursts.
          mind.queueObservation({
            type: obsType,
            summary: extracted.summary,
            content: extracted.content,
            agent: agentName,
          });
          recordHookSuccess();
        } catch (err) {
          recordHookFailure();
          console.error("[oc-mnemoria] Failed to remember tool use:", err);
        }
      }
    },

    "chat.message": async (hookInput, hookOutput) => {
      try {
        const sessionID = hookInput.sessionID;
        const agentName =
          (hookInput.agent as AgentName) || DEFAULT_AGENT;

        // Always track the session agent (cheap in-memory operation)
        setSessionAgent(sessionID, agentName);

        if (isBreakerOpen()) return;

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
          messageText.length > 10 &&
          messageText.length < 5000
        ) {
          const intent = extractUserIntent(messageText);
          await mind.setIntent(messageText, intent.goal, agentName);
          recordHookSuccess();

          console.error(
            `[oc-mnemoria] [${agentName}] Set intent: ${intent.goal.slice(0, 50)}`
          );
        }
      } catch (err) {
        recordHookFailure();
        console.error("[oc-mnemoria] Failed to capture intent:", err);
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

        // First get context without a query to find the latest intent
        const initialContext = await mind.getContext();

        // Extract the latest intent text to use as a relevance query
        const intentObs = initialContext.recentObservations.find(
          (obs) => obs.type === "intent"
        );
        const contextQuery = intentObs?.summary.replace(/^Intent:\s*/i, "") ?? undefined;

        // Re-fetch context with the intent query to get relevant memories
        const context = contextQuery
          ? await mind.getContext(contextQuery)
          : initialContext;

        const sections: string[] = [];

        if (context.recentObservations.length > 0) {
          const recentLines = context.recentObservations
            .slice(0, 10)
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

        // Add relevant memories if the query found matches
        if (context.relevantMemories.length > 0) {
          const relevantLines = context.relevantMemories
            .slice(0, 5)
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
            .slice(0, 3)
            .map((obs) => {
              const agentTag = obs.agent ? ` (via ${obs.agent})` : "";
              return `- User goal${agentTag}: ${obs.content.slice(0, 150)}`;
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
