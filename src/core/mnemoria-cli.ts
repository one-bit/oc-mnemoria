/**
 * Wrapper around the `mnemoria` CLI binary.
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

/**
 * Execute a mnemoria CLI command and return stdout.
 * Stderr is suppressed (mnemoria logs warnings there).
 */
async function run(
  args: string[],
  options?: { timeout?: number }
): Promise<string> {
  const timeout = options?.timeout ?? 30_000;
  try {
    const { stdout } = await execFileAsync(MNEMORIA_BIN, args, {
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      env: { ...process.env, RUST_LOG: "" }, // suppress tracing
    });
    return stdout.trim();
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; stdout?: string; message?: string };
    const msg = execErr.stderr || execErr.message || "Unknown error";
    throw new Error(`mnemoria CLI error: ${msg}`);
  }
}

/**
 * MnemoriaCli — stateless wrapper for a single mnemoria store directory.
 *
 * `basePath` is the **parent** directory. The CLI appends `mnemoria/` when
 * the path is a directory, so the actual store lives at `basePath/mnemoria/`.
 */
export class MnemoriaCli {
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

  /** Whether the store has been initialised. */
  isInitialized(): boolean {
    return existsSync(join(this.storePath, "manifest.json"));
  }

  /** Initialise a new memory store. Idempotent if already initialised. */
  async init(): Promise<void> {
    if (this.isInitialized()) return;
    await run(["--path", this.basePath, "init"]);
  }

  /** Ensure the store exists (init if needed) and return this instance. */
  async ensureReady(): Promise<this> {
    await this.init();
    return this;
  }

  /**
   * Add a memory entry. Returns the entry ID.
   *
   * When `agent` is provided, it is embedded as an `Agent: <name>` line
   * at the top of the content so it's indexed by the full-text engine.
   * Once the mnemoria CLI ships with `--agent`, this will switch to using
   * the native flag instead.
   */
  async add(
    entryType: EntryType,
    summary: string,
    content: string,
    agent?: string
  ): Promise<string> {
    await this.ensureReady();

    // Embed agent tag in content for searchability.
    const taggedContent = agent
      ? `Agent: ${agent}\n${content}`
      : content;

    const output = await run([
      "--path",
      this.basePath,
      "add",
      "-t",
      entryType,
      "-s",
      summary,
      taggedContent,
    ]);
    // Output: "Added entry: <uuid>"
    const match = output.match(/Added entry:\s+(.+)/);
    return match?.[1]?.trim() ?? output;
  }

  /**
   * Search memories. Returns parsed results.
   *
   * Output format:
   *   Found N results:
   *   1. [type] summary (score: 0.123)
   *   2. ...
   */
  async search(query: string, limit = 10): Promise<SearchResult[]> {
    await this.ensureReady();
    const output = await run([
      "--path",
      this.basePath,
      "search",
      query,
      "-l",
      String(limit),
    ]);

    if (output.includes("Found 0 results") || output.trim() === "") {
      return [];
    }

    const results: SearchResult[] = [];
    const lines = output.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      // Match: "1. [discovery] Some summary (score: 0.288)"
      const m = line.match(
        /^\d+\.\s+\[(\w+)]\s+(.+?)\s+\(score:\s+([\d.]+)\)$/
      );
      if (m) {
        const entryType = m[1] as EntryType;
        const summary = m[2];
        const score = parseFloat(m[3]);
        results.push({
          id: "", // CLI doesn't expose ID in search output
          entry: {
            id: "",
            entry_type: entryType,
            summary,
            content: "",
            timestamp: 0,
            checksum: 0,
            prev_checksum: 0,
          },
          score,
        });
      }
    }

    return results;
  }

  /**
   * Ask a question. Returns the text answer.
   */
  async ask(question: string): Promise<string> {
    await this.ensureReady();
    return await run(["--path", this.basePath, "ask", question]);
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
   * Output format:
   *   Timeline (N entries):
   *   1. [type] summary - timestamp
   */
  async timeline(options?: Partial<TimelineOptions>): Promise<MemoryEntry[]> {
    await this.ensureReady();
    const args = ["--path", this.basePath, "timeline"];
    if (options?.limit) args.push("-l", String(options.limit));
    if (options?.since) args.push("-s", String(options.since));
    if (options?.until) args.push("-u", String(options.until));
    if (options?.reverse) args.push("-r");

    const output = await run(args);

    if (output.includes("(0 entries)") || output.trim() === "") {
      return [];
    }

    const entries: MemoryEntry[] = [];
    const lines = output.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      // Match: "1. [discovery] Some summary - 1771178444990"
      const m = line.match(/^\d+\.\s+\[(\w+)]\s+(.+?)\s+-\s+(\d+)$/);
      if (m) {
        entries.push({
          id: "",
          entry_type: m[1] as EntryType,
          summary: m[2],
          content: "",
          timestamp: parseInt(m[3], 10),
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
   * Verify the checksum chain integrity.
   */
  async verify(): Promise<boolean> {
    await this.ensureReady();
    const output = await run(["--path", this.basePath, "verify"]);
    return output.includes("passed");
  }
}
