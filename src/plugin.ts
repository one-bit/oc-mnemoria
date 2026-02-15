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

/** Track the current agent per session. */
const sessionAgentMap = new Map<string, AgentName>();

function getSessionAgent(sessionID?: string): AgentName {
  if (sessionID) {
    return sessionAgentMap.get(sessionID) ?? DEFAULT_AGENT;
  }
  return DEFAULT_AGENT;
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
        async execute(args) {
          const mind = await getMind();
          const id = await mind.remember({
            type: args.type as EntryType,
            summary: args.summary,
            content: args.content,
            agent: DEFAULT_AGENT,
          });
          return `Stored in memory: ${args.summary} (id: ${id})`;
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
        try {
          const agentName = getSessionAgent(sessionID);
          const mind = await getMind();
          const extracted = extractKeyInfo(
            toolName,
            toolOutput,
            hookInput.args
          );
          const obsType = classifyObservationType(toolName, toolOutput);

          await mind.rememberWithContext({
            type: obsType,
            summary: extracted.summary,
            content: extracted.content,
            agent: agentName,
            tool: toolName,
            metadata: {
              callId: hookInput.callID,
              filePaths: extracted.filePaths,
              findings: extracted.findings,
              patterns: extracted.patterns,
            },
          });
        } catch (err) {
          console.error("[oc-mnemoria] Failed to remember tool use:", err);
        }
      }
    },

    "chat.message": async (hookInput, hookOutput) => {
      try {
        const sessionID = hookInput.sessionID;
        const agentName =
          (hookInput.agent as AgentName) || DEFAULT_AGENT;

        sessionAgentMap.set(sessionID, agentName);

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

          console.error(
            `[oc-mnemoria] [${agentName}] Set intent: ${intent.goal.slice(0, 50)}`
          );
        }
      } catch (err) {
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

        const context = await mind.getContext();

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
