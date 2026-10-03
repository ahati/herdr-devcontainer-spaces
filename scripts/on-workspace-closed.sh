#!/usr/bin/env bash
# on-workspace-closed.sh — [[event]] hook on workspace.closed.
# Drops the state mapping for the closed workspace and tombstones its folder so
# auto-scan does not resurrect a space the user deliberately closed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

load_config
state_init
require_cmds jq

# Event payload arrives as HERDR_PLUGIN_EVENT_JSON; tolerate shape drift.
ws=$(printf '%s' "${HERDR_PLUGIN_EVENT_JSON:-}" | jq -r '
  .workspace_id // .workspace.workspace_id // .id // empty' 2>/dev/null)
[ -n "$ws" ] || { log "workspace.closed: no workspace id in event payload"; exit 0; }

state_remove_ws "$ws"
exit 0
