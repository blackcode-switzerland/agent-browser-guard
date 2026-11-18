#!/bin/sh
# agent-browser-guard, per-person install for macOS and Linux. No administrator rights.
#
#   Install or update:   sh install/install.sh
#   Check only:          sh install/install.sh --check-only
#   Without registering: sh install/install.sh --no-register
#
# Copies the tool to your own application-support folder, fetches its one dependency (Microsoft's
# Playwright MCP server) and Playwright's own Chromium, registers the tool server "agent-browser-guard"
# in Claude Code and Codex (when installed) and runs a check. Needs Node.js 18 or newer.
# It never touches your Chrome, Safari or Edge or their profiles.
set -eu
NAME=agent-browser-guard
SOURCE=$(cd "$(dirname "$0")/.." && pwd)
case "$(uname -s)" in
  Darwin) ROOT="${AGENT_BROWSER_GUARD_ROOT:-$HOME/Library/Application Support/AgentBrowserGuard}" ;;
  *)      ROOT="${AGENT_BROWSER_GUARD_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-browser-guard}" ;;
esac
CHECK_ONLY=0; REGISTER=1
for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=1 ;;
    --no-register) REGISTER=0 ;;
    *) echo "unknown option: $arg"; exit 2 ;;
  esac
done
mkdir -p "$ROOT"
LOG="$ROOT/install.log"

if ! command -v node >/dev/null 2>&1; then echo "NOT OK: Node.js is not installed. Get the LTS version from https://nodejs.org, then run this script again."; exit 1; fi
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 18 ]; then echo "NOT OK: Node.js $MAJOR is too old; version 18 or newer is needed."; exit 1; fi

if [ "$CHECK_ONLY" = 1 ]; then
  if [ ! -f "$ROOT/current.txt" ]; then echo "NOT OK: agent-browser-guard is not installed for this user."; exit 1; fi
  RESULT=$(node "$(cat "$ROOT/current.txt")/agent-browser-guard.mjs" check 2>&1 | tail -n 1)
  echo "$RESULT"; case "$RESULT" in OK*) exit 0 ;; *) exit 1 ;; esac
fi

VERSION=$(node -p 'require(process.argv[1]).version' "$SOURCE/package.json")
TARGET="$ROOT/$VERSION"
PREVIOUS=""; [ -f "$ROOT/current.txt" ] && PREVIOUS=$(cat "$ROOT/current.txt")
echo "agent-browser-guard $VERSION -> $TARGET"
rm -rf "$TARGET"; mkdir -p "$TARGET"
for item in agent-browser-guard.mjs package.json package-lock.json lib guard LICENSE README.md; do
  [ -e "$SOURCE/$item" ] && cp -R "$SOURCE/$item" "$TARGET/"
done

echo "  Fetching the Playwright MCP server (npm)..."
if ! (cd "$TARGET" && npm ci --omit=dev --no-audit --no-fund >>"$LOG" 2>&1); then echo "NOT OK: npm could not fetch the dependency. Details: $LOG"; exit 1; fi
echo "  Fetching Playwright's own Chromium (about 150 MB the first time)..."
if ! (cd "$TARGET" && npx --no-install playwright install chromium >>"$LOG" 2>&1); then echo "NOT OK: the Chromium download failed. Details: $LOG"; exit 1; fi

RESULT=$(node "$TARGET/agent-browser-guard.mjs" check 2>&1 | tail -n 1)
case "$RESULT" in
  OK*) ;;
  *) rm -rf "$TARGET"; echo "$RESULT"; echo "Nothing was changed: the previous version (if any) is still the registered one."; exit 1 ;;
esac
printf '%s\n' "$TARGET" > "$ROOT/current.txt"
for dir in "$ROOT"/*/; do
  dir=${dir%/}
  [ "$dir" = "$TARGET" ] || [ "$dir" = "$PREVIOUS" ] || rm -rf "$dir"
done

if [ "$REGISTER" = 0 ]; then echo "  Not registered (--no-register)."
else
  WHERE=""
  if command -v claude >/dev/null 2>&1; then
    claude mcp remove "$NAME" -s user >>"$LOG" 2>&1 || true
    if claude mcp add -s user "$NAME" -- node "$TARGET/agent-browser-guard.mjs" mcp >>"$LOG" 2>&1; then WHERE="Claude Code"; else echo "  Claude Code: registration FAILED."; fi
  else echo "  Claude Code is not installed here: skipped."; fi
  if command -v codex >/dev/null 2>&1; then
    codex mcp remove "$NAME" >>"$LOG" 2>&1 || true
    if codex mcp add "$NAME" -- node "$TARGET/agent-browser-guard.mjs" mcp >>"$LOG" 2>&1; then WHERE="${WHERE:+$WHERE, }Codex"; else echo "  Codex: registration FAILED."; fi
  else echo "  Codex is not installed here: skipped."; fi
  if [ -n "$WHERE" ]; then echo "  Registered as tool server \"$NAME\" in: $WHERE."; else echo "  Registered nowhere."; fi
fi
echo "$RESULT"
echo "To sign in to a site yourself:  node \"$TARGET/agent-browser-guard.mjs\" sign-in https://..."
