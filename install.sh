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

MIN_MNEMORIA="0.3.4"

# Compare two semver strings. Returns 0 if $1 >= $2, 1 otherwise.
version_gte() {
    # Split on dots and compare numerically
    IFS='.' read -r a1 a2 a3 <<EOF
$1
EOF
    IFS='.' read -r b1 b2 b3 <<EOF
$2
EOF
    a1=${a1:-0}; a2=${a2:-0}; a3=${a3:-0}
    b1=${b1:-0}; b2=${b2:-0}; b3=${b3:-0}
    [ "$a1" -gt "$b1" ] && return 0
    [ "$a1" -lt "$b1" ] && return 1
    [ "$a2" -gt "$b2" ] && return 0
    [ "$a2" -lt "$b2" ] && return 1
    [ "$a3" -ge "$b3" ] && return 0
    return 1
}

if ! command -v mnemoria >/dev/null 2>&1; then
    echo "   'mnemoria' CLI not found."
    if command -v cargo >/dev/null 2>&1; then
        echo "   Installing mnemoria (>= $MIN_MNEMORIA) via cargo..."
        cargo install mnemoria
    else
        echo "   ERROR: Neither 'mnemoria' nor 'cargo' found."
        echo "   Install Rust first: https://rustup.rs"
        echo "   Then run: cargo install mnemoria"
        exit 1
    fi
else
    CURRENT_VERSION="$(mnemoria --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "0.0.0")"
    echo "   mnemoria CLI found: $(command -v mnemoria) (v$CURRENT_VERSION)"
    if ! version_gte "$CURRENT_VERSION" "$MIN_MNEMORIA"; then
        echo "   Version $CURRENT_VERSION is below minimum $MIN_MNEMORIA. Updating..."
        if command -v cargo >/dev/null 2>&1; then
            cargo install mnemoria
        else
            echo "   WARNING: cargo not found. Please update mnemoria manually:"
            echo "   cargo install mnemoria"
        fi
    fi
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
echo ""
echo "Next steps:"
echo "  1. Restart OpenCode"
echo "  2. Run /mn-stats to verify"
echo ""
echo "Shared memory store will be created at:"
echo "  .opencode/mnemoria/"
echo ""
