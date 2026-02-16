import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryEntry, MemoryStats } from "../types.js";

// Mock MnemoriaCli — must use a proper constructor function (not arrow fn)
vi.mock("./mnemoria-cli.js", () => {
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
    this.exportAll = vi.fn().mockResolvedValue([]);
    this.verify = vi.fn().mockResolvedValue(true);
    this.rebuild = vi.fn().mockResolvedValue(undefined);
    this.enrichSearchResults = vi.fn().mockImplementation((results: unknown[]) => Promise.resolve(results));
    this.enrichTimelineEntries = vi.fn().mockImplementation((entries: unknown[]) => Promise.resolve(entries));
  }
  MockMnemoriaCli.isAvailable = vi.fn().mockResolvedValue(true);

  return { MnemoriaCli: MockMnemoriaCli };
});

import { Mind, getMind, resetMind } from "./mind.js";

interface CliMock {
  add: ReturnType<typeof vi.fn>;
  exportAll: ReturnType<typeof vi.fn>;
  rebuild: ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMind();
});

// ─── Mind.open ───────────────────────────────────────────────────────────────

describe("Mind.open", () => {
  it("creates a Mind instance", async () => {
    const mind = await Mind.open();
    expect(mind).toBeInstanceOf(Mind);
  });

  it("uses default memoryDir (.opencode)", async () => {
    const mind = await Mind.open();
    expect(mind.getMemoryPath()).toContain(".opencode/mnemoria");
  });

  it("accepts custom config", async () => {
    const mind = await Mind.open({ memoryDir: ".custom" });
    expect(mind.getMemoryPath()).toContain(".custom/mnemoria");
  });
});

// ─── remember ────────────────────────────────────────────────────────────────

describe("remember", () => {
  it("stores an observation and returns an ID", async () => {
    const mind = await Mind.open();
    const id = await mind.remember({
      type: "discovery",
      summary: "Found something",
      content: "Details here",
      agent: "build",
    });
    expect(id).toBe("entry-001");
  });

  it("stores with tool info", async () => {
    const mind = await Mind.open();
    const id = await mind.remember({
      type: "discovery",
      summary: "Read file",
      content: "file contents",
      agent: "build",
      tool: "read",
    });
    expect(id).toBe("entry-001");
  });

  it("stores with metadata", async () => {
    const mind = await Mind.open();
    const id = await mind.remember({
      type: "discovery",
      summary: "test",
      content: "base content",
      agent: "build",
      metadata: {
        filePaths: ["/src/app.ts"],
        findings: ["Found bug"],
        patterns: ["singleton"],
      },
    });
    expect(id).toBe("entry-001");
  });
});

// ─── rememberWithContext ─────────────────────────────────────────────────────

describe("rememberWithContext", () => {
  it("includes chain ID when intent is set", async () => {
    const mind = await Mind.open();
    await mind.setIntent("fix auth", "Fix: fix auth", "build");
    expect(mind.getCurrentChainId("build")).not.toBeNull();
    const id = await mind.rememberWithContext({
      type: "discovery",
      summary: "Found issue",
      content: "details",
      agent: "build",
    });
    expect(id).toBe("entry-001");
  });
});

// ─── setIntent ───────────────────────────────────────────────────────────────

describe("setIntent", () => {
  it("creates a chain ID", async () => {
    const mind = await Mind.open();
    expect(mind.getCurrentChainId("plan")).toBeNull();
    await mind.setIntent("fix bug", "Fix: fix bug", "plan");
    const chainId = mind.getCurrentChainId("plan");
    expect(chainId).toBeTruthy();
    expect(chainId?.length).toBe(16);
  });

  it("resets chain on new intent", async () => {
    const mind = await Mind.open();
    await mind.setIntent("first task", "Implement: first task", "build");
    const chain1 = mind.getCurrentChainId("build");
    await mind.setIntent("second task", "Fix: second task", "build");
    const chain2 = mind.getCurrentChainId("build");
    expect(chain1).not.toBe(chain2);
  });
});

// ─── search ──────────────────────────────────────────────────────────────────

describe("search", () => {
  it("delegates to cli.search", async () => {
    const mind = await Mind.open();
    const results = await mind.search("test query");
    expect(results).toEqual([]);
  });

  it("passes agent filter", async () => {
    const mind = await Mind.open();
    const results = await mind.search("test", 5, "plan");
    expect(results).toEqual([]);
  });
});

// ─── ask ─────────────────────────────────────────────────────────────────────

describe("ask", () => {
  it("returns answer from CLI", async () => {
    const mind = await Mind.open();
    const answer = await mind.ask("What happened?");
    expect(answer).toBe("test answer");
  });
});

// ─── timeline ────────────────────────────────────────────────────────────────

describe("timeline", () => {
  it("returns empty array when no entries", async () => {
    const mind = await Mind.open();
    const observations = await mind.timeline({ limit: 10, reverse: false });
    expect(observations).toEqual([]);
  });
});

// ─── stats ───────────────────────────────────────────────────────────────────

describe("stats", () => {
  it("returns stats from CLI", async () => {
    const mind = await Mind.open();
    const stats = await mind.stats();
    expect(stats.total_entries).toBe(5);
    expect(stats.file_size_bytes).toBe(1024);
  });
});

// ─── forget / compact ───────────────────────────────────────────────────────

describe("forget", () => {
  it("forgets by id and records an ID-based marker", async () => {
    const mind = await Mind.open();
    const cli = (mind as unknown as { cli: CliMock }).cli;

    const entries: MemoryEntry[] = [
      {
        id: "entry-123",
        agent_name: "build",
        entry_type: "discovery",
        summary: "Found flaky test",
        content: "details",
        timestamp: 1700000000000,
        checksum: 0,
        prev_checksum: 0,
      },
    ];
    cli.exportAll.mockResolvedValue(entries);
    cli.add.mockResolvedValue("marker-001");

    const result = await mind.forget(
      { id: "entry-123" },
      "obsolete",
      "build"
    );

    expect(result).toEqual({
      markerId: "marker-001",
      forgottenId: "entry-123",
      forgottenSummary: "Found flaky test",
    });
    expect(cli.add).toHaveBeenCalledWith(
      "warning",
      "[FORGOTTEN] entry-123",
      expect.stringContaining("Original id: entry-123"),
      "build"
    );
  });

  it("rejects ambiguous summary matches", async () => {
    const mind = await Mind.open();
    const cli = (mind as unknown as { cli: CliMock }).cli;

    const entries: MemoryEntry[] = [
      {
        id: "entry-a",
        agent_name: "build",
        entry_type: "discovery",
        summary: "duplicate summary",
        content: "a",
        timestamp: 1,
        checksum: 0,
        prev_checksum: 0,
      },
      {
        id: "entry-b",
        agent_name: "plan",
        entry_type: "discovery",
        summary: "duplicate summary",
        content: "b",
        timestamp: 2,
        checksum: 0,
        prev_checksum: 0,
      },
    ];
    cli.exportAll.mockResolvedValue(entries);

    await expect(
      mind.forget({ summary: "duplicate summary" }, "obsolete", "build")
    ).rejects.toThrow("Summary is ambiguous");
  });
});

describe("compact", () => {
  it("removes forgotten entries by ID and keeps unrelated entries", async () => {
    const mind = await Mind.open();
    const cli = (mind as unknown as { cli: CliMock }).cli;

    const entries: MemoryEntry[] = [
      {
        id: "entry-1",
        agent_name: "build",
        entry_type: "discovery",
        summary: "to remove",
        content: "x",
        timestamp: 100,
        checksum: 0,
        prev_checksum: 0,
      },
      {
        id: "entry-2",
        agent_name: "build",
        entry_type: "discovery",
        summary: "to keep",
        content: "y",
        timestamp: 101,
        checksum: 0,
        prev_checksum: 0,
      },
      {
        id: "marker-1",
        agent_name: "build",
        entry_type: "warning",
        summary: "[FORGOTTEN] entry-1",
        content: "Reason: stale\nOriginal id: entry-1\nOriginal summary: to remove",
        timestamp: 102,
        checksum: 0,
        prev_checksum: 0,
      },
    ];
    cli.exportAll.mockResolvedValue(entries);

    const result = await mind.compact();

    expect(result).toEqual({ kept: 1, removed: 2 });
    expect(cli.rebuild).toHaveBeenCalledTimes(1);
    expect(cli.rebuild).toHaveBeenCalledWith([
      expect.objectContaining({ id: "entry-2", summary: "to keep" }),
    ]);
  });

  it("supports legacy summary-only forgotten markers", async () => {
    const mind = await Mind.open();
    const cli = (mind as unknown as { cli: CliMock }).cli;

    const entries: MemoryEntry[] = [
      {
        id: "entry-legacy-target",
        agent_name: "build",
        entry_type: "discovery",
        summary: "legacy target",
        content: "old",
        timestamp: 200,
        checksum: 0,
        prev_checksum: 0,
      },
      {
        id: "entry-legacy-keep",
        agent_name: "build",
        entry_type: "discovery",
        summary: "legacy keep",
        content: "new",
        timestamp: 201,
        checksum: 0,
        prev_checksum: 0,
      },
      {
        id: "marker-legacy",
        agent_name: "build",
        entry_type: "warning",
        summary: "[FORGOTTEN] legacy target",
        content: "Reason: old flow\nOriginal summary: legacy target",
        timestamp: 202,
        checksum: 0,
        prev_checksum: 0,
      },
    ];
    cli.exportAll.mockResolvedValue(entries);

    const result = await mind.compact();

    expect(result).toEqual({ kept: 1, removed: 2 });
    expect(cli.rebuild).toHaveBeenCalledWith([
      expect.objectContaining({ id: "entry-legacy-keep", summary: "legacy keep" }),
    ]);
  });
});

// ─── getContext ───────────────────────────────────────────────────────────────

describe("getContext", () => {
  it("returns recent observations and relevant memories", async () => {
    const mind = await Mind.open();
    const context = await mind.getContext("test query");
    expect(context).toHaveProperty("recentObservations");
    expect(context).toHaveProperty("relevantMemories");
    expect(context).toHaveProperty("tokenCount");
    expect(context.tokenCount).toBeGreaterThanOrEqual(0);
  });

  it("works without query", async () => {
    const mind = await Mind.open();
    const context = await mind.getContext();
    expect(context.relevantMemories).toEqual([]);
  });
});

// ─── getMind singleton ───────────────────────────────────────────────────────

describe("getMind", () => {
  it("returns the same instance on repeated calls", async () => {
    const mind1 = await getMind();
    const mind2 = await getMind();
    expect(mind1).toBe(mind2);
  });

  it("creates new instance after resetMind", async () => {
    const mind1 = await getMind();
    resetMind();
    const mind2 = await getMind();
    expect(mind1).not.toBe(mind2);
  });
});
