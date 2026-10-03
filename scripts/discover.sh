#!/usr/bin/env bash
# discover.sh — enumerate devcontainers and create/repair Herdr spaces.
#
# Runs as the `rescan` action and from startup.sh. Idempotent:
#   * tracked + alive workspaces are left alone
#   * user-closed (tombstoned) folders are never resurrected by auto-scan
#   * `--resurrect` clears tombstones for folders that reappear
#
# Engine support: docker and podman, rootless or rootful (see lib.sh engine_detect).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

RESURRECT=0
[ "${1:-}" = "--resurrect" ] && RESURRECT=1

require_cmds jq
load_config
state_init

if ! engine_detect; then
  die "no working container engine found (tried docker, podman). Install docker or podman, or pin [settings.env] ENGINE=docker|podman in $CONFIG_DIR"
fi

# Serialize concurrent rescans: the [[startup]] hook and a user-invoked rescan can
# overlap; without this, both see "no mapping" and create duplicate spaces.
exec 8>"$SESSION_DIR/rescan.lock"
flock -w 60 8 || die "another rescan is holding the lock"

log "engine: $(engine_describe); user-scope filter: $(
  [ "$ROOTLESS" = 1 ] && echo 'engine is user-scoped (rootless); \$HOME check is a sanity pass' || echo '\$HOME path heuristic (shared engine)'
)"

command -v devcontainer >/dev/null 2>&1 || warn "devcontainer CLI not found — spaces will be created, but shells cannot exec until it is installed"

RESURRECT_NOTE=0
created_count=0

while IFS=$'\t' read -r cid state folder config; do
  [ -n "${folder:-}" ] && [ "$folder" != "null" ] || continue

  # --- same-user filter -----------------------------------------------------
  if [ "$ROOTLESS" != 1 ]; then
    case "$folder" in
      "$HOME"/*) ;;                                       # under our home: fine
      *) warn "skip $folder (label outside \$HOME on a shared engine)"; continue ;;
    esac
  elif [ "${folder#"$HOME"}" = "$folder" ] && [ "$folder" != "$HOME" ]; then
    log "note: $folder outside \$HOME (engine is rootless; container belongs to this user)"
  fi
  [ -d "$folder" ] || { warn "skip $cid (workspace folder gone: $folder)"; continue; }

  # --- tombstones -----------------------------------------------------------
  if [ -e "$(tombstone_path "$folder")" ]; then
    if [ "$RESURRECT" = 1 ]; then
      rm -f "$(tombstone_path "$folder")"; RESURRECT_NOTE=1
      log "resurrecting $folder (tombstone cleared)"
    else
      log "skip $folder (tombstoned: closed by user; use 'resurrect' to clear)"
      continue
    fi
  fi

  # --- already tracked? -----------------------------------------------------
  ws=$(jq -r --arg f "$folder" '.[$f].workspace_id // empty' "$STATE_FILE" || true)
  if [ -n "$ws" ]; then
    if ws_alive "$ws"; then
      log "tracked: $folder -> $ws"
      continue
    fi
    log "stale mapping for $folder (workspace $ws gone); will recreate"
    state_with_lock bash -c '
      file="$1"; folder="$2"
      jq "del(.[\$folder])" --arg folder "$folder" "$file" > "$file.tmp" && mv "$file.tmp" "$file"
    ' _ "$STATE_FILE" "$folder"
  fi

  # --- container state ------------------------------------------------------
  if [ "$state" != "running" ]; then
    if [ "$AUTO_START_CONTAINERS" = 1 ]; then
      log "starting container for $folder (devcontainer up; this can take a while on first build)"
      dc up --workspace-folder "$folder" || { warn "devcontainer up failed for $folder"; continue; }
    else
      log "skip $folder (container $state; enable AUTO_START_CONTAINERS=1 in settings.env or start it manually)"
      continue
    fi
  fi

  # --- probe available agents inside the container --------------------------
  kinds=""
  if command -v devcontainer >/dev/null 2>&1; then
    kinds=$(dc_probe_agents "$folder" $AGENTS || true)
    log "agents present in $folder:${kinds:- none}"
  fi
  kind=${kinds%% *}

  # --- create the space ------------------------------------------------------
  if ws=$(space_create "$folder" "$kind"); then
    state_upsert "$folder" "$ws" "$cid" "$kinds"
    created_count=$((created_count + 1))
  fi
done < <(dc_list)

[ "$RESURRECT_NOTE" = 1 ] && log "tombstones cleared; closed spaces may be recreated on next rescan"
log "rescan done (created: $created_count)"
