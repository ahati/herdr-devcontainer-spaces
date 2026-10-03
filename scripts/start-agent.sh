#!/usr/bin/env bash
# start-agent.sh — action "agent-here": open a dedicated pane that runs an agent
# inside the container, carrying the HERDR_AGENT hint so Herdr screen-detects it.
# Chooses the first agent kind probed as present for this devcontainer.
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
[ -n "$folder" ] || { log "workspace $ws is not a devcontainer space"; exit 1; }

kinds=$(jq -r --arg ws "$ws" '[to_entries[] | select(.value.workspace_id==$ws) | .value.agents[]] | first // empty' "$STATE_FILE" 2>/dev/null)
if [ -z "$kinds" ]; then
  command -v devcontainer >/dev/null 2>&1 || { log "devcontainer CLI missing; cannot probe agents"; exit 1; }
  engine_detect || { log "no container engine"; exit 1; }
  kinds=$(dc_probe_agents "$folder" $AGENTS | awk '{print $1}')
fi
[ -n "$kinds" ] || { log "no supported agent binary found in the container for $folder"; exit 1; }

kind="$kinds"
log "opening $kind pane for $folder in $ws"
out=$(pane_open_fallback "$ws" dc-agent \
  "DEVCONTAINER_FOLDER=$folder" "DC_AGENT_KIND=$kind" "HERDR_AGENT=$kind") \
  || die "plugin pane open failed: $out"
log "opened $kind pane ($out) in $ws"
