#!/usr/bin/env bash
# watcher.sh — make ad-hoc agents inside devcontainers visible to Herdr.
#
# Herdr's process detection is host-side; a `claude` running inside a container is
# invisible (only the docker/podman exec client shows up). But the agent's UI flows
# through the host PTY unchanged, so its screen can be classified. This watcher:
#
#   1. polls panes in the devcontainer workspaces it manages
#   2. reads each pane's detection snapshot (`pane read --source detection`)
#   3. classifies it with `herdr agent explain --file ... --agent <kind> --json`
#      (reuses Herdr's own active screen manifests — no hand-rolled rules here)
#   4. reports matches as lifecycle authority via `pane report-agent`
#      (sidebar state, agent wait/prompt/read all work against the in-container agent)
#   5. releases authority via `pane release-agent` when the agent goes away
#
# Panes with a HERDR_AGENT hint (dedicated agent panes created by discover.sh) are
# owned by Herdr itself and skipped — a pane has exactly one authority.
#
# Lifecycle: single instance (flock); exits when the server is unreachable; the
# [[startup]] hook restarts it after session restore.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

load_config
state_init
require_cmds jq

LOCK="$SESSION_DIR/watcher.lock"          # per-session: one watcher per herdr session
exec 9>"$LOCK"
flock -n 9 || exit 0                        # already running for this session

WORKSPACE_DELAY="${WATCHER_GRACE_SECS:-2}"
log "watcher started (poll=${POLL_SECS}s)"

# classify <snap-file> <kind> -> echoes "<state>" if an explicit rule matched, else empty
classify() {
  local snap="$1" kind="$2" out state fallback
  out=$(hr agent explain --file "$snap" --agent "$kind" --json 2>/dev/null) || return 0
  state=$(printf '%s' "$out" | jq -r '.state // empty' 2>/dev/null)
  [ -n "$state" ] || return 0
  [ "$state" = "unknown" ] && return 0
  fallback=$(printf '%s' "$out" | jq -r '.idle_fallback_reason // .fallback_reason // empty' 2>/dev/null)
  [ -n "$fallback" ] && return 0            # fallback "idle" is not evidence of an agent
  printf '%s\n' "$state"
}

pane_seq() { jq -r --arg p "$1" '.[$p].seq // 0' "$PANES_FILE" 2>/dev/null || echo 0; }

panes_set() {  # <pane> <agent> <state>
  state_with_lock bash -c '
    file="$1"; pane="$2"; agent="$3"; state="$4"; seq="$5"
    jq --arg p "$pane" --arg a "$agent" --arg s "$state" --arg q "$seq" \
       ".[\$p] = {agent:\$a, state:\$s, seq:(\$q | tonumber)}" \
       "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  ' _ "$PANES_FILE" "$1" "$2" "$3" "$4"
}

panes_del() {  # <pane>
  state_with_lock bash -c '
    file="$1"; pane="$2"
    jq "del(.[\$pane])" --arg pane "$pane" "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  ' _ "$PANES_FILE" "$1"
}

while true; do
  sleep "$POLL_SECS"

  mapfile -t ROWS < <(jq -r 'to_entries[] | "\(.value.workspace_id)\t\(.key)\t\(.value.agents // [] | join(" "))"' "$STATE_FILE" 2>/dev/null)
  [ ${#ROWS[@]} -eq 0 ] && continue

  # herdr 0.9.3: `pane list` prints JSON by default (no --json flag). A failed
  # command is not a dead server — probe liveness once before giving up.
  if ! listing=$(hr pane list 2>/dev/null); then
    if ! hr api schema >/dev/null 2>&1; then
      log "herdr unreachable; watcher exiting (startup hook will restart it)"
      exit 0
    fi
    continue                                # transient command failure; retry next poll
  fi

  for row in "${ROWS[@]}"; do
    IFS=$'\t' read -r ws folder kinds <<<"$row"
    [ -n "$ws" ] || continue
    ws_alive "$ws" || continue                # workspace closed; event hook will clean up

    # Managed panes: pane_id<TAB>label. Shape tolerated for .result.panes[] or .result[].
    mapfile -t PANES < <(printf '%s' "$listing" | jq -r '
      (.result.panes // .result // [])[]?
      | select(.workspace_id == $ws)
      | "\(.pane_id)\t\(.label // "")"' --arg ws "$ws" 2>/dev/null)

    for pl in "${PANES[@]}"; do
      IFS=$'\t' read -r pane label <<<"$pl"
      [ -n "$pane" ] || continue

      # Dedicated agent panes carry an agent-kind label and a HERDR_AGENT env hint:
      # Herdr owns them; we must not fight for authority.
      skip=0
      for k in $kinds; do [ "$label" = "$k" ] && skip=1; done
      [ "$skip" = 1 ] && continue

      snap="$STATE_DIR/.snap.$pane"
      if ! hr pane read "$pane" --source detection > "$snap" 2>/dev/null; then
        rm -f "$snap"
        prev=$(jq -r --arg p "$pane" '.[$p].agent // empty' "$PANES_FILE" 2>/dev/null)
        if [ -n "$prev" ]; then               # pane died while we held authority
          hr pane release-agent "$pane" --source custom:devcontainer --agent "$prev" >/dev/null 2>&1 || true
          panes_del "$pane"
          log "pane $pane gone; released $prev"
        fi
        continue
      fi

      best_kind="" best_state=""
      for k in $kinds; do
        if st=$(classify "$snap" "$k"); [ -n "$st" ]; then
          best_kind="$k" best_state="$st"
          break
        fi
      done
      rm -f "$snap"

      prev=$(jq -r --arg p "$pane" '.[$p].agent // empty' "$PANES_FILE" 2>/dev/null)
      prev_state=$(jq -r --arg p "$pane" '.[$p].state // empty' "$PANES_FILE" 2>/dev/null)

      if [ -n "$best_kind" ]; then
        if [ "$best_kind" != "$prev" ] || [ "$best_state" != "$prev_state" ]; then
          if [ -n "$prev" ] && [ "$prev" != "$best_kind" ]; then
            # a different agent took over the pane; end the previous authority first
            hr pane release-agent "$pane" --source custom:devcontainer --agent "$prev" >/dev/null 2>&1 || true
          fi
          seq=$(( $(pane_seq "$pane") + 1 ))
          if hr pane report-agent "$pane" \
               --source custom:devcontainer --agent "$best_kind" \
               --state "$best_state" --seq "$seq" >/dev/null 2>&1; then
            panes_set "$pane" "$best_kind" "$best_state" "$seq"
            log "pane $pane: agent=$best_kind state=$best_state"
          fi
        fi
      elif [ -n "$prev" ]; then
        seq=$(( $(pane_seq "$pane") + 1 ))
        hr pane release-agent "$pane" --source custom:devcontainer --agent "$prev" >/dev/null 2>&1 || true
        panes_del "$pane"
        log "pane $pane: released $prev (no agent on screen)"
      fi
    done
  done
done
