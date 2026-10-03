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
# Observed shapes (herdr 0.9.3): {"event":"workspace_closed","data":{"workspace_id":..}}
# plus .data.id / flat forms; the hook env also carries HERDR_PLUGIN_CONTEXT_JSON
# with a top-level workspace_id for api-sourced events.
ws=$(printf '%s' "${HERDR_PLUGIN_EVENT_JSON:-}" | jq -r '
  .data.workspace_id // .workspace_id // .data.id // .id // empty' 2>/dev/null)
[ -n "$ws" ] || ws=$(printf '%s' "${HERDR_PLUGIN_CONTEXT_JSON:-}" | jq -r '.workspace_id // empty' 2>/dev/null)
[ -n "$ws" ] || {
  keys=$(printf '%s' "${HERDR_PLUGIN_EVENT_JSON:-}" | jq -r 'keys? // [] | join(",")' 2>/dev/null)
  log "workspace.closed: no workspace id in event payload (keys: ${keys:-none})"
  exit 0
}

state_remove_ws "$ws"
exit 0
