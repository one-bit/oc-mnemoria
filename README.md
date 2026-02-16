# oc-mnemoria

[![CI](https://github.com/one-bit/oc-mnemoria/actions/workflows/ci.yml/badge.svg)](https://github.com/one-bit/oc-mnemoria/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/oc-mnemoria)](https://www.npmjs.com/package/oc-mnemoria)
[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-181717?logo=githubsponsors)](https://github.com/sponsors/one-bit)

Persistent shared memory for [OpenCode](https://opencode.ai) agents, powered
by [mnemoria](https://crates.io/crates/mnemoria).

## Support this project

If this project has been helpful to you, you are welcome to sponsor it.
Sponsorship helps me spend more time maintaining it, fixing bugs, and
building new features.

No pressure at all - starring the repo, sharing it, or giving feedback also
means a lot.

[Become a sponsor](https://github.com/sponsors/one-bit)

## What it does

Every time you start a new OpenCode session, your AI assistant loses all
context from previous conversations. oc-mnemoria fixes this by giving all
agents a shared "hive mind" — a single persistent memory store where every
agent can read and write.

Each memory entry is tagged with the agent that created it (plan, build, ask,
review, ...) so any agent can tell who recorded what. The build agent can see
what the plan agent decided; the review agent can recall bugs the build agent
fixed. No context is lost between roles.

Memories are stored locally in an append-only binary file using
[mnemoria](https://github.com/one-bit/mnemoria) — a Rust engine with hybrid
BM25 + semantic search, CRC32 checksum chains, and corruption recovery.

## Prerequisites

- [Rust toolchain](https://rustup.rs/) (to install the mnemoria CLI)
- [OpenCode](https://opencode.ai/) (v0.1+)
- Node.js >= 18

## Installation

Run the install script in your project directory:

```sh
curl -fsSL https://raw.githubusercontent.com/one-bit/oc-mnemoria/main/install.sh | sh
```

The script:

1. Installs the `mnemoria` CLI (via `cargo install` if needed)
2. Configures the compatibility plugin setup (`opencode.json`, `.opencode/package.json`, `.opencode/plugins/oc-mnemoria.js`)
3. Installs `/mn-*` slash commands to `.opencode/commands/`
4. Installs the oc-mnemoria-judge subagent to `.opencode/agents/`

After installation, restart OpenCode and run:

```sh
/mn-stats
```

You should see memory store statistics (entry count, file size, timestamps).

## How it works

### Storage layout

All agents share a single memory store:

```
.opencode/mnemoria/
  log.bin           # append-only binary log
  manifest.json     # metadata and checksums
  mnemoria.lock     # advisory file lock
```

You can interact with the store directly using the `mnemoria` CLI:

```sh
mnemoria --path .opencode stats
mnemoria --path .opencode search "authentication"
mnemoria --path .opencode export memories.json
```

### Agent tagging

Every memory entry is tagged with the agent that created it via mnemoria's
native `--agent` flag. The agent name is a first-class field on each entry,
visible in search results, timeline output, and JSON exports.

```sh
# Search only the build agent's memories
mnemoria --path .opencode search -a build "authentication"

# Show only the plan agent's timeline
mnemoria --path .opencode timeline -a plan
```

### Automatic capture

The plugin automatically captures context from tool usage:

| Tool   | What gets stored                          |
|--------|-------------------------------------------|
| `read` | File paths, function names, line counts   |
| `bash` | Commands run, success/failure, file paths |
| `edit` | Files modified, type of change            |
| `write`| Files created                             |
| `grep` | Search patterns, result counts            |
| `glob` | Search patterns, matched files            |

Each observation is linked to the user's intent (extracted from the
conversation) via chain IDs, so any agent can trace *why* something was done.

### System prompt injection

At the start of each session, recent observations and past user goals are
injected into the system prompt. Each entry shows which agent created it,
giving the current agent immediate cross-agent context.

## Tools

| Tool            | Description                                         |
|-----------------|-----------------------------------------------------|
| `remember`      | Store a categorized observation in shared memory     |
| `search_memory` | Search by keyword/semantic similarity               |
| `ask_memory`    | Ask a natural language question                     |
| `memory_stats`  | View statistics for the shared store                |
| `timeline`      | Browse memories chronologically (all agents)        |
| `forget`        | Mark a memory as obsolete (append-only tombstone)   |
| `compact`       | Remove forgotten entries/markers and optionally prune old data |

## oc-mnemoria-judge Subagent

The install script includes an `oc-mnemoria-judge` **subagent** (mode: `subagent`) that helps decide what should be remembered. This provides a lightweight way to get a second opinion on whether content is worth storing.

**What is a subagent?**  
Subagents are specialized AI assistants that can be invoked manually via `@` mentions or automatically by primary agents via the Task tool. Unlike primary agents (Build, Plan), subagents are designed for specific tasks and run in their own isolated sessions.

### How it works

The plugin automatically captures obvious intents using fast heuristics. For uncertain cases, you can invoke the memory judge subagent:

```
@oc-mnemoria-judge Should I remember: "We decided to use PostgreSQL instead of MongoDB"
```

The subagent will analyze the content and respond with:
- A YES/NO decision
- Brief reasoning
- Suggested entry type
- A summary for storage

**Note:** The oc-mnemoria-judge is configured as `mode: subagent` in `.opencode/agents/oc-mnemoria-judge.md`, making it available for manual invocation but not appearing as a primary agent in the Tab-switching menu.

### Setting a model

The oc-mnemoria-judge subagent does **not** set a model by default — it will
use whatever model OpenCode assigns. Since this subagent performs a simple
YES/NO classification, you should override it with a **low-cost model** to
avoid unnecessary spend.

Add an agent model override in your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "oc-mnemoria-judge": {
      "model": "anthropic/claude-haiku-4-5-20251001"
    }
  }
}
```

Any model available in your OpenCode instance can be used. Run `/models` to
see available options.

### Customizing behavior

You can edit the agent's configuration and system prompt in
`.opencode/agents/oc-mnemoria-judge.md` to change:
- **Mode**: Keep as `subagent` for manual invocation via `@oc-mnemoria-judge`, or change to `primary` if you want it as a main agent
- **Tools**: Add tools if you want the subagent to perform actions (currently set to `{}` for safety)
- **Hidden**: Set to `true` to hide from `@` autocomplete (can still be invoked programmatically)
- **System prompt**: Change what types of content should be remembered, response format, decision criteria, examples

### Entry types

Observations are categorized when stored:

`intent` `discovery` `decision` `problem` `solution` `pattern` `warning`
`success` `refactor` `bugfix` `feature`

## Slash commands

| Command              | Description                          |
|----------------------|--------------------------------------|
| `/mn-ask <q>`        | Ask about past decisions             |
| `/mn-search <q>`     | Search memories                      |
| `/mn-stats`          | Show memory statistics               |
| `/mn-recent`         | Show recent memories                 |
| `/mn-timeline`       | Chronological view                   |
| `/mn-forget ...`     | Mark a memory as forgotten/obsolete  |
| `/mn-compact`        | Compact store by removing forgotten data |

## Inspecting memories from the command line

You can use the `mnemoria` CLI directly to browse, search, and manage the
memory store outside of OpenCode. All commands use `--path .opencode` to
point at your project's store (mnemoria auto-appends `mnemoria/` to resolve
the actual data directory).

### Browse the timeline

```sh
# Most recent 20 entries (newest first)
mnemoria --path .opencode timeline -r

# Last 5 entries
mnemoria --path .opencode timeline -r -l 5

# Only entries from the build agent
mnemoria --path .opencode timeline -a build

# Entries from a specific time range (Unix ms timestamps)
mnemoria --path .opencode timeline -s 1700000000000 -u 1700100000000
```

Output looks like:

```
Timeline (3 entries):
1. [discovery] (build) Found async pattern in auth module - 1700000100000
2. [decision] (plan) Use JWT for session tokens - 1700000050000
3. [intent] (plan) Fix authentication flow - 1700000000000
```

### Search memories

```sh
# Keyword + semantic hybrid search
mnemoria --path .opencode search "authentication"

# Limit results
mnemoria --path .opencode search "error handling" -l 5

# Search only one agent's memories
mnemoria --path .opencode search -a review "security"
```

### Ask a question

```sh
# Ask a natural language question against the memory store
mnemoria --path .opencode ask "What decisions were made about the database schema?"

# Scoped to a single agent
mnemoria --path .opencode ask -a plan "What was the original plan for auth?"
```

### View statistics

```sh
mnemoria --path .opencode stats
```

```
Memory Statistics:
  Total entries: 42
  File size: 4096 bytes
  Oldest entry: 1700000000000
  Newest entry: 1700001000000
```

### Export to JSON

```sh
mnemoria --path .opencode export memories.json
```

This produces a JSON array with full entry data including `agent_name`,
`entry_type`, `summary`, `content`, `timestamp`, and checksum fields.
Useful for scripting, analysis, or migrating data.

### Add a memory manually

```sh
mnemoria --path .opencode add \
  -a build \
  -t decision \
  -s "Switched from REST to GraphQL" \
  "After benchmarking, GraphQL reduced payload size by 60%"
```

The `-t` flag accepts any entry type: `intent`, `discovery`, `decision`,
`problem`, `solution`, `pattern`, `warning`, `success`, `refactor`,
`bugfix`, `feature`. Defaults to `discovery` if omitted.

### Verify store integrity

```sh
mnemoria --path .opencode verify
```

Checks the CRC32 checksum chain across all entries. Returns a non-zero exit
code on corruption, making it suitable for CI or pre-commit hooks.

## Memory maintenance workflows

Over time, some memories become outdated. oc-mnemoria supports a two-step
maintenance flow:

1. Mark obsolete entries with `forget` (append-only marker)
2. Run `compact` to physically rebuild the store without forgotten entries

### In OpenCode (recommended)

Use slash commands:

```sh
/mn-search flaky test timeout
/mn-forget id=8d9f... reason="Superseded by retry policy"
/mn-compact
```

Optionally prune old entries during compaction:

```sh
/mn-compact 90
```

(`90` means `maxAgeDays=90`)

### What each step does

- `forget` keeps history intact by writing a tombstone marker
- `compact` removes forgotten markers/entries and optionally old data
- This keeps the memory store accurate while preserving auditability between runs

## Git integration

Mnemoria's append-only binary format is designed for version control. You
can commit the memory store to track history alongside your code:

```sh
git add .opencode/
git commit -m "update agent memories"
```

Or ignore it:

```sh
echo ".opencode/mnemoria/" >> .gitignore  # ignore just the memory store
```

## FAQ

**How much disk space does this use?**
The store starts empty. A typical entry is ~100-500 bytes. Active daily use
produces roughly 2-10 MB per year.

**Is my data sent anywhere?**
No. Everything stays on your local filesystem. The mnemoria engine runs
entirely offline.

**How fast is it?**
The mnemoria Rust engine delivers sub-millisecond search latency for
typical store sizes (<10k entries). The plugin shells out to the CLI, so
there's ~50ms overhead per operation from process spawning.

**Can I reset the memory?**
Delete the store directory:
```sh
rm -rf .opencode/mnemoria/
```

**Can I search only one agent's memories?**
Yes. Pass the `agent` parameter to `search_memory`, `ask_memory`, or
`timeline`. From the CLI: `mnemoria --path .opencode search -a build "auth"`.

## License

MIT
