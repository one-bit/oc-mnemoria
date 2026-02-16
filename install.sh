#!/bin/sh
set -e

REPO="one-bit/oc-mnemoria"
COMMANDS_DIR="commands"
CONFIG_FILE="opencode.json"
PROJECT_DIR="$(pwd)"
OPENCODE_DIR="$PROJECT_DIR/.opencode"
PACKAGE_FILE="$OPENCODE_DIR/package.json"
PLUGIN_FILE="$OPENCODE_DIR/plugins/oc-mnemoria.js"

echo "=========================================="
echo "  oc-mnemoria Installer"
echo "=========================================="
echo ""

# ── Step 0: Check prerequisites ──────────────────────────────────────────────

echo "0. Checking prerequisites..."

if ! command -v mnemoria >/dev/null 2>&1; then
    echo "   'mnemoria' CLI not found."
    if command -v cargo >/dev/null 2>&1; then
        echo "   Installing via cargo..."
        cargo install mnemoria
    else
        echo "   ERROR: Neither 'mnemoria' nor 'cargo' found."
        echo "   Install Rust first: https://rustup.rs"
        echo "   Then run: cargo install mnemoria"
        exit 1
    fi
else
    echo "   mnemoria CLI found: $(command -v mnemoria)"
fi
echo ""

# ── Step 1: Configure compatibility plugin setup ────────────────────────────

ensure_project_config() {
    if [ ! -f "$PROJECT_DIR/$CONFIG_FILE" ]; then
        echo "   Creating $CONFIG_FILE in current directory..."
        cat > "$PROJECT_DIR/$CONFIG_FILE" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json"
}
EOF
        echo "   Created $PROJECT_DIR/$CONFIG_FILE"
        return
    fi

    if command -v jq >/dev/null 2>&1; then
        jq '
          if (.plugin? | type) == "array" then
            .plugin = (.plugin | map(select(. != "oc-mnemoria" and . != "oc-mnemoria/plugin" and . != "@oc-mnemoria/plugin")))
            | if (.plugin | length) == 0 then del(.plugin) else . end
          else
            .
          end
        ' "$PROJECT_DIR/$CONFIG_FILE" > "$PROJECT_DIR/$CONFIG_FILE.tmp" && mv "$PROJECT_DIR/$CONFIG_FILE.tmp" "$PROJECT_DIR/$CONFIG_FILE"
        echo "   Ensured no conflicting oc-mnemoria entries in $PROJECT_DIR/$CONFIG_FILE"
    elif grep -q 'oc-mnemoria' "$PROJECT_DIR/$CONFIG_FILE" 2>/dev/null; then
        echo "   Warning: jq not found and $CONFIG_FILE may still contain plugin entries."
        echo "   Please remove any plugin entries for oc-mnemoria from $CONFIG_FILE if OpenCode fails to start."
    else
        echo "   Found existing $CONFIG_FILE"
    fi
}

ensure_local_dependency() {
    mkdir -p "$OPENCODE_DIR"

    if [ ! -f "$PACKAGE_FILE" ]; then
        cat > "$PACKAGE_FILE" <<'EOF'
{
  "dependencies": {
    "oc-mnemoria": "latest"
  }
}
EOF
        echo "   Created $PACKAGE_FILE"
        return
    fi

    if command -v jq >/dev/null 2>&1; then
        jq '.dependencies = ((.dependencies // {}) + {"oc-mnemoria": "latest"})' "$PACKAGE_FILE" > "$PACKAGE_FILE.tmp" && mv "$PACKAGE_FILE.tmp" "$PACKAGE_FILE"
        echo "   Ensured oc-mnemoria dependency in $PACKAGE_FILE"
    elif grep -q '"oc-mnemoria"' "$PACKAGE_FILE" 2>/dev/null; then
        echo "   Found oc-mnemoria dependency in $PACKAGE_FILE"
    else
        echo "   Warning: jq not found and $PACKAGE_FILE exists without oc-mnemoria dependency."
        echo "   Please add: \"oc-mnemoria\": \"latest\" under dependencies."
    fi
}

ensure_wrapper_plugin() {
    mkdir -p "$OPENCODE_DIR/plugins"
    cat > "$PLUGIN_FILE" <<'EOF'
import OcMnemoria from "oc-mnemoria/plugin"

export const OcMnemoriaPlugin = async (ctx) => OcMnemoria(ctx)
EOF
    echo "   Wrote compatibility wrapper plugin to $PLUGIN_FILE"
}

echo "1. Configuring compatibility plugin setup..."
ensure_project_config
ensure_local_dependency
ensure_wrapper_plugin
echo ""

# ── Step 2: Install commands ─────────────────────────────────────────────────

install_commands() {
    cwd="$(pwd)"
    script_dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
    commands_source=""

    if [ -d "$cwd/$COMMANDS_DIR" ]; then
        commands_source="$cwd/$COMMANDS_DIR"
    elif [ -d "$script_dir/$COMMANDS_DIR" ]; then
        commands_source="$script_dir/$COMMANDS_DIR"
    elif [ -d "$script_dir/../commands" ]; then
        commands_source="$script_dir/../commands"
    fi

    if [ -z "$commands_source" ]; then
        echo "   Downloading commands from GitHub..."
        temp_dir="$(mktemp -d)"
        curl -sSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$temp_dir"
        commands_source="$temp_dir/oc-mnemoria-main/commands"
    fi

    target_dir="$OPENCODE_DIR/commands"
    mkdir -p "$target_dir"

    if [ -d "$commands_source" ]; then
        cp -f "$commands_source"/mn-*.md "$target_dir/" 2>/dev/null || true
        echo "   Installed mn-* commands to $target_dir"
    else
        echo "   Warning: Could not find commands to install"
    fi
}

echo "2. Installing commands..."
install_commands
echo ""

# ── Step 3: Install oc-mnemoria-judge agent ───────────────────────────────────

AGENTS_DIR="agents"

install_agents() {
    cwd="$(pwd)"
    script_dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
    agents_source=""

    if [ -d "$cwd/$AGENTS_DIR" ]; then
        agents_source="$cwd/$AGENTS_DIR"
    elif [ -d "$script_dir/$AGENTS_DIR" ]; then
        agents_source="$script_dir/$AGENTS_DIR"
    elif [ -d "$script_dir/../agents" ]; then
        agents_source="$script_dir/../agents"
    fi

    if [ -z "$agents_source" ]; then
        echo "   Downloading agents from GitHub..."
        temp_dir="$(mktemp -d)"
        curl -sSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$temp_dir"
        agents_source="$temp_dir/oc-mnemoria-main/agents"
    fi

    target_dir="$PROJECT_DIR/.opencode/agents"
    mkdir -p "$target_dir"

    if [ -d "$agents_source" ]; then
        cp -f "$agents_source"/*.md "$target_dir/" 2>/dev/null || true
        echo "   Installed agents to $target_dir"
    else
        echo "   Warning: Could not find agents to install"
    fi
}

echo "3. Installing oc-mnemoria-judge agent..."
install_agents
echo ""

# ── Done ─────────────────────────────────────────────────────────────────────

echo "=========================================="
echo "  Installation complete!"
echo "=========================================="
echo ""
echo "Installed compatibility setup for current OpenCode plugin behavior:"
echo "  - $PROJECT_DIR/$CONFIG_FILE"
echo "  - $PACKAGE_FILE"
echo "  - $PLUGIN_FILE"
echo "  - $OPENCODE_DIR/commands/ (mn-* slash commands)"
echo "  - $OPENCODE_DIR/agents/"
echo ""
echo "Next steps:"
echo "  1. Restart OpenCode"
echo "  2. Run /mn-stats to verify"
echo "  3. Try @oc-mnemoria-judge to test the memory judge agent"
echo ""
echo "Shared memory store will be created at:"
echo "  .opencode/mnemoria/"
echo ""
echo "oc-mnemoria-judge agent available at:"
echo "  .opencode/agents/oc-mnemoria-judge.md"
echo "  Edit this file to customize the model or behavior"
echo ""
