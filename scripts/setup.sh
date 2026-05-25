#!/usr/bin/env bash
# Claude CLI Proxy — interactive setup wizard.
# Onboards this server onto any machine that already has the `claude` CLI logged in.

set -euo pipefail

# ---------- pretty output ----------
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  RED=$(tput setaf 1); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3)
  BLUE=$(tput setaf 4); CYAN=$(tput setaf 6)
else
  BOLD=""; DIM=""; RESET=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""
fi

hr()   { printf '%s\n' "${DIM}────────────────────────────────────────────────────────────${RESET}"; }
step() { printf '\n%s\n' "${BOLD}${BLUE}▶ $*${RESET}"; }
ok()   { printf '  %s %s\n' "${GREEN}✓${RESET}" "$*"; }
warn() { printf '  %s %s\n' "${YELLOW}!${RESET}" "$*"; }
err()  { printf '  %s %s\n' "${RED}✗${RESET}" "$*" >&2; }
info() { printf '    %s%s%s\n' "${DIM}" "$*" "${RESET}"; }

# Yes/No prompt. $1 = question; $2 = default (y|n).
# In non-interactive mode (no TTY or NON_INTERACTIVE=1) the *default* answer is used.
# To accept destructive defaults without a TTY, set NON_INTERACTIVE=1 explicitly.
ask() {
  local question="$1" default="${2:-y}" prompt reply
  case "$default" in
    y|Y) prompt="[Y/n]";;
    *)   prompt="[y/N]";;
  esac
  # Probe whether /dev/tty can actually be opened for reading. In sandboxes /dev/tty
  # may exist but redirecting from it fails with "Device not configured".
  if [[ "${NON_INTERACTIVE:-0}" == "1" ]] || ! { : </dev/tty ; } 2>/dev/null; then
    info "(non-interactive: defaulting to '$default' for: $question)"
    [[ "$default" =~ ^[Yy]$ ]]
    return $?
  fi
  read -r -p "  ${BOLD}? ${question} ${prompt} ${RESET}" reply </dev/tty || reply=""
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

# ---------- locate repo ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

PORT="${PORT:-3000}"
HOST="${HOST:-127.0.0.1}"

hr
printf '%s\n' "${BOLD}Claude CLI Proxy — Setup Wizard${RESET}"
info "repo:     $REPO_DIR"
info "platform: $(uname -s) $(uname -m)"
info "target:   http://$HOST:$PORT"
hr

# ---------- 1. Node ----------
step "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  err "node not found in PATH"
  info "Install Node 18+ from https://nodejs.org/ (or via 'brew install node')"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  err "Node 18+ required, found $(node --version)"
  exit 1
fi
ok "node $(node --version)"

# ---------- 2. npm ----------
step "Checking npm"
if ! command -v npm >/dev/null 2>&1; then
  err "npm not found"
  exit 1
fi
ok "npm $(npm --version)"

# ---------- 3. claude CLI ----------
step "Checking claude CLI"
if command -v claude >/dev/null 2>&1; then
  CLAUDE_VERSION="$(claude --version 2>/dev/null | head -1 || echo 'unknown')"
  ok "claude found: $CLAUDE_VERSION"
else
  warn "'claude' not in PATH"
  info "The SDK can still work if ~/.claude/ has valid OAuth credentials,"
  info "but you'll want the CLI for interactive use too: https://docs.claude.com/claude-code"
fi

# ---------- 4. OAuth credentials ----------
step "Checking OAuth state"
if [[ ! -d "$HOME/.claude" ]]; then
  err "~/.claude/ does not exist — log in once with the CLI first:"
  info "    claude  (it will open a browser to log you in)"
  exit 1
fi
ok "~/.claude/ exists"
info "(actual credential validity is verified by the smoke test below)"

# ---------- 5. Install deps ----------
step "Installing npm dependencies"
if [[ -f package-lock.json ]]; then
  npm ci --silent || npm install --silent
else
  npm install --silent
fi
DEP_COUNTS="$(node -e 'const p=require("./package.json"); console.log(Object.keys(p.dependencies||{}).length+" runtime, "+Object.keys(p.devDependencies||{}).length+" dev")')"
ok "dependencies installed ($DEP_COUNTS)"

# ---------- 6. Smoke test ----------
step "Running OAuth smoke test"
SMOKE_LOG="$(mktemp -t claude-proxy-smoke.XXXXXX)"
if env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN npm run --silent smoke >"$SMOKE_LOG" 2>&1; then
  ok "smoke test passed — OAuth credentials accepted by the SDK"
  if grep -q "session_id" "$SMOKE_LOG"; then
    info "$(grep -m1 'session_id' "$SMOKE_LOG")"
  fi
else
  err "smoke test FAILED. Full log: $SMOKE_LOG"
  echo "${DIM}─── last 20 lines ───${RESET}"
  tail -20 "$SMOKE_LOG"
  echo "${DIM}──────────────────────${RESET}"
  info "Most common cause: not logged in. Run \`claude\` once to log in, then re-run this wizard."
  exit 1
fi

# ---------- 7. OpenClaw integration (manual snippet only) ----------
step "OpenClaw integration"
OPENCLAW_CFG="$HOME/.openclaw/openclaw.json"
PROVIDER_BASE_URL="http://$HOST:$PORT/v1"
PROVIDER_ID="${PROVIDER_ID:-localproxy}"
MODEL_ID="${MODEL_ID:-khoi-local}"

if [[ -f "$OPENCLAW_CFG" ]]; then
  ok "found existing OpenClaw config: $OPENCLAW_CFG"
else
  warn "no OpenClaw config at $OPENCLAW_CFG (skipping — install OpenClaw first if you want this)"
fi
echo
info "OpenClaw schema varies between versions, so this wizard does NOT auto-patch."
info "Open $OPENCLAW_CFG in your editor and add/merge the following under models.providers:"
echo
cat <<SNIPPET
    "$PROVIDER_ID": {
      "baseUrl": "$PROVIDER_BASE_URL",
      "apiKey": "$PROVIDER_ID",
      "api": "openai-completions",
      "models": [
        {
          "id": "$MODEL_ID",
          "name": "Khoi Local",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 8192
        }
      ]
    }
SNIPPET
echo
info "Optionally, to make it the default model, also set:"
info "  models.profile.primary               = \"$PROVIDER_ID/$MODEL_ID\""
info "  models.aliases[\"$PROVIDER_ID/$MODEL_ID\"]  = { \"alias\": \"$MODEL_ID\" }"
info "Restart OpenClaw afterward so it picks up the new provider."

# ---------- 8. Background service (optional) ----------
step "Background service (optional)"
PLATFORM="$(uname -s)"
LAUNCH_LABEL="com.kayo.claude-cli-proxy"
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"

case "$PLATFORM" in
  Darwin)
    PLIST_PATH="$HOME/Library/LaunchAgents/$LAUNCH_LABEL.plist"
    if ask "Generate a launchd plist so the server starts at login?" n; then
      mkdir -p "$(dirname "$PLIST_PATH")"
      cat >"$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LAUNCH_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NPM_BIN</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$REPO_DIR/server.out.log</string>
  <key>StandardErrorPath</key><string>$REPO_DIR/server.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST
      ok "wrote $PLIST_PATH"
      info "Load it with:"
      info "    launchctl unload \"$PLIST_PATH\" 2>/dev/null; launchctl load \"$PLIST_PATH\""
      info "Tail logs:"
      info "    tail -f \"$REPO_DIR/server.out.log\" \"$REPO_DIR/server.err.log\""
    else
      info "Skipped. Start manually with: cd \"$REPO_DIR\" && npm start"
    fi
    ;;
  Linux)
    UNIT_PATH="$HOME/.config/systemd/user/claude-cli-proxy.service"
    if ask "Generate a systemd user unit so the server starts at login?" n; then
      mkdir -p "$(dirname "$UNIT_PATH")"
      cat >"$UNIT_PATH" <<UNIT
[Unit]
Description=Claude CLI Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=$NPM_BIN start
Restart=on-failure
RestartSec=3
Environment=PATH=$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
UNIT
      ok "wrote $UNIT_PATH"
      info "Enable + start with:"
      info "    systemctl --user daemon-reload"
      info "    systemctl --user enable --now claude-cli-proxy"
      info "Tail logs:"
      info "    journalctl --user -u claude-cli-proxy -f"
    else
      info "Skipped. Start manually with: cd \"$REPO_DIR\" && npm start"
    fi
    ;;
  *)
    warn "Auto-start template not provided for $PLATFORM."
    info "Start manually with: cd \"$REPO_DIR\" && npm start"
    ;;
esac

# ---------- 9. Final summary ----------
hr
printf '%s\n' "${BOLD}${GREEN}Setup complete.${RESET}"
echo
echo "Start the server (foreground):"
echo "  ${CYAN}cd \"$REPO_DIR\" && npm start${RESET}"
echo
echo "Once running:"
echo "  ${CYAN}http://$HOST:$PORT/${RESET}                  landing page"
echo "  ${CYAN}http://$HOST:$PORT/docs${RESET}              Swagger UI"
echo "  ${CYAN}http://$HOST:$PORT/playground${RESET}        live SSE playground"
echo "  ${CYAN}http://$HOST:$PORT/v1/models${RESET}         OpenAI-compatible (model: $MODEL_ID)"
echo "  ${CYAN}http://$HOST:$PORT/health${RESET}            health check"
hr
