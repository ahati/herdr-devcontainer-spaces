#!/usr/bin/env bash
# open-shell.sh — action "shell-here": open an in-container shell pane in the
# current workspace via the plugin's dc-shell entrypoint.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

load_config
state_init
require_cmds jq

ws=$(current_workspace_id)
[ -n "$ws" ] || { log "no workspace context; open a devcontainer space first"; exit 1; }

folder=$(jq -r --arg ws "$ws" 'to_entries[] | select(.value.workspace_id==$ws) | .key' "$STATE_FILE" 2>/dev/null | head -1)
if [ -z "$folder" ]; then
  # Not a tracked space: fall back to the current workspace's cwd if it is one.
  folder=$(printf '%s' "${HERDR_PLUGIN_CONTEXT_JSON:-}" | jq -r '.worktree.path // .cwd // empty' 2>/dev/null)
  [ -n "$folder" ] || { log "workspace $ws is not a devcontainer space"; exit 1; }
fi

log "opening devcontainer shell for $folder in $ws"
out=$(pane_open_fallback "$ws" dc-shell "DEVCONTAINER_FOLDER=$folder") \
  || die "plugin pane open failed: $out"
log "opened devcontainer shell pane ($out) in $ws"
