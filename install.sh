#!/bin/bash
set -e

REPO="one-bit/oc-mnemoria"
COMMANDS_DIR="commands"
CONFIG_FILE="opencode.json"

echo "=========================================="
echo "  oc-mnemoria Installer"
echo "=========================================="
echo ""

# ── Step 0: Check prerequisites ──────────────────────────────────────────────

echo "0. Checking prerequisites..."

if ! command -v mnemoria &> /dev/null; then
    echo "   'mnemoria' CLI not found."
    if command -v cargo &> /dev/null; then
        echo "   Installing via cargo..."
        cargo install mnemoria
    else
        echo "   ERROR: Neither 'mnemoria' nor 'cargo' found."
        echo "   Install Rust first: https://rustup.rs"
        echo "   Then run: cargo install mnemoria"
        exit 1
    fi
else
    echo "   mnemoria CLI found: $(which mnemoria)"
fi
echo ""

# ── Step 1: Configure plugin ─────────────────────────────────────────────────

detect_config_path() {
    local cwd=$(pwd)
    if [ -f "$cwd/$CONFIG_FILE" ]; then
        echo "$cwd/$CONFIG_FILE"
    elif [ -f "$HOME/.config/opencode/opencode.json" ]; then
        echo "$HOME/.config/opencode/opencode.json"
    elif [ -f "$HOME/.opencode/opencode.json" ]; then
        echo "$HOME/.opencode/opencode.json"
    else
        echo ""
    fi
}

add_plugin_to_config() {
    local config_path="$1"

    if [ -z "$config_path" ] || [ ! -f "$config_path" ]; then
        echo "   Creating new opencode.json in current directory..."
        config_path="$CONFIG_FILE"
        echo '{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oc-mnemoria/plugin"]
}' > "$config_path"
        echo "   Created $config_path"
        return
    fi

    if grep -q '"oc-mnemoria/plugin"' "$config_path" 2>/dev/null; then
        echo "   Plugin already configured in $config_path"
        return
    fi

    if command -v jq &> /dev/null; then
        if jq -e '.plugin' "$config_path" > /dev/null 2>&1; then
            jq '
              .plugin = (
                (if (.plugin | type) == "array" then .plugin else [.plugin] end)
                | map(if . == "@oc-mnemoria/plugin" or . == "oc-mnemoria" then "oc-mnemoria/plugin" else . end)
                | . + (if index("oc-mnemoria/plugin") == null then ["oc-mnemoria/plugin"] else [] end)
                | unique
              )
            ' "$config_path" > "$config_path.tmp" && mv "$config_path.tmp" "$config_path"
            echo "   Ensured oc-mnemoria/plugin is configured in $config_path"
        else
            jq '. + {plugin: ["oc-mnemoria/plugin"]}' "$config_path" > "$config_path.tmp" && mv "$config_path.tmp" "$config_path"
            echo "   Added plugin array with oc-mnemoria/plugin to $config_path"
        fi
    else
        echo "   jq not found. Please manually add \"oc-mnemoria/plugin\" to the plugin array in $config_path"
    fi
}

echo "1. Configuring plugin..."
config_path=$(detect_config_path)
add_plugin_to_config "$config_path"
echo ""

# ── Step 2: Install commands ─────────────────────────────────────────────────

install_commands() {
    local cwd=$(pwd)
    local script_dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
    local commands_source=""

    if [ -d "$cwd/$COMMANDS_DIR" ]; then
        commands_source="$cwd/$COMMANDS_DIR"
    elif [ -d "$script_dir/$COMMANDS_DIR" ]; then
        commands_source="$script_dir/$COMMANDS_DIR"
    elif [ -d "$script_dir/../commands" ]; then
        commands_source="$script_dir/../commands"
    fi

    if [ -z "$commands_source" ]; then
        echo "   Downloading commands from GitHub..."
        local temp_dir=$(mktemp -d)
        curl -sSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$temp_dir"
        commands_source="$temp_dir/oc-mnemoria-main/commands"
    fi

    local target_dir="$HOME/.config/opencode/commands"
    mkdir -p "$target_dir"

    if [ -d "$commands_source" ]; then
        cp -f "$commands_source"/*.md "$target_dir/" 2>/dev/null || true
        echo "   Installed commands to $target_dir"
    else
        echo "   Warning: Could not find commands to install"
    fi
}

echo "2. Installing commands..."
install_commands
echo ""

# ── Done ─────────────────────────────────────────────────────────────────────

echo "=========================================="
echo "  Installation complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "  1. Restart OpenCode"
echo "  2. Run /memory stats to verify"
echo ""
echo "Shared memory store will be created at:"
echo "  .opencode/mnemoria/"
echo ""
