import { describe, it, expect } from "vitest";
import {
  generateId,
  estimateTokens,
  truncateToTokens,
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

  it("marks strong intents as shouldStore: true", () => {
    const result = extractUserIntent("Fix the broken authentication flow in the app");
    expect(result.shouldStore).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(2);
  });

  it("marks weak intents as shouldStore: false", () => {
    // "hello world" matches no strong patterns, score should be below threshold
    const result = extractUserIntent("hello world this is a message");
    expect(result.shouldStore).toBe(false);
    expect(result.score).toBeLessThan(2);
  });

  it("requires minimum message length for shouldStore", () => {
    // "fix bug" has bugfix keywords but is under 20 chars
    const result = extractUserIntent("fix bug");
    expect(result.shouldStore).toBe(false);
  });

  it("returns correct score for bugfix intent", () => {
    // "bug" (3) + "fix" (2) + "broken" (3) = 8
    const result = extractUserIntent("Fix the broken bug in the authentication");
    expect(result.score).toBe(8);
    expect(result.shouldStore).toBe(true);
  });
});
