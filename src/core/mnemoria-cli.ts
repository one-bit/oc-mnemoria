/**
 * Wrapper around the `mnemoria` CLI binary (v0.3.4+).
 *
 * All interaction with the Rust mnemoria engine goes through this module.
 * Each method shells out to the `mnemoria` binary, parses the output, and
 * returns typed results.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { EntryType, MemoryEntry, MemoryStats, SearchResult, TimelineOptions } from "../types.js";
import {
  MNEMORIA_BIN,
  CLI_MAX_RETRIES,
  CLI_RETRY_BASE_DELAY_MS,
  CLI_COMMAND_TIMEOUT_MS,
  CLI_MAX_BUFFER_BYTES,
  CLI_AVAILABILITY_TIMEOUT_MS,
  EXPORT_CACHE_TTL_MS,
} from "../constants.js";

const execFileAsync = promisify(execFile);

const VALID_ENTRY_TYPES = new Set<string>([
  "intent","discovery","decision","problem","solution","pattern","warning","success","refactor","bugfix","feature"
]);

function isValidEntryType(s: string): s is EntryType {
  return VALID_ENTRY_TYPES.has(s);
}

function parseSearchResultLine(line: string): SearchResult | null {
  const baseMatch = line.match(/^\d+\.\s+\[([^\]]+)]\s+\(([^)]+)\)\s+(.+)$/);
  if (!baseMatch) return null;

  const entryTypeStr = baseMatch[1];
  if (!isValidEntryType(entryTypeStr)) return null;
  const entryType = entryTypeStr;
  const agent = baseMatch[2];
  const rest = baseMatch[3];

  const scoreMatch = rest.match(/\(score:\s*([^)]+)\)\s*$/i);
  if (!scoreMatch || scoreMatch.index === undefined) return null;

  const score = Number.parseFloat(scoreMatch[1]);
  if (Number.isNaN(score)) return null;

  const summary = rest.slice(0, scoreMatch.index).trim();
  if (!summary) return null;

  return {
    id: "",
    entry: {
      id: "",
      agent_name: agent,
      entry_type: entryType,
      summary,
      content: "",
      timestamp: 0,
      checksum: 0,
      prev_checksum: 0,
    },
    score,
  };
}

function parseTimelineLine(line: string): MemoryEntry | null {
  const baseMatch = line.match(/^\d+\.\s+\[([^\]]+)]\s+\(([^)]+)\)\s+(.+)$/);
  if (!baseMatch) return null;

  const entryTypeStr = baseMatch[1];
  if (!isValidEntryType(entryTypeStr)) return null;
  const entryType = entryTypeStr;
  const agent = baseMatch[2];
  const rest = baseMatch[3];
  const timeMatch = rest.match(/\s+-\s*(\d+)\s*$/);
  if (!timeMatch || timeMatch.index === undefined) return null;

  const timestamp = Number.parseInt(timeMatch[1], 10);
  if (Number.isNaN(timestamp)) return null;

  const summary = rest.slice(0, timeMatch.index).trim();
  if (!summary) return null;

  return {
    id: "",
    agent_name: agent,
    entry_type: entryType,
    summary,
    content: "",
    timestamp,
    checksum: 0,
    prev_checksum: 0,
  };
}

/**
 * MnemoriaCli — stateless wrapper for a single mnemoria store directory.
 *
 * `basePath` is the **parent** directory. The CLI appends `mnemoria/` when
 * the path is a directory, so the actual store lives at `basePath/mnemoria/`.
 */
export class MnemoriaCli {
  private _ready = false;
  private exportCache: { expiresAt: number; entries: MemoryEntry[] } | null = null;
  private exportInFlight: Promise<MemoryEntry[]> | null = null;

  constructor(public readonly basePath: string) {}

  /**
   * Execute a mnemoria CLI command and return stdout.
   * Stderr is suppressed (mnemoria logs warnings there).
   *
   * Retries up to MAX_RETRIES times on transient failures (lock contention,
   * timeouts) with exponential backoff. Permanent errors (e.g., ENOENT) are
   * not retried.
   */
  private async run(
    args: string[],
    options?: { timeout?: number; retries?: number }
  ): Promise<string> {
    const timeout = options?.timeout ?? CLI_COMMAND_TIMEOUT_MS;
    const maxRetries = options?.retries ?? CLI_MAX_RETRIES;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { stdout } = await execFileAsync(MNEMORIA_BIN, args, {
          timeout,
          maxBuffer: CLI_MAX_BUFFER_BYTES,
          env: { ...process.env, RUST_LOG: "" }, // suppress tracing
        });
        return stdout.trim();
      } catch (err: unknown) {
        const execErr = err instanceof Error ? err : new Error(String(err));
        const stderr = (err as Record<string, unknown>)?.stderr;
        const msg = typeof stderr === "string" && stderr.length > 0 ? stderr : execErr.message;
        const code = (err as Record<string, unknown>)?.code;

        // Don't retry on permanent errors (binary not found, permission denied)
        if (code === "ENOENT" || code === "EACCES") {
          throw new Error(`mnemoria CLI error: ${msg}`);
        }

        lastError = new Error(`mnemoria CLI error: ${msg}`);

        // Retry with exponential backoff
        if (attempt < maxRetries) {
          const delay = CLI_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error("mnemoria CLI error: Unknown error");
  }

  /** Check whether the mnemoria binary is available on PATH. */
  static async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(MNEMORIA_BIN, ["--help"], { timeout: CLI_AVAILABILITY_TIMEOUT_MS });
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
    await this.run(["--path", this.basePath, "init"]);
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
   * `agent` is required by mnemoria v0.3.4+.
   */
  async add(
    entryType: EntryType,
    summary: string,
    content: string,
    agent: string
  ): Promise<string> {
    await this.ensureReady();
    const output = await this.run([
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
    this.invalidateExportCache();
    // Output: "Added entry: <uuid>"
    const match = output.match(/Added entry:\s+(.+)/);
    return match?.[1]?.trim() ?? output;
  }

  /**
   * Search memories. Returns parsed results.
   *
   * Output format (v0.3.4):
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

    const output = await this.run(args);

    if (output.includes("Found 0 results") || output.includes("No results") || output.trim() === "") {
      return [];
    }

    const results: SearchResult[] = [];
    const lines = output.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const parsed = parseSearchResultLine(line);
      if (parsed) results.push(parsed);
    }

    const dataLines = lines.filter((line) => /^\d+\./.test(line));
    if (dataLines.length > 0 && results.length === 0) {
      console.error(
        "[oc-mnemoria] Warning: Search output was non-empty but no lines were parsed. CLI output format may have changed."
      );
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
    return await this.run(args);
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
    const output = await this.run(["--path", this.basePath, "stats"]);

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
   * Output format (v0.3.4):
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

    const output = await this.run(args);

    if (output.includes("(0 entries)") || output.includes("No entries") || output.trim() === "") {
      return [];
    }

    const entries: MemoryEntry[] = [];
    const lines = output.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const parsed = parseTimelineLine(line);
      if (parsed) entries.push(parsed);
    }

    const dataLines = lines.filter((line) => /^\d+\./.test(line));
    if (dataLines.length > 0 && entries.length === 0) {
      console.error(
        "[oc-mnemoria] Warning: Timeline output was non-empty but no lines were parsed. CLI output format may have changed."
      );
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
      await this.run(["--path", this.basePath, "export", tmpFile]);
      const json = await readFile(tmpFile, "utf-8");
      return JSON.parse(json) as MemoryEntry[];
    } finally {
      try { await unlink(tmpFile); } catch { /* ignore */ }
    }
  }

  /**
   * Enrich search results with full content from the store.
   * Falls back gracefully — returns original results if export fails.
   */
  async enrichSearchResults(results: SearchResult[]): Promise<SearchResult[]> {
    if (results.length === 0) return results;
    try {
      const allEntries = await this.getAllEntriesCached();
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
      const allEntries = await this.getAllEntriesCached();
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
   * This is used by the compact operation. The rebuild is performed
   * atomically: entries are written to a temporary store first, then
   * the temp store is swapped in to replace the real one. If anything
   * fails, the original store is left untouched.
   */
  async rebuild(entries: MemoryEntry[]): Promise<void> {
    const tempDir = join(tmpdir(), "mnemoria-rebuild-" + randomBytes(8).toString("hex"));

    try {
      // Create a temporary MnemoriaCli that writes to the temp directory
      mkdirSync(tempDir, { recursive: true });
      const tempCli = new MnemoriaCli(tempDir);
      await tempCli.init();

      // Re-add all entries to the temp store
      for (const entry of entries) {
        await tempCli.add(
          entry.entry_type,
          entry.summary,
          entry.content,
          entry.agent_name
        );
      }

      // Atomic swap: remove the real store, move the temp store in
      rmSync(this.storePath, { recursive: true, force: true });

      const tempStorePath = join(tempDir, "mnemoria");
      try {
        renameSync(tempStorePath, this.storePath);
      } catch {
        // renameSync fails across devices; fall back to copy + delete
        cpSync(tempStorePath, this.storePath, { recursive: true });
        rmSync(tempStorePath, { recursive: true, force: true });
      }
    } catch (err) {
      // On any failure, clean up the temp dir but leave the original store intact
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch { /* ignore cleanup errors */ }
      throw err;
    }

    // Clean up the remaining temp directory shell (the inner mnemoria/ was moved out)
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }

    // Reset state so the next operation re-reads the swapped-in store
    this._ready = false;
    this.invalidateExportCache();
  }

  /**
   * Verify the checksum chain integrity.
   */
  async verify(): Promise<boolean> {
    await this.ensureReady();
    const output = await this.run(["--path", this.basePath, "verify"]);
    return output.includes("passed");
  }

  private invalidateExportCache(): void {
    this.exportCache = null;
  }

  private async getAllEntriesCached(): Promise<MemoryEntry[]> {
    const now = Date.now();
    if (this.exportCache && this.exportCache.expiresAt > now) {
      return this.exportCache.entries;
    }

    if (this.exportInFlight) {
      return this.exportInFlight;
    }

    this.exportInFlight = this.exportAll()
      .then((entries) => {
        this.exportCache = {
          entries,
          expiresAt: Date.now() + EXPORT_CACHE_TTL_MS,
        };
        return entries;
      })
      .finally(() => {
        this.exportInFlight = null;
      });

    return this.exportInFlight;
  }
}
