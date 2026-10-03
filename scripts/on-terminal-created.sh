#!/usr/bin/env bash
# on-terminal-created.sh — [[event]] hooks on tab_created / pane_created.
# Keeps every terminal of a managed (devcontainer) space inside the container:
#   * tab_created  → replace the fresh tab with an in-container shell tree
#                    (layout.apply tab mode: herdr opens the replacement, then
#                    closes the original — a brief flicker is expected)
#   * pane_created → a split of a tab we manage execs into the container
# Panes/tabs the plugin itself created carry labels (shell, agent kinds,
# "devcontainer shell") and are skipped — one authority, no loops. Panes in
# workspaces we do not manage are never touched.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

load_config
state_init
require_cmds jq

ev_type=$(printf '%s' "${HERDR_PLUGIN_EVENT_JSON:-}" | jq -r '.data.type // .event // empty' 2>/dev/null)
data=$(printf '%s' "${HERDR_PLUGIN_EVENT_JSON:-}" | jq -c '.data // empty' 2>/dev/null)

# labels_we_use <workspace_id> — "shell" + the space's agent kinds.
labels_we_use() {
  printf 'shell %s\n' "$(state_agents_for_ws "$1")"
}

# tab_has_our_pane <tab_id> <workspace_id> — any pane of the tab carries one of
# our labels (i.e. the tab/tree already belongs to the plugin).
tab_has_our_pane() {
  local tab="$1" ws="$2" labels p pl
  labels=$(labels_we_use "$ws")
  local listing
  listing=$(hr pane list 2>/dev/null) || return 1
  for pl in $(printf '%s' "$listing" | jq -r --arg tab "$tab" \
      '(.result.panes // .result // [])[]? | select(.tab_id == $tab) | (.label // "")' 2>/dev/null); do
    for p in $labels; do [ "$pl" = "$p" ] && return 0; done
  done
  return 1
}

case "$ev_type" in
  tab_created)
    ws=$(printf '%s' "$data" | jq -r '.tab.workspace_id // empty' 2>/dev/null)
    tab=$(printf '%s' "$data" | jq -r '.tab.tab_id // empty' 2>/dev/null)
    [ -n "$ws" ] && [ -n "$tab" ] || exit 0
    folder=$(state_folder_for_ws "$ws")
    [ -n "$folder" ] || exit 0                     # not a managed space
    if tab_has_our_pane "$tab" "$ws"; then exit 0; fi   # already ours — no loops
    if tree=$(layout_tree "$folder" ""); then
      if layout_apply_tab "$tab" "$TAB_LABEL" "$tree"; then
        log "tab $tab: converted to devcontainer shell ($folder)"
      fi
    fi
    ;;

  pane_created)
    pane=$(printf '%s' "$data" | jq -r '.pane.pane_id // empty' 2>/dev/null)
    ws=$(printf '%s' "$data" | jq -r '.pane.workspace_id // empty' 2>/dev/null)
    tab=$(printf '%s' "$data" | jq -r '.pane.tab_id // empty' 2>/dev/null)
    label=$(printf '%s' "$data" | jq -r '.pane.label // empty' 2>/dev/null)
    [ -n "$pane" ] && [ -n "$ws" ] && [ -n "$tab" ] || exit 0
    [ -z "$label" ] || exit 0                       # plugin panes are labeled
    folder=$(state_folder_for_ws "$ws")
    [ -n "$folder" ] || exit 0                      # not a managed space
    # Only convert splits of tabs we already manage. The root pane of a brand-new
    # native tab has no "shell" pane yet — the tab_created hook replaces that tab
    # wholesale, so typing an exec into it would only race the replacement.
    tab_has_our_pane "$tab" "$ws" || exit 0
    hr pane run "$pane" "exec devcontainer exec --workspace-folder '$folder' bash" >/dev/null 2>&1 \
      && log "pane $pane: exec into devcontainer ($folder)"
    ;;

  *) exit 0 ;;
esac
