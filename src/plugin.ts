/**
 * oc-mnemoria — OpenCode Plugin
 *
 * Persistent per-agent memory powered by the mnemoria Rust engine.
 * Each agent type (plan, build, ask, review) gets its own isolated
 * memory store so context doesn't bleed between agent roles.
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
  // Check that the mnemoria binary is available
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
          "Store important information in memory for future sessions. " +
          "Each agent has its own memory store.",
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
          agent: tool.schema
            .string()
            .optional()
            .describe(
              "Agent to store memory for (plan, build, ask, review). Defaults to current agent."
            ),
        },
        async execute(args) {
          const agentName = (args.agent as AgentName) || DEFAULT_AGENT;
          const mind = await getMind(agentName);
          const id = await mind.remember({
            type: args.type as EntryType,
            summary: args.summary,
            content: args.content,
          });
          return `Stored in ${agentName} memory: ${args.summary} (id: ${id})`;
        },
      }),

      search_memory: tool({
        description:
          "Search past memories using keyword or semantic search. " +
          "Searches the current agent's memory by default. " +
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
              "Agent memory to search (plan, build, ask, review). Defaults to current agent."
            ),
        },
        async execute(args) {
          if (args.query.includes("*")) {
            return "Error: Wildcard characters like * are not supported. Please search for a specific topic or keyword instead.";
          }

          const agentName = (args.agent as AgentName) || DEFAULT_AGENT;
          const mind = await getMind(agentName);
          const results = await mind.search(args.query, args.limit ?? 10);

          if (results.length === 0) {
            return `No memories found in ${agentName} memory matching that query.`;
          }

          const output = results
            .map(
              (r, i) =>
                `${i + 1}. [${r.entry.entry_type}] ${r.entry.summary}\n   Score: ${r.score.toFixed(2)}`
            )
            .join("\n\n");

          return `Found ${results.length} memories in ${agentName} memory:\n\n${output}`;
        },
      }),

      ask_memory: tool({
        description:
          "Ask a question about past sessions and get an answer from memory",
        args: {
          question: tool.schema
            .string()
            .describe("Question to ask about past interactions"),
          agent: tool.schema
            .string()
            .optional()
            .describe(
              "Agent memory to query (plan, build, ask, review). Defaults to current agent."
            ),
        },
        async execute(args) {
          const agentName = (args.agent as AgentName) || DEFAULT_AGENT;
          const mind = await getMind(agentName);
          const answer = await mind.ask(args.question);
          return `[${agentName} memory] ${answer}`;
        },
      }),

      memory_stats: tool({
        description:
          "Get statistics about memory stores. Shows stats for all agents or a specific one.",
        args: {
          agent: tool.schema
            .string()
            .optional()
            .describe(
              "Agent memory to get stats for. If omitted, shows all agents."
            ),
        },
        async execute(args) {
          const agents: AgentName[] = args.agent
            ? [args.agent as AgentName]
            : ["plan", "build", "ask", "review"];

          const sections: string[] = [];

          for (const agentName of agents) {
            try {
              const mind = await getMind(agentName);
              const stats = await mind.stats();

              sections.push(
                `## ${agentName} agent\n` +
                  `- Total entries: ${stats.total_entries}\n` +
                  `- File size: ${(stats.file_size_bytes / 1024).toFixed(1)} KB\n` +
                  `- Oldest: ${stats.oldest_timestamp ? new Date(stats.oldest_timestamp).toISOString() : "N/A"}\n` +
                  `- Newest: ${stats.newest_timestamp ? new Date(stats.newest_timestamp).toISOString() : "N/A"}`
              );
            } catch {
              sections.push(`## ${agentName} agent\n- No memory store found`);
            }
          }

          return `Memory Statistics:\n\n${sections.join("\n\n")}`;
        },
      }),

      timeline: tool({
        description:
          "Get memories in chronological order for a specific agent",
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
              "Agent memory to view (plan, build, ask, review). Defaults to current agent."
            ),
        },
        async execute(args) {
          const agentName = (args.agent as AgentName) || DEFAULT_AGENT;
          const mind = await getMind(agentName);
          const observations = await mind.timeline({
            limit: args.limit ?? 20,
            since: args.since,
            until: args.until,
            reverse: args.reverse ?? true,
          });

          if (observations.length === 0) {
            return `No memories found in ${agentName} timeline.`;
          }

          const output = observations
            .map((obs, i) => {
              const date =
                obs.timestamp > 0
                  ? new Date(obs.timestamp).toISOString()
                  : "unknown";
              return `${i + 1}. [${obs.type}] ${obs.summary}\n   Date: ${date}`;
            })
            .join("\n\n");

          return `Timeline for ${agentName} (${observations.length} memories):\n\n${output}`;
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
          const mind = await getMind(agentName);
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

        // Track which agent is active for this session
        sessionAgentMap.set(sessionID, agentName);

        const message = hookOutput.message;
        const mind = await getMind(agentName);

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
          await mind.setIntent(messageText, intent.goal);

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
        // We don't know the agent from this hook's input, so we inject
        // guidance and context for the default agent. The tools themselves
        // allow the LLM to query any agent's memory.
        const mind = await getMind(DEFAULT_AGENT);

        hookOutput.system.push(
          "",
          "## Memory Guidance",
          "You have access to persistent per-agent memory tools. Each agent (plan, build, ask, review) has its own isolated memory store.",
          "",
          "Before responding to the user:",
          "1. Consider if past sessions contain relevant context — use 'search_memory' to find related memories",
          "2. Use 'ask_memory' to answer questions about previous work or decisions",
          "3. You can query any agent's memory by passing the 'agent' parameter",
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
              let line = `- [${obs.type}] ${obs.summary}`;
              if (obs.agent) {
                line += ` (agent: ${obs.agent})`;
              }
              return line;
            });

          sections.push(
            "## Recent Context (from memory)",
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
            .map(
              (obs) => `- User goal: ${obs.content.slice(0, 150)}`
            );
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
