/**
 * Integration tests for MnemoriaCli.
 *
 * These tests shell out to the real `mnemoria` binary and operate on a
 * temporary store. They are skipped automatically if the binary is not
 * available on PATH.
 *
 * Run with: npx vitest run --testPathPattern integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MnemoriaCli } from "./mnemoria-cli.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Pre-check: determine if binary is available before describe() evaluates
let binaryAvailable = false;
try {
  await execFileAsync("mnemoria", ["--help"], { timeout: 5_000 });
  binaryAvailable = true;
} catch {
  binaryAvailable = false;
}

let cli: MnemoriaCli;
let tmpDir: string;

describe.skipIf(!binaryAvailable)("MnemoriaCli integration", () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mnemoria-integration-"));
    cli = new MnemoriaCli(tmpDir);
  });

  afterAll(() => {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore cleanup errors */ }
    }
  });

  it("initializes a new store", async () => {
    await cli.init();
    expect(cli.isInitialized()).toBe(true);
  });

  it("adds an entry and returns an ID", async () => {
    const id = await cli.add("discovery", "Test entry", "Content of test entry", "build");
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  it("searches for entries", async () => {
    const results = await cli.search("test entry", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.entry_type).toBe("discovery");
  });

  it("returns stats", async () => {
    const stats = await cli.stats();
    expect(stats.total_entries).toBeGreaterThanOrEqual(1);
    expect(stats.file_size_bytes).toBeGreaterThan(0);
  });

  it("returns timeline entries", async () => {
    const entries = await cli.timeline({ limit: 10, reverse: true });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].entry_type).toBe("discovery");
  });

  it("exports all entries as JSON", async () => {
    const entries = await cli.exportAll();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].content).toContain("Content of test entry");
    expect(entries[0].id).toBeTruthy();
  });

  it("verifies store integrity", async () => {
    const valid = await cli.verify();
    expect(valid).toBe(true);
  });

  it("enriches search results with full content", async () => {
    const results = await cli.search("test entry", 5);
    const enriched = await cli.enrichSearchResults(results);
    if (enriched.length > 0 && enriched[0].entry.id) {
      expect(enriched[0].entry.content).toBeTruthy();
    }
  });

  it("enriches timeline entries with full content", async () => {
    const entries = await cli.timeline({ limit: 5, reverse: true });
    const enriched = await cli.enrichTimelineEntries(entries);
    if (enriched.length > 0 && enriched[0].id) {
      expect(enriched[0].content).toBeTruthy();
    }
  });

  it("filters by agent", async () => {
    await cli.add("decision", "Plan entry", "A plan decision", "plan");
    const buildResults = await cli.search("entry", 10, "build");
    const planResults = await cli.search("entry", 10, "plan");
    expect(buildResults.length).toBeGreaterThanOrEqual(1);
    expect(planResults.length).toBeGreaterThanOrEqual(1);
    for (const r of buildResults) {
      expect(r.entry.agent_name).toBe("build");
    }
    for (const r of planResults) {
      expect(r.entry.agent_name).toBe("plan");
    }
  });
});
