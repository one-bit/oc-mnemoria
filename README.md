# oc-mnemoria

Persistent shared memory for [OpenCode](https://opencode.ai) agents, powered
by [mnemoria](https://crates.io/crates/mnemoria).

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

Every memory entry includes an `Agent: <name>` tag in its content, making it
searchable and visible when retrieved. When the mnemoria CLI ships with
native `--agent` support, the plugin will switch to using that.

Example of a stored entry's content:

```
Agent: build
Found that the auth module uses JWT tokens with RS256 signing.
Tool: read
Files: src/auth/jwt.ts
Findings: Functions: verifyToken, signToken, refreshToken
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

### Entry types

Observations are categorized when stored:

`intent` `discovery` `decision` `problem` `solution` `pattern` `warning`
`success` `refactor` `bugfix` `feature`

## Slash commands

| Command              | Description                          |
|----------------------|--------------------------------------|
| `/memory ask <q>`    | Ask about past decisions             |
| `/memory search <q>` | Search memories                      |
| `/memory stats`      | Show memory statistics               |
| `/memory recent`     | Show recent memories                 |
| `/memory timeline`   | Chronological view                   |

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
Search for the agent name as part of the query (e.g. `"build authentication"`)
since the agent tag is indexed in the content. Once the mnemoria CLI ships
native `--agent` filtering, this will be more precise.

## License

MIT
