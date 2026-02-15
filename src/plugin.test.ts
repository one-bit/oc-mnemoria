import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import type { MemoryStats } from "./types.js";

// Mock @opencode-ai/plugin since its dist/tool import is broken in test env
vi.mock("@opencode-ai/plugin", () => {
  // Minimal mock of the `tool` helper that just passes through
  const schema = {
    string: () => ({
      describe: () => ({}),
      optional: () => ({ describe: () => ({}) }),
    }),
    number: () => ({
      describe: () => ({}),
      optional: () => ({ describe: () => ({}) }),
    }),
    boolean: () => ({
      describe: () => ({}),
      optional: () => ({ describe: () => ({}) }),
    }),
    enum: () => ({
      describe: () => ({}),
    }),
  };

  function tool(config: {
    description: string;
    args: unknown;
    execute: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<string>;
  }) {
    return {
      description: config.description,
      args: config.args,
      execute: config.execute,
    };
  }
  tool.schema = schema;

  return { tool };
});

// Mock MnemoriaCli — must be a proper constructor
vi.mock("./core/mnemoria-cli.js", () => {
  function MockMnemoriaCli(this: Record<string, unknown>, basePath: string) {
    this.basePath = basePath;
    this.storePath = `${basePath}/mnemoria`;
    this.isInitialized = vi.fn().mockReturnValue(true);
    this.init = vi.fn().mockResolvedValue(undefined);
    this.ensureReady = vi.fn().mockImplementation(() => Promise.resolve(this));
    this.add = vi.fn().mockResolvedValue("entry-001");
    this.search = vi.fn().mockResolvedValue([]);
    this.ask = vi.fn().mockResolvedValue("test answer");
    this.stats = vi.fn().mockResolvedValue({
      total_entries: 5,
      file_size_bytes: 1024,
      oldest_timestamp: 1700000000000,
      newest_timestamp: 1700001000000,
    } satisfies MemoryStats);
    this.timeline = vi.fn().mockResolvedValue([]);
    this.exportAll = vi.fn().mockResolvedValue([
      {
        id: "entry-123",
        agent_name: "build",
        entry_type: "discovery",
        summary: "Known memory",
        content: "details",
        timestamp: 1700000000000,
        checksum: 0,
        prev_checksum: 0,
      },
    ]);
    this.verify = vi.fn().mockResolvedValue(true);
    this.rebuild = vi.fn().mockResolvedValue(undefined);
    this.enrichSearchResults = vi.fn().mockImplementation((results: unknown[]) => Promise.resolve(results));
    this.enrichTimelineEntries = vi.fn().mockImplementation((entries: unknown[]) => Promise.resolve(entries));
  }
  MockMnemoriaCli.isAvailable = vi.fn().mockResolvedValue(true);

  return { MnemoriaCli: MockMnemoriaCli };
});

import OcMnemoria from "./plugin.js";
import { resetMind } from "./core/mind.js";

/** Create a mock ToolContext */
function mockContext(agent = "build"): ToolContext {
  return {
    sessionID: "test-session",
    messageID: "test-message",
    agent,
    directory: "/project",
    worktree: "/project",
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn().mockResolvedValue(undefined),
  } as unknown as ToolContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMind();
});

// ─── Plugin initialization ───────────────────────────────────────────────────

describe("OcMnemoria plugin", () => {
  it("initializes and returns tools and hooks", async () => {
    const result = await OcMnemoria({} as never);
    expect(result).toBeDefined();
    expect(result.tool).toBeDefined();
    const tools = result.tool ?? {};
    expect(tools.remember).toBeDefined();
    expect(tools.search_memory).toBeDefined();
    expect(tools.ask_memory).toBeDefined();
    expect(tools.memory_stats).toBeDefined();
    expect(tools.timeline).toBeDefined();
    expect(tools.forget).toBeDefined();
  });

  it("returns hook handlers", async () => {
    const result = await OcMnemoria({} as never);
    expect(result["tool.execute.after"]).toBeTypeOf("function");
    expect(result["chat.message"]).toBeTypeOf("function");
    expect(result["experimental.chat.system.transform"]).toBeTypeOf("function");
  });
});

// ─── Tools ───────────────────────────────────────────────────────────────────

describe("remember tool", () => {
  it("stores a memory and returns confirmation with context agent", async () => {
    const result = await OcMnemoria({} as never);
    const tools = result.tool ?? {};
    const output = await tools.remember.execute(
      {
        type: "discovery",
        summary: "Found something important",
        content: "Detailed information about the finding",
      },
      mockContext("build")
    );
    expect(output).toContain("Stored in memory (build)");
    expect(output).toContain("Found something important");
    expect(output).toContain("entry-001");
  });

  it("uses the agent from context", async () => {
    const result = await OcMnemoria({} as never);
    const tools = result.tool ?? {};
    const output = await tools.remember.execute(
      {
        type: "decision",
        summary: "Chose REST over GraphQL",
        content: "REST is simpler for this use case",
      },
      mockContext("plan")
    );
    expect(output).toContain("Stored in memory (plan)");
  });

  it("defaults to build when context has no agent", async () => {
    const result = await OcMnemoria({} as never);
    const tools = result.tool ?? {};
    const output = await tools.remember.execute(
      {
        type: "discovery",
        summary: "test",
        content: "test content",
      },
      mockContext("")
    );
    expect(output).toContain("Stored in memory (build)");
  });
});

describe("search_memory tool", () => {
  it("returns message when no results found", async () => {
    const result = await OcMnemoria({} as never);
    const tools = result.tool ?? {};
    const output = await tools.search_memory.execute(
      { query: "nonexistent topic" },
      mockContext()
    );
    expect(output).toContain("No memories found");
  });

  it("rejects wildcard queries", async () => {
    const result = await OcMnemoria({} as never);
    const tools = result.tool ?? {};
    const output = await tools.search_memory.execute({ query: "*" }, mockContext());
    expect(output).toContain("Wildcard");
    expect(output).toContain("not supported");
  });
});

describe("ask_memory tool", () => {
  it("returns an answer", async () => {
    const result = await OcMnemoria({} as never);
    const tools = result.tool ?? {};
    const output = await tools.ask_memory.execute(
      { question: "What did we work on?" },
      mockContext()
    );
    expect(output).toBe("test answer");
  });
});

describe("memory_stats tool", () => {
  it("returns formatted statistics", async () => {
    const result = await OcMnemoria({} as never);
    const tools = result.tool ?? {};
    const output = await tools.memory_stats.execute({}, mockContext());
    expect(output).toContain("Memory Statistics");
    expect(output).toContain("Total entries: 5");
    expect(output).toContain("KB");
  });
});

describe("timeline tool", () => {
  it("returns message when no memories exist", async () => {
    const result = await OcMnemoria({} as never);
    const tools = result.tool ?? {};
    const output = await tools.timeline.execute({}, mockContext());
    expect(output).toContain("No memories found");
  });
});

describe("forget tool", () => {
  it("returns a validation error when id and summary are missing", async () => {
    const result = await OcMnemoria({} as never);
    const tools = result.tool ?? {};
    const output = await tools.forget.execute(
      { reason: "outdated" },
      mockContext()
    );
    expect(output).toContain("Provide either 'id' (recommended) or 'summary'");
  });

  it("forgets a memory by id", async () => {
    const result = await OcMnemoria({} as never);
    const tools = result.tool ?? {};
    const output = await tools.forget.execute(
      { id: "entry-123", reason: "outdated" },
      mockContext("build")
    );
    expect(output).toContain("Marked as forgotten (build)");
    expect(output).toContain("Known memory");
    expect(output).toContain("id: entry-123");
    expect(output).toContain("marker id: entry-001");
  });
});

// ─── Hooks ───────────────────────────────────────────────────────────────────

describe("tool.execute.after hook", () => {
  it("auto-captures read tool execution", async () => {
    const result = await OcMnemoria({} as never);
    const hook = result["tool.execute.after"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>
    ) => Promise<void>;

    await hook(
      {
        tool: "read",
        args: { path: "/src/app.ts" },
        sessionID: "session-1",
        callID: "call-1",
      },
      { output: "function hello() { return 1; }" }
    );
  });

  it("ignores non-tracked tools", async () => {
    const result = await OcMnemoria({} as never);
    const hook = result["tool.execute.after"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>
    ) => Promise<void>;

    await hook(
      { tool: "custom_tool", args: {}, sessionID: "s1", callID: "c1" },
      { output: "some output" }
    );
  });
});

describe("chat.message hook", () => {
  it("captures user intent from string message", async () => {
    const result = await OcMnemoria({} as never);
    const hook = result["chat.message"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>
    ) => Promise<void>;

    await hook(
      { sessionID: "session-1", agent: "plan" },
      { message: "Fix the authentication flow in the login module" }
    );
  });

  it("handles object message with text property", async () => {
    const result = await OcMnemoria({} as never);
    const hook = result["chat.message"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>
    ) => Promise<void>;

    await hook(
      { sessionID: "session-2", agent: "build" },
      { message: { text: "Refactor the user profiles module for clarity" } }
    );
  });

  it("skips very short messages", async () => {
    const result = await OcMnemoria({} as never);
    const hook = result["chat.message"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>
    ) => Promise<void>;

    await hook(
      { sessionID: "session-3", agent: "ask" },
      { message: "hi" }
    );
  });
});

describe("experimental.chat.system.transform hook", () => {
  it("appends memory guidance to system prompt", async () => {
    const result = await OcMnemoria({} as never);
    const hook = result["experimental.chat.system.transform"] as (
      input: Record<string, unknown>,
      output: { system: string[] }
    ) => Promise<void>;

    const hookOutput = { system: ["Existing system prompt"] };
    await hook({}, hookOutput);

    expect(hookOutput.system.length).toBeGreaterThan(1);
    const joined = hookOutput.system.join("\n");
    expect(joined).toContain("Memory Guidance");
    expect(joined).toContain("shared memory");
  });
});
