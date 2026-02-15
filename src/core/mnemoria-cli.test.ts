import { describe, it, expect, vi, beforeEach } from "vitest";
import { promisify } from "node:util";

/**
 * The source code does: `const execFileAsync = promisify(execFile);`
 * at module load time. We need to provide an execFile mock that, when
 * promisified, returns our controllable async function.
 *
 * `vi.hoisted()` runs before `vi.mock()` factories, so we can define
 * our shared mock there and reference it inside the factory.
 */
const { mockExecFileAsync, mockedExistsSync, mockedReadFileSync } = vi.hoisted(() => {
  return {
    mockExecFileAsync: vi.fn<
      (...args: unknown[]) => Promise<{ stdout: string; stderr: string }>
    >(),
    mockedExistsSync: vi.fn<(path: string) => boolean>(),
    mockedReadFileSync: vi.fn<(...args: unknown[]) => string>(),
  };
});

vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  // Set the custom promisify symbol so `promisify(execFile)` returns our mock
  const customSymbol = promisify.custom as symbol;
  (execFile as unknown as Record<symbol, unknown>)[customSymbol] =
    mockExecFileAsync;
  return { execFile };
});

vi.mock("node:fs", () => ({
  existsSync: mockedExistsSync,
  readFileSync: mockedReadFileSync,
  unlinkSync: vi.fn(),
}));

import { MnemoriaCli } from "./mnemoria-cli.js";

/**
 * Helper: make the promisified execFile resolve with given stdout.
 */
function mockExecResult(stdout: string, stderr = "") {
  mockExecFileAsync.mockResolvedValue({ stdout, stderr });
}

/**
 * Helper: make the promisified execFile reject.
 */
function mockExecError(message: string, stderr = "") {
  mockExecFileAsync.mockRejectedValue(
    Object.assign(new Error(message), { stderr })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedExistsSync.mockReturnValue(true);
});

// ─── Constructor / storePath ─────────────────────────────────────────────────

describe("MnemoriaCli", () => {
  it("computes storePath as basePath/mnemoria", () => {
    const cli = new MnemoriaCli("/project/.opencode");
    expect(cli.storePath).toBe("/project/.opencode/mnemoria");
  });

  // ─── isAvailable ─────────────────────────────────────────────────────────

  describe("isAvailable", () => {
    it("returns true when binary responds", async () => {
      mockExecResult("mnemoria 0.3.1");
      expect(await MnemoriaCli.isAvailable()).toBe(true);
    });

    it("returns false when binary is missing", async () => {
      mockExecError("ENOENT");
      expect(await MnemoriaCli.isAvailable()).toBe(false);
    });
  });

  // ─── isInitialized ──────────────────────────────────────────────────────

  describe("isInitialized", () => {
    it("returns true when manifest exists", () => {
      mockedExistsSync.mockReturnValue(true);
      const cli = new MnemoriaCli("/proj");
      expect(cli.isInitialized()).toBe(true);
    });

    it("returns false when manifest is missing", () => {
      mockedExistsSync.mockReturnValue(false);
      const cli = new MnemoriaCli("/proj");
      expect(cli.isInitialized()).toBe(false);
    });
  });

  // ─── init ────────────────────────────────────────────────────────────────

  describe("init", () => {
    it("skips init when already initialized", async () => {
      mockedExistsSync.mockReturnValue(true);
      const cli = new MnemoriaCli("/proj");
      await cli.init();
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it("calls mnemoria init when not initialized", async () => {
      mockedExistsSync.mockReturnValue(false);
      mockExecResult("Initialized store");
      const cli = new MnemoriaCli("/proj");
      await cli.init();
      expect(mockExecFileAsync).toHaveBeenCalled();
      const callArgs = mockExecFileAsync.mock.calls[0];
      expect(callArgs[0]).toBe("mnemoria");
      expect(callArgs[1]).toEqual(["--path", "/proj", "init"]);
    });
  });

  // ─── add ─────────────────────────────────────────────────────────────────

  describe("add", () => {
    it("calls mnemoria add with correct args and returns entry id", async () => {
      mockExecResult("Added entry: abc-123-def");
      const cli = new MnemoriaCli("/proj");
      const id = await cli.add(
        "discovery",
        "Found pattern",
        "Details...",
        "build"
      );
      expect(id).toBe("abc-123-def");
      const addCall = mockExecFileAsync.mock.calls[0];
      expect(addCall[1]).toEqual([
        "--path",
        "/proj",
        "add",
        "-a",
        "build",
        "-t",
        "discovery",
        "-s",
        "Found pattern",
        "Details...",
      ]);
    });

    it("returns raw output when format doesn't match", async () => {
      mockExecResult("unexpected output");
      const cli = new MnemoriaCli("/proj");
      const id = await cli.add("intent", "Test", "Content", "plan");
      expect(id).toBe("unexpected output");
    });
  });

  // ─── search ──────────────────────────────────────────────────────────────

  describe("search", () => {
    it("parses v0.3.1 search output", async () => {
      const output = [
        "Found 2 results:",
        "1. [discovery] (build) Found async pattern (score: 0.288)",
        "2. [problem] (review) Missing error handling (score: 0.150)",
      ].join("\n");
      mockExecResult(output);

      const cli = new MnemoriaCli("/proj");
      const results = await cli.search("async");

      expect(results).toHaveLength(2);
      expect(results[0].entry.entry_type).toBe("discovery");
      expect(results[0].entry.agent_name).toBe("build");
      expect(results[0].entry.summary).toBe("Found async pattern");
      expect(results[0].score).toBeCloseTo(0.288);
      expect(results[1].entry.entry_type).toBe("problem");
      expect(results[1].entry.agent_name).toBe("review");
    });

    it("returns empty array for no results", async () => {
      mockExecResult("Found 0 results:");
      const cli = new MnemoriaCli("/proj");
      const results = await cli.search("nothing");
      expect(results).toEqual([]);
    });

    it("passes agent filter arg", async () => {
      mockExecResult("Found 0 results:");
      const cli = new MnemoriaCli("/proj");
      await cli.search("test", 5, "plan");
      const callArgs = mockExecFileAsync.mock.calls[0];
      const args = callArgs[1] as string[];
      expect(args).toContain("-a");
      expect(args).toContain("plan");
    });

    it("parses summaries containing punctuation and scientific scores", async () => {
      const output = [
        "Found 1 results:",
        "1. [discovery] (build) Investigated parser v2.1 - edge case: score token (score: 1.23e-1)",
      ].join("\n");
      mockExecResult(output);

      const cli = new MnemoriaCli("/proj");
      const results = await cli.search("parser");

      expect(results).toHaveLength(1);
      expect(results[0].entry.summary).toBe(
        "Investigated parser v2.1 - edge case: score token"
      );
      expect(results[0].score).toBeCloseTo(0.123);
    });
  });

  // ─── ask ─────────────────────────────────────────────────────────────────

  describe("ask", () => {
    it("returns the answer text", async () => {
      mockExecResult("The project uses TypeScript with strict mode.");
      const cli = new MnemoriaCli("/proj");
      const answer = await cli.ask("What language does the project use?");
      expect(answer).toBe("The project uses TypeScript with strict mode.");
    });

    it("passes agent filter", async () => {
      mockExecResult("answer");
      const cli = new MnemoriaCli("/proj");
      await cli.ask("question", "build");
      const callArgs = mockExecFileAsync.mock.calls[0];
      const args = callArgs[1] as string[];
      expect(args).toContain("-a");
      expect(args).toContain("build");
    });
  });

  // ─── stats ───────────────────────────────────────────────────────────────

  describe("stats", () => {
    it("parses stats output", async () => {
      const output = [
        "Memory Statistics:",
        "  Total entries: 42",
        "  File size: 4096 bytes",
        "  Oldest entry: 1700000000000",
        "  Newest entry: 1700001000000",
      ].join("\n");
      mockExecResult(output);

      const cli = new MnemoriaCli("/proj");
      const stats = await cli.stats();

      expect(stats.total_entries).toBe(42);
      expect(stats.file_size_bytes).toBe(4096);
      expect(stats.oldest_timestamp).toBe(1700000000000);
      expect(stats.newest_timestamp).toBe(1700001000000);
    });

    it("returns zeros for unparseable output", async () => {
      mockExecResult("something unexpected");
      const cli = new MnemoriaCli("/proj");
      const stats = await cli.stats();
      expect(stats.total_entries).toBe(0);
      expect(stats.file_size_bytes).toBe(0);
      expect(stats.oldest_timestamp).toBeNull();
      expect(stats.newest_timestamp).toBeNull();
    });
  });

  // ─── timeline ────────────────────────────────────────────────────────────

  describe("timeline", () => {
    it("parses v0.3.1 timeline output", async () => {
      const output = [
        "Timeline (2 entries):",
        "1. [intent] (plan) Fix auth flow - 1700000000000",
        "2. [discovery] (build) Found login endpoint - 1700000100000",
      ].join("\n");
      mockExecResult(output);

      const cli = new MnemoriaCli("/proj");
      const entries = await cli.timeline();

      expect(entries).toHaveLength(2);
      expect(entries[0].entry_type).toBe("intent");
      expect(entries[0].agent_name).toBe("plan");
      expect(entries[0].summary).toBe("Fix auth flow");
      expect(entries[0].timestamp).toBe(1700000000000);
    });

    it("returns empty array for no entries", async () => {
      mockExecResult("Timeline (0 entries):");
      const cli = new MnemoriaCli("/proj");
      const entries = await cli.timeline();
      expect(entries).toEqual([]);
    });

    it("passes options and agent filter", async () => {
      mockExecResult("Timeline (0 entries):");
      const cli = new MnemoriaCli("/proj");
      await cli.timeline(
        { limit: 5, reverse: true, since: 100, until: 200 },
        "review"
      );
      const callArgs = mockExecFileAsync.mock.calls[0];
      const args = callArgs[1] as string[];
      expect(args).toContain("-l");
      expect(args).toContain("5");
      expect(args).toContain("-r");
      expect(args).toContain("-s");
      expect(args).toContain("100");
      expect(args).toContain("-u");
      expect(args).toContain("200");
      expect(args).toContain("-a");
      expect(args).toContain("review");
    });

    it("parses summaries that contain hyphens", async () => {
      const output = [
        "Timeline (1 entries):",
        "1. [decision] (plan) Use append-only log - keeps audit trail - 1700000200000",
      ].join("\n");
      mockExecResult(output);

      const cli = new MnemoriaCli("/proj");
      const entries = await cli.timeline();

      expect(entries).toHaveLength(1);
      expect(entries[0].summary).toBe(
        "Use append-only log - keeps audit trail"
      );
      expect(entries[0].timestamp).toBe(1700000200000);
    });
  });

  // ─── exportAll ───────────────────────────────────────────────────────────

  describe("exportAll", () => {
    it("exports entries via temp file", async () => {
      const entries = [
        {
          id: "1",
          agent_name: "build",
          entry_type: "discovery",
          summary: "test",
          content: "content",
          timestamp: 123,
          checksum: 0,
          prev_checksum: 0,
        },
      ];
      mockExecResult("Exported to /tmp/test.json");
      mockedReadFileSync.mockReturnValue(JSON.stringify(entries));

      const cli = new MnemoriaCli("/proj");
      const result = await cli.exportAll();

      expect(result).toHaveLength(1);
      expect(result[0].agent_name).toBe("build");
    });
  });

  // ─── verify ──────────────────────────────────────────────────────────────

  describe("verify", () => {
    it("returns true when verification passed", async () => {
      mockExecResult("Verification passed: 5 entries checked");
      const cli = new MnemoriaCli("/proj");
      expect(await cli.verify()).toBe(true);
    });

    it("returns false when verification fails", async () => {
      mockExecResult("Verification failed: checksum mismatch");
      const cli = new MnemoriaCli("/proj");
      expect(await cli.verify()).toBe(false);
    });
  });

  // ─── error handling ──────────────────────────────────────────────────────

  describe("error handling", () => {
    it("wraps CLI errors with stderr message", async () => {
      mockedExistsSync.mockReturnValue(false);
      mockExecError("process failed", "some stderr output");
      const cli = new MnemoriaCli("/proj");
      await expect(cli.init()).rejects.toThrow(
        "mnemoria CLI error: some stderr output"
      );
    });

    it("falls back to error message when no stderr", async () => {
      mockedExistsSync.mockReturnValue(false);
      mockExecError("command not found");
      const cli = new MnemoriaCli("/proj");
      await expect(cli.init()).rejects.toThrow(
        "mnemoria CLI error: command not found"
      );
    });
  });
});
