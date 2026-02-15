# oc-mnemoria

Persistent per-agent memory for [OpenCode](https://opencode.ai), powered by
[mnemoria](https://crates.io/crates/mnemoria).

## What it does

Every time you start a new OpenCode session, your AI assistant loses all
context from previous conversations. oc-mnemoria fixes this by giving each
agent type its own persistent memory store:

| Agent    | Remembers                                          |
|----------|----------------------------------------------------|
| `plan`   | High-level goals, architecture decisions, roadmaps |
| `build`  | Code changes, patterns found, bugs fixed           |
| `ask`    | Questions asked, explanations given                |
| `review` | Review feedback, quality patterns, style decisions |

Memories are stored locally in append-only binary files using
[mnemoria](https://github.com/one-bit/mnemoria) (a Rust engine with hybrid
BM25 + semantic search). Each agent's memory is fully isolated -- no
cross-contamination between roles.

## Prerequisites

- [Rust toolchain](https://rustup.rs/) (to install the mnemoria CLI)
- [OpenCode](https://opencode.ai/) (v0.1+)
- Node.js >= 18

## Installation

### 1. Install the mnemoria CLI

```sh
cargo install mnemoria
```

### 2. Add the plugin to your project

Add `oc-mnemoria` to the `plugin` array in your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oc-mnemoria"]
}
```

Or use the install script:

```sh
curl -fsSL https://raw.githubusercontent.com/one-bit/oc-mnemoria/main/install.sh | bash
```

### 3. Install slash commands (optional)

Copy the `commands/` directory to your OpenCode config:

```sh
cp commands/*.md ~/.config/opencode/commands/
```

## How it works

### Storage layout

```
.opencode/memory/
  plan/mnemoria/        # plan agent's memory
    log.bin
    manifest.json
    mnemoria.lock
  build/mnemoria/       # build agent's memory
    ...
  ask/mnemoria/
    ...
  review/mnemoria/
    ...
```

Each agent's store is a standard mnemoria directory. You can interact with
them directly using the `mnemoria` CLI:

```sh
# Check the build agent's stats
mnemoria --path .opencode/memory/build stats

# Search the plan agent's memories
mnemoria --path .opencode/memory/plan search "authentication"

# Export build memories to JSON
mnemoria --path .opencode/memory/build export memories.json
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
conversation) so the agent can trace *why* something was done.

### System prompt injection

At the start of each session, recent observations and past user goals are
injected into the system prompt. This gives the agent immediate context
without needing to search first.

## Tools

| Tool            | Description                                         |
|-----------------|-----------------------------------------------------|
| `remember`      | Store a categorized observation in any agent's memory |
| `search_memory` | Search by keyword/semantic similarity               |
| `ask_memory`    | Ask a natural language question                     |
| `memory_stats`  | View statistics for all or specific agents          |
| `timeline`      | Browse memories chronologically                     |

All tools accept an optional `agent` parameter to target a specific agent's
memory. If omitted, the current agent's memory is used.

### Entry types

Observations are categorized when stored:

`intent` `discovery` `decision` `problem` `solution` `pattern` `warning`
`success` `refactor` `bugfix` `feature`

## Slash commands

| Command              | Description                          |
|----------------------|--------------------------------------|
| `/memory ask <q>`    | Ask about past decisions             |
| `/memory search <q>` | Search memories                      |
| `/memory stats`      | Show per-agent statistics            |
| `/memory recent`     | Show recent memories (optionally by agent) |
| `/memory timeline`   | Chronological view (optionally by agent)   |

## Git integration

Mnemoria's append-only binary format is designed for version control. You
can commit the memory stores to track history alongside your code:

```sh
git add .opencode/memory/
git commit -m "update agent memories"
```

Or ignore them:

```sh
echo ".opencode/memory/" >> .gitignore
```

## FAQ

**How much disk space does this use?**
Each memory store starts at ~0 bytes. A typical entry is ~100-500 bytes.
Active daily use produces roughly 1-5 MB per agent per year.

**Is my data sent anywhere?**
No. Everything stays on your local filesystem. The mnemoria engine runs
entirely offline.

**How fast is it?**
The mnemoria Rust engine delivers sub-millisecond search latency for
typical store sizes (<10k entries). The plugin shells out to the CLI, so
there's ~50ms overhead per operation from process spawning.

**Can I reset an agent's memory?**
Delete its directory:
```sh
rm -rf .opencode/memory/build/mnemoria/
```

**Can I share memories between agents?**
Use the `agent` parameter on any tool to read from or write to any agent's
memory. The isolation is per-store, not per-access.

## License

MIT
