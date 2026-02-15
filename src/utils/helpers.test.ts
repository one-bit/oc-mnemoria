import { describe, it, expect } from "vitest";
import {
  generateId,
  estimateTokens,
  truncateToTokens,
  extractKeyInfo,
  classifyObservationType,
  extractUserIntent,
} from "./helpers.js";

// ─── generateId ──────────────────────────────────────────────────────────────

describe("generateId", () => {
  it("returns a 16-character hex string", () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

// ─── estimateTokens ──────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates dense text at ~4.5 chars per token", () => {
    // No whitespace = dense text
    const dense = "abcdefghijklmnopqrstuvwxyz"; // 26 chars, 0% whitespace
    const tokens = estimateTokens(dense);
    expect(tokens).toBe(Math.ceil(26 / 4.5)); // 6
  });

  it("estimates code-like text at ~3.5 chars per token", () => {
    // Lots of whitespace = code-like
    const code = "  const x = 1;\n  const y = 2;\n  return x + y;\n";
    const tokens = estimateTokens(code);
    const whitespace = (code.match(/\s/g) ?? []).length;
    expect(whitespace / code.length).toBeGreaterThan(0.3);
    expect(tokens).toBe(Math.ceil(code.length / 3.5));
  });

  it("estimates mixed text at ~4 chars per token", () => {
    // Moderate whitespace = mixed
    const mixed = "This is a normal sentence with some words.";
    const tokens = estimateTokens(mixed);
    expect(tokens).toBe(Math.ceil(mixed.length / 4));
  });

  it("always returns at least 1 for non-empty strings", () => {
    expect(estimateTokens("a")).toBeGreaterThanOrEqual(1);
  });
});

// ─── truncateToTokens ────────────────────────────────────────────────────────

describe("truncateToTokens", () => {
  it("returns text unchanged when within budget", () => {
    const text = "short text";
    expect(truncateToTokens(text, 100)).toBe(text);
  });

  it("truncates text exceeding the token budget", () => {
    const text = "a".repeat(100);
    const result = truncateToTokens(text, 10); // 10 tokens * 3.5 = 35 chars
    expect(result).toBe("a".repeat(35) + "...");
    expect(result.length).toBe(38); // 35 + "..."
  });

  it("handles exact boundary", () => {
    const text = "a".repeat(35); // exactly 10 tokens at 3.5 chars/token
    expect(truncateToTokens(text, 10)).toBe(text);
  });
});

// ─── extractKeyInfo ──────────────────────────────────────────────────────────

describe("extractKeyInfo", () => {
  describe("read tool", () => {
    it("extracts file read info with path and functions", () => {
      const output = [
        "function hello() {}",
        "const world = 1;",
        "class Foo {}",
      ].join("\n");
      const result = extractKeyInfo("read", output, { path: "/src/app.ts" });
      expect(result.summary).toBe("Read file: app.ts (3 lines)");
      expect(result.filePaths).toEqual(["/src/app.ts"]);
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.findings[0]).toContain("hello");
    });

    it("truncates large file output", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
      const output = lines.join("\n");
      const result = extractKeyInfo("read", output, { path: "/big.ts" });
      expect(result.content).toContain("lines omitted");
    });

    it("uses file arg fallback", () => {
      const result = extractKeyInfo("read", "x", { file: "/src/alt.ts" });
      expect(result.filePaths).toEqual(["/src/alt.ts"]);
    });

    it("defaults to unknown when no path given", () => {
      const result = extractKeyInfo("read", "x");
      expect(result.summary).toContain("unknown");
    });
  });

  describe("bash tool", () => {
    it("detects errors in output", () => {
      const result = extractKeyInfo("bash", "Error: cannot compile", {
        command: "tsc",
      });
      expect(result.summary).toContain("with errors");
      expect(result.findings).toContain("Command produced errors");
    });

    it("detects success in output", () => {
      const result = extractKeyInfo("bash", "Build success!", {
        command: "npm run build",
      });
      expect(result.summary).toContain("succeeded");
    });

    it("does not flag 0 errors as error", () => {
      const result = extractKeyInfo("bash", "0 errors found", {
        command: "tsc",
      });
      expect(result.summary).not.toContain("with errors");
    });

    it("extracts file paths from output", () => {
      const output = "compiled src/app.ts\ncompiled src/index.ts\n";
      const result = extractKeyInfo("bash", output, { command: "tsc" });
      expect(result.filePaths.length).toBeGreaterThan(0);
    });

    it("truncates large bash output", () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
      const result = extractKeyInfo("bash", lines.join("\n"), {
        command: "big cmd",
      });
      expect(result.content).toContain("lines omitted");
    });
  });

  describe("edit tool", () => {
    it("detects new file creation", () => {
      const result = extractKeyInfo("edit", "new file created", {
        path: "/src/new.ts",
      });
      expect(result.summary).toContain("Created");
      expect(result.filePaths).toEqual(["/src/new.ts"]);
    });

    it("detects editing existing file", () => {
      const result = extractKeyInfo("edit", "changes applied", {
        path: "/src/app.ts",
      });
      expect(result.summary).toContain("Edited");
    });
  });

  describe("write tool", () => {
    it("extracts write info", () => {
      const result = extractKeyInfo("write", "wrote 100 bytes", {
        path: "/src/out.ts",
      });
      expect(result.summary).toContain("Wrote file: out.ts");
      expect(result.filePaths).toEqual(["/src/out.ts"]);
    });
  });

  describe("grep / glob tools", () => {
    it("extracts search results", () => {
      const output = "src/app.ts:10: const x = 1\nsrc/util.ts:5: const y = 2";
      const result = extractKeyInfo("grep", output, { pattern: "const" });
      expect(result.summary).toContain('grep: "const"');
      expect(result.findings[0]).toContain("2 results");
    });

    it("handles glob results", () => {
      const output = "src/app.ts\nsrc/index.ts";
      const result = extractKeyInfo("glob", output, { pattern: "*.ts" });
      expect(result.summary).toContain("glob");
      expect(result.patterns).toEqual(["*.ts"]);
    });
  });

  describe("unknown tool", () => {
    it("returns generic extraction", () => {
      const result = extractKeyInfo("custom_tool", "some output");
      expect(result.summary).toBe("Tool custom_tool executed");
      expect(result.filePaths).toEqual([]);
    });
  });
});

// ─── classifyObservationType ─────────────────────────────────────────────────

describe("classifyObservationType", () => {
  it("classifies errors as problem", () => {
    expect(classifyObservationType("bash", "Fatal error occurred")).toBe(
      "problem"
    );
    expect(classifyObservationType("bash", "exception thrown")).toBe("problem");
  });

  it("does not classify '0 error' as problem", () => {
    expect(classifyObservationType("bash", "0 errors found")).not.toBe(
      "problem"
    );
  });

  it("classifies warnings", () => {
    expect(classifyObservationType("bash", "warning: unused variable")).toBe(
      "warning"
    );
    expect(classifyObservationType("bash", "deprecated function used")).toBe(
      "warning"
    );
  });

  it("classifies success", () => {
    expect(classifyObservationType("bash", "Build passed!")).toBe("success");
  });

  it("classifies read/grep/glob as discovery", () => {
    expect(classifyObservationType("read", "file contents")).toBe("discovery");
    expect(classifyObservationType("grep", "search results")).toBe("discovery");
    expect(classifyObservationType("glob", "file list")).toBe("discovery");
  });

  it("classifies edit with fix as bugfix", () => {
    expect(classifyObservationType("edit", "fix applied")).toBe("bugfix");
  });

  it("classifies edit without fix as refactor", () => {
    expect(classifyObservationType("edit", "renamed variable")).toBe("refactor");
  });

  it("classifies write as feature", () => {
    expect(classifyObservationType("write", "file written")).toBe("feature");
  });

  it("classifies bash without special keywords as discovery", () => {
    expect(classifyObservationType("bash", "ls output")).toBe("discovery");
  });

  it("classifies unknown tool as discovery", () => {
    expect(classifyObservationType("unknown", "output")).toBe("discovery");
  });
});

// ─── extractUserIntent ───────────────────────────────────────────────────────

describe("extractUserIntent", () => {
  it("detects bugfix intent", () => {
    const result = extractUserIntent("Fix the broken authentication flow");
    expect(result.goal).toMatch(/^Fix:/);
    expect(result.context).toContain("bugfix");
  });

  it("detects refactor intent", () => {
    const result = extractUserIntent("Refactor the database module");
    expect(result.goal).toMatch(/^Refactor:/);
    expect(result.context).toContain("refactor");
  });

  it("detects feature intent", () => {
    const result = extractUserIntent("Add a new user registration feature");
    expect(result.goal).toMatch(/^Implement:/);
    expect(result.context).toContain("feature");
  });

  it("detects exploration intent", () => {
    const result = extractUserIntent("Explain how the router works");
    expect(result.goal).toMatch(/^Understand:/);
    expect(result.context).toContain("exploration");
  });

  it("detects testing intent", () => {
    // "test coverage for the auth module" — no "add/implement/create" keyword
    const result = extractUserIntent("Run test coverage for the auth module");
    expect(result.goal).toMatch(/^Test:/);
    expect(result.context).toContain("testing");
  });

  it("prioritizes testing over feature when test keywords are more specific", () => {
    // "Add tests" — "test" (weight 2) beats "add" (weight 1) via scoring
    const result = extractUserIntent("Add tests for the auth module");
    expect(result.goal).toMatch(/^Test:/);
    expect(result.context).toContain("testing");
  });

  it("extracts file paths from message", () => {
    const result = extractUserIntent("Fix the error in src/app.ts and utils/helper.ts");
    expect(result.filePaths).toContain("src/app.ts");
    expect(result.filePaths).toContain("utils/helper.ts");
  });

  it("truncates very long messages", () => {
    const long = "a".repeat(500);
    const result = extractUserIntent(long);
    expect(result.goal.length).toBeLessThanOrEqual(200 + 20); // 200 + potential prefix
  });

  it("handles messages with no clear intent", () => {
    const result = extractUserIntent("hello world");
    expect(result.context).toEqual([]);
    expect(result.goal).toBe("hello world");
  });
});
