/**
 * Wrapper around the `mnemoria` CLI binary (v0.3.1+).
 *
 * All interaction with the Rust mnemoria engine goes through this module.
 * Each method shells out to the `mnemoria` binary, parses the output, and
 * returns typed results.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { EntryType, MemoryEntry, MemoryStats, SearchResult, TimelineOptions } from "../types.js";

const execFileAsync = promisify(execFile);

const MNEMORIA_BIN = "mnemoria";

/** Maximum number of retries for transient CLI failures. */
const MAX_RETRIES = 2;
/** Base delay (ms) between retries (doubled each attempt). */
const RETRY_BASE_DELAY_MS = 100;

/**
 * Execute a mnemoria CLI command and return stdout.
 * Stderr is suppressed (mnemoria logs warnings there).
 *
 * Retries up to MAX_RETRIES times on transient failures (lock contention,
 * timeouts) with exponential backoff. Permanent errors (e.g., ENOENT) are
 * not retried.
 */
async function run(
  args: string[],
  options?: { timeout?: number; retries?: number }
): Promise<string> {
  const timeout = options?.timeout ?? 30_000;
  const maxRetries = options?.retries ?? MAX_RETRIES;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { stdout } = await execFileAsync(MNEMORIA_BIN, args, {
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        env: { ...process.env, RUST_LOG: "" }, // suppress tracing
      });
      return stdout.trim();
    } catch (err: unknown) {
      const execErr = err as { stderr?: string; stdout?: string; message?: string; code?: string };
      const msg = execErr.stderr || execErr.message || "Unknown error";

      // Don't retry on permanent errors (binary not found, permission denied)
      if (execErr.code === "ENOENT" || execErr.code === "EACCES") {
        throw new Error(`mnemoria CLI error: ${msg}`);
      }

      lastError = new Error(`mnemoria CLI error: ${msg}`);

      // Retry with exponential backoff
      if (attempt < maxRetries) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError ?? new Error("mnemoria CLI error: Unknown error");
}

/**
 * MnemoriaCli — stateless wrapper for a single mnemoria store directory.
 *
 * `basePath` is the **parent** directory. The CLI appends `mnemoria/` when
 * the path is a directory, so the actual store lives at `basePath/mnemoria/`.
 */
export class MnemoriaCli {
  private _ready = false;

  constructor(public readonly basePath: string) {}

  /** Check whether the mnemoria binary is available on PATH. */
  static async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(MNEMORIA_BIN, ["--help"], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Path to the actual store directory (basePath/mnemoria/). */
  get storePath(): string {
    return join(this.basePath, "mnemoria");
  }

  /** Whether the store has been initialised (checks filesystem). */
  isInitialized(): boolean {
    return existsSync(join(this.storePath, "manifest.json"));
  }

  /** Initialise a new memory store. Idempotent if already initialised. */
  async init(): Promise<void> {
    if (this._ready || this.isInitialized()) {
      this._ready = true;
      return;
    }
    await run(["--path", this.basePath, "init"]);
    this._ready = true;
  }

  /** Ensure the store exists (init if needed) and return this instance. */
  async ensureReady(): Promise<this> {
    if (!this._ready) {
      await this.init();
    }
    return this;
  }

  /**
   * Add a memory entry. Returns the entry ID.
   *
   * `agent` is required by mnemoria v0.3.1+.
   */
  async add(
    entryType: EntryType,
    summary: string,
    content: string,
    agent: string
  ): Promise<string> {
    await this.ensureReady();
    const output = await run([
      "--path",
      this.basePath,
      "add",
      "-a",
      agent,
      "-t",
      entryType,
      "-s",
      summary,
      content,
    ]);
    // Output: "Added entry: <uuid>"
    const match = output.match(/Added entry:\s+(.+)/);
    return match?.[1]?.trim() ?? output;
  }

  /**
   * Search memories. Returns parsed results.
   *
   * Output format (v0.3.1):
   *   Found N results:
   *   1. [type] (agent) summary (score: 0.123)
   */
  async search(query: string, limit = 10, agent?: string): Promise<SearchResult[]> {
    await this.ensureReady();
    const args = [
      "--path",
      this.basePath,
      "search",
      query,
      "-l",
      String(limit),
    ];
    if (agent) args.push("-a", agent);

    const output = await run(args);

    if (output.includes("Found 0 results") || output.includes("No results") || output.trim() === "") {
      return [];
    }

    const results: SearchResult[] = [];
    const lines = output.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      // More flexible regex: allows variable whitespace and optional trailing content
      const m = line.match(
        /^\d+\.\s+\[(\w+)]\s+\((\w+)\)\s+(.+?)\s+\(score:\s*([\d.]+)\)\s*$/
      );
      if (m) {
        results.push({
          id: "",
          entry: {
            id: "",
            agent_name: m[2],
            entry_type: m[1] as EntryType,
            summary: m[3],
            content: "",
            timestamp: 0,
            checksum: 0,
            prev_checksum: 0,
          },
          score: parseFloat(m[4]),
        });
      }
    }

    return results;
  }

  /**
   * Ask a question. Returns the text answer.
   */
  async ask(question: string, agent?: string): Promise<string> {
    await this.ensureReady();
    const args = ["--path", this.basePath, "ask", question];
    if (agent) args.push("-a", agent);
    return await run(args);
  }

  /**
   * Get memory statistics.
   *
   * Output format:
   *   Memory Statistics:
   *     Total entries: 5
   *     File size: 450 bytes
   *     Oldest entry: 1771178444990
   *     Newest entry: 1771178445123
   */
  async stats(): Promise<MemoryStats> {
    await this.ensureReady();
    const output = await run(["--path", this.basePath, "stats"]);

    const totalMatch = output.match(/Total entries:\s+(\d+)/);
    const sizeMatch = output.match(/File size:\s+(\d+)/);
    const oldestMatch = output.match(/Oldest entry:\s+(\d+)/);
    const newestMatch = output.match(/Newest entry:\s+(\d+)/);

    return {
      total_entries: totalMatch ? parseInt(totalMatch[1], 10) : 0,
      file_size_bytes: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
      oldest_timestamp: oldestMatch ? parseInt(oldestMatch[1], 10) : null,
      newest_timestamp: newestMatch ? parseInt(newestMatch[1], 10) : null,
    };
  }

  /**
   * Get timeline entries.
   *
   * Output format (v0.3.1):
   *   Timeline (N entries):
   *   1. [type] (agent) summary - timestamp
   */
  async timeline(options?: Partial<TimelineOptions>, agent?: string): Promise<MemoryEntry[]> {
    await this.ensureReady();
    const args = ["--path", this.basePath, "timeline"];
    if (options?.limit) args.push("-l", String(options.limit));
    if (options?.since) args.push("-s", String(options.since));
    if (options?.until) args.push("-u", String(options.until));
    if (options?.reverse) args.push("-r");
    if (agent) args.push("-a", agent);

    const output = await run(args);

    if (output.includes("(0 entries)") || output.includes("No entries") || output.trim() === "") {
      return [];
    }

    const entries: MemoryEntry[] = [];
    const lines = output.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      // More flexible regex: allows variable whitespace around the dash separator
      const m = line.match(/^\d+\.\s+\[(\w+)]\s+\((\w+)\)\s+(.+?)\s+-\s*(\d+)\s*$/);
      if (m) {
        entries.push({
          id: "",
          agent_name: m[2],
          entry_type: m[1] as EntryType,
          summary: m[3],
          content: "",
          timestamp: parseInt(m[4], 10),
          checksum: 0,
          prev_checksum: 0,
        });
      }
    }

    return entries;
  }

  /**
   * Export all entries as JSON. Uses a temp file and reads it back.
   * This is the only reliable way to get full entry data with IDs.
   */
  async exportAll(): Promise<MemoryEntry[]> {
    await this.ensureReady();
    const tmpFile = join(
      tmpdir(),
      `mnemoria-export-${randomBytes(8).toString("hex")}.json`
    );
    try {
      await run(["--path", this.basePath, "export", tmpFile]);
      const json = readFileSync(tmpFile, "utf-8");
      return JSON.parse(json) as MemoryEntry[];
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  /**
   * Enrich search results with full content from the store.
   * Falls back gracefully — returns original results if export fails.
   */
  async enrichSearchResults(results: SearchResult[]): Promise<SearchResult[]> {
    if (results.length === 0) return results;
    try {
      const allEntries = await this.exportAll();
      const lookup = new Map<string, MemoryEntry>();
      for (const entry of allEntries) {
        // Key by summary + agent + type for best matching
        lookup.set(`${entry.entry_type}:${entry.agent_name}:${entry.summary}`, entry);
      }

      return results.map((r) => {
        const key = `${r.entry.entry_type}:${r.entry.agent_name}:${r.entry.summary}`;
        const full = lookup.get(key);
        if (full) {
          return {
            ...r,
            id: full.id,
            entry: { ...full },
          };
        }
        return r;
      });
    } catch {
      return results;
    }
  }

  /**
   * Enrich timeline entries with full content from the store.
   * Falls back gracefully — returns original entries if export fails.
   */
  async enrichTimelineEntries(entries: MemoryEntry[]): Promise<MemoryEntry[]> {
    if (entries.length === 0) return entries;
    try {
      const allEntries = await this.exportAll();
      const lookup = new Map<string, MemoryEntry>();
      for (const entry of allEntries) {
        // Key by summary + agent + timestamp for best matching
        lookup.set(`${entry.agent_name}:${entry.timestamp}:${entry.summary}`, entry);
      }

      return entries.map((e) => {
        const key = `${e.agent_name}:${e.timestamp}:${e.summary}`;
        const full = lookup.get(key);
        if (full) return { ...full };
        return e;
      });
    } catch {
      return entries;
    }
  }

  /**
   * Rebuild the store from a filtered list of entries.
   *
   * This is used by the compact operation: the old store is deleted and
   * entries are re-added one by one (preserving their original metadata
   * as closely as possible).
   *
   * WARNING: This is a destructive operation. The caller should export
   * and validate the entry list before calling this method.
   */
  async rebuild(entries: MemoryEntry[]): Promise<void> {
    // Delete the existing store
    const { rmSync: rm } = await import("node:fs");
    try {
      rm(this.storePath, { recursive: true, force: true });
    } catch { /* ignore if already gone */ }

    // Reset the cached ready state since the store was deleted
    this._ready = false;
    await this.init();

    // Re-add all entries
    for (const entry of entries) {
      await this.add(
        entry.entry_type,
        entry.summary,
        entry.content,
        entry.agent_name
      );
    }
  }

  /**
   * Verify the checksum chain integrity.
   */
  async verify(): Promise<boolean> {
    await this.ensureReady();
    const output = await run(["--path", this.basePath, "verify"]);
    return output.includes("passed");
  }
}
