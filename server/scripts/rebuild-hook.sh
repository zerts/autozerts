#!/usr/bin/env bash
# PostToolUse hook: rebuild the web UI and/or restart the Runner daemon after
# Claude edits a source file. Reads the hook JSON payload on stdin and only acts
# on files under web/ or server/ so unrelated edits stay fast.
#
# - web/ source change   → `bun run build:web` (server serves the built web/dist)
# - server/ source change → restart the launchd agent (no hot-reload in prod)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LABEL="com.autozerts.ai-runner"

# The file Claude just touched, from the PostToolUse payload.
payload="$(cat)"
file="$(printf '%s' "$payload" | /usr/bin/python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("file_path",""))' 2>/dev/null || true)"

[ -z "$file" ] && exit 0

# Only react to files inside this repo.
case "$file" in
  "$REPO_ROOT"/*) rel="${file#"$REPO_ROOT"/}" ;;
  *) exit 0 ;;
esac

did=""

# Web UI source (ignore generated output and the hook's own artifacts).
case "$rel" in
  web/dist/*|web/node_modules/*) : ;;
  web/*)
    echo "[rebuild-hook] web change ($rel) → bun run build:web" >&2
    (cd "$REPO_ROOT" && bun run build:web >&2)
    did="web"
    ;;
esac

# Server source → restart the daemon so the running process picks it up.
case "$rel" in
  server/src/*)
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
      echo "[rebuild-hook] server change ($rel) → restart $LABEL" >&2
      launchctl kickstart -k "gui/$(id -u)/$LABEL" >&2 || true
      did="${did:+$did+}server"
    fi
    ;;
esac

[ -n "$did" ] && echo "[rebuild-hook] done ($did)" >&2
exit 0
