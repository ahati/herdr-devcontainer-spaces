#!/usr/bin/env bash
# lib.sh — shared helpers for the Devcontainer Spaces plugin.
#
# Sourced by every entrypoint script. Provides:
#   * logging + die
#   * config loading          (HERDR_PLUGIN_CONFIG_DIR/settings.env)
#   * herdr CLI wrapper       (hr — uses HERDR_BIN_PATH)
#   * state directory helpers (HERDR_PLUGIN_STATE_DIR, flock-guarded mutations)
#   * ENGINE ABSTRACTION      (docker | podman, rootless detection, docker/podman only)
#   * devcontainer CLI backend resolution (DOCKER_HOST / podman socket / scoped shim)
#   * devcontainer discovery  (dc_list — portable across docker and podman)
#
# External requirements: bash 4+, jq, and at least one of: docker, podman.
# The devcontainer CLI is required only for actions that exec into containers.

# ---------------------------------------------------------------- shell setup --
# Callers use `set -euo pipefail`; lib stays tolerant because it is sourced.

PLUGIN_ID="${HERDR_PLUGIN_ID:-devcontainer-spaces}"

log()  { printf '[%s] %s\n' "$PLUGIN_ID" "$*" >&2; }
warn() { log "WARN: $*"; }
die()  { log "ERROR: $*"; exit 1; }

require_cmds() {
  local missing=() c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  ((${#missing[@]} == 0)) || die "missing required commands: ${missing[*]}"
}

# ------------------------------------------------------------------- config --
# settings.env format (sourced): KEY=VALUE lines, comments with '#'.
#   ENGINE=auto|docker|podman
#   AUTO_CREATE_SPACES=1|0
#   AUTO_START_CONTAINERS=1|0        # run `devcontainer up` for stopped containers
#   AGENTS="claude codex gemini cursor opencode copilot agy"
#   TAB_LABEL=devcontainer
#   POLL_SECS=3

CONFIG_DIR="${HERDR_PLUGIN_CONFIG_DIR:-$HOME/.config/herdr/plugins/devcontainer-spaces}"
STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-$HOME/.local/state/herdr/plugins/devcontainer-spaces}"
CONFIG_FILE="$CONFIG_DIR/settings.env"

ENGINE=auto
AUTO_CREATE_SPACES=1
AUTO_START_CONTAINERS=0
AGENTS="claude codex gemini cursor opencode copilot agy"
TAB_LABEL="devcontainer"
POLL_SECS="${POLL_SECS:-3}"   # default 3s; env may pre-set (tests), settings.env overrides

load_config() {
  mkdir -p "$STATE_DIR"
  [ -f "$CONFIG_FILE" ] || return 0
  # shellcheck disable=SC1090  # user-owned config dir; documented KEY=VALUE format
  source "$CONFIG_FILE"
}

# ------------------------------------------------------------------- herdr ---
HERDR_BIN="${HERDR_BIN_PATH:-herdr}"

hr() { "$HERDR_BIN" "$@"; }

# herdr_socket — best-effort path of the current session's API socket.
# Precedence: explicit HERDR_SOCKET_PATH, then the named session's socket
# (plugin children always carry HERDR_SESSION; the default session's socket lives
# at the legacy primary path), then the primary path.
herdr_socket() {
  if [ -n "${HERDR_SOCKET_PATH:-}" ]; then printf '%s\n' "$HERDR_SOCKET_PATH"; return 0; fi
  local f
  if [ -n "${HERDR_SESSION:-}" ] && [ "${HERDR_SESSION}" != "default" ]; then
    f="$HOME/.config/herdr/sessions/$HERDR_SESSION/herdr.sock"
    if [ -S "$f" ]; then printf '%s\n' "$f"; return 0; fi
  fi
  f="$HOME/.config/herdr/herdr.sock"
  [ -S "$f" ] || return 1
  printf '%s\n' "$f"
}

# api_request <method> <params-json> [timeout-ms]
# Sends one NDJSON request over the herdr socket. The herdr CLI has no raw passthrough
# (only `api snapshot`/`schema`), so we speak the documented newline-delimited JSON
# protocol ourselves via node or python3. Prints the response object; rc=2 on API error.
api_request() {
  local method="$1" params="$2" timeout_ms="${3:-15000}"
  # Test seam: unit tests substitute a recording stub for the socket client.
  if [ -n "${HERDR_API_STUB:-}" ]; then "$HERDR_API_STUB" "$method" "$params"; return $?; fi
  local sock; sock=$(herdr_socket) || { warn "herdr socket not found"; return 1; }
  local rid="dcsp-$$-$RANDOM"
  if command -v node >/dev/null 2>&1; then
    node -e '
      const net = require("net");
      const [sock, rid, method, params, tmo] = process.argv.slice(1);
      const s = net.connect(sock);
      let buf = "";
      const done = (code, obj) => { try { if (obj) process.stdout.write(JSON.stringify(obj) + "\n"); } catch {} s.destroy(); process.exit(code); };
      const t = setTimeout(() => done(4), Number(tmo || 15000)); t.unref();
      s.on("connect", () => s.write(JSON.stringify({ id: rid, method, params: JSON.parse(params) }) + "\n"));
      s.on("data", (d) => {
        buf += d; let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.id === rid) { clearTimeout(t); done(o.error ? 2 : 0, o); }
        }
      });
      s.on("error", () => { clearTimeout(t); done(3); });
    ' "$sock" "$rid" "$method" "$params" "$timeout_ms"
    return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$sock" "$rid" "$method" "$params" "$timeout_ms" <<'PYEOF'
import json, socket, sys
sock, rid, method, params, tmo = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(tmo / 1000.0)
s.connect(sock)
s.sendall((json.dumps({"id": rid, "method": method, "params": json.loads(params)}) + "\n").encode())
buf = b""
while True:
    d = s.recv(65536)
    if not d:
        sys.exit(5)
    buf += d
    while b"\n" in buf:
        line, buf = buf.split(b"\n", 1)
        if not line.strip():
            continue
        o = json.loads(line)
        if o.get("id") == rid:
            print(json.dumps(o))
            sys.exit(2 if "error" in o else 0)
PYEOF
    return $?
  fi
  warn "need node or python3 for raw socket API (layout.apply)"; return 1
}

# layout_apply <workspace_id> <label> <root-tree-json> — replace the default root tab
# with a declarative tree. api schema: LayoutApplyParams takes tab_id XOR workspace_id;
# we pass workspace_id only (fresh tab in the workspace we just created).
layout_apply() {
  local ws="$1" label="$2" tree="$3" payload resp
  payload=$(jq -n --arg ws "$ws" --arg l "$label" --argjson root "$tree" \
    '{workspace_id:$ws, tab_label:$l, focus:false, root:$root}')
  if ! resp=$(api_request layout.apply "$payload"); then
    [ -n "$resp" ] && log "layout.apply: $(printf '%s' "$resp" | jq -r '.error.message // "failed"' 2>/dev/null)"
    return 1
  fi
  return 0
}

# ------------------------------------------------------------------- state ---
# Session-scoped state: workspace ids (w1..) collide across herdr sessions and the
# watcher is one-per-session, so per-session files live under sessions/<name>/.
# Tombstones and the engine shim stay at the top level (cross-session user intent /
# engine-level). HERDR_SESSION is provided to plugin children by herdr 0.9.3.
SESSION_NAME="${HERDR_SESSION:-default}"
SESSION_DIR="$STATE_DIR/sessions/$SESSION_NAME"
STATE_FILE="$SESSION_DIR/containers.json"   # folder -> {workspace_id,container_id,state,agents[]}
PANES_FILE="$SESSION_DIR/panes.json"        # pane_id -> {agent,state,seq}
STATE_LOCK="$SESSION_DIR/.lock"

state_init() {
  mkdir -p "$SESSION_DIR"
  [ -f "$STATE_FILE" ] || printf '{}' > "$STATE_FILE"
  [ -f "$PANES_FILE" ] || printf '{}' > "$PANES_FILE"
}

# state_with_lock <cmd...> — serialize mutations across watcher + actions.
state_with_lock() {
  mkdir -p "$SESSION_DIR"
  ( flock -x 9; "$@" ) 9>>"$STATE_LOCK"
}

tombstone_path() {                       # <folder> -> state path for its tombstone
  printf '%s/%s.closed' "$STATE_DIR" "$(printf '%s' "$1" | md5sum | cut -d' ' -f1)"
}

# ------------------------------------------------------------------ engine ---
# Resolves ENGINE (docker|podman) and ROOTLESS (1|0). Order: config pin -> docker -> podman.
# A `docker` binary that is itself a podman shim is fine: we only need a working
# docker-compatible endpoint. We record ENGINE_FLAVOR for logging.

ENGINE=""
ENGINE_FLAVOR=""
ROOTLESS=0

_engine_ok() { "$1" version >/dev/null 2>&1; }

_engine_rootless_docker() {
  local ctx
  ctx=$("$1" context show 2>/dev/null || true)
  [ "$ctx" = "rootless" ] && return 0
  case "${DOCKER_HOST:-}" in
    *"//run/user/"*) return 0 ;;
  esac
  return 1
}

engine_detect() {
  local candidates=() cli
  case "${ENGINE:-auto}" in
    docker) candidates=(docker) ;;
    podman) candidates=(podman) ;;
    *)      candidates=(docker podman) ;;
  esac
  for cli in "${candidates[@]}"; do
    command -v "$cli" >/dev/null 2>&1 || continue
    _engine_ok "$cli" || continue
    ENGINE="$cli"
    if [ "$cli" = podman ]; then
      ENGINE_FLAVOR="podman"
      ROOTLESS=$([ "$(podman info -f '{{.Host.Security.Rootless}}' 2>/dev/null)" = true ] && echo 1 || echo 0)
    else
      # Distinguish a real docker from a podman shim for honest logging only.
      if docker info -f '{{.ServerVersion}}' 2>/dev/null | grep -qi . \
         && ! docker info -f '{{.OperatingSystem}}' 2>/dev/null | grep -qi podman; then
        ENGINE_FLAVOR="docker"
      else
        ENGINE_FLAVOR="podman-via-shim"
      fi
      if _engine_rootless_docker "$cli"; then ROOTLESS=1; else ROOTLESS=0; fi
    fi
    # Rootless engines need XDG_RUNTIME_DIR for socket paths; derive if unset.
    [ -n "${XDG_RUNTIME_DIR:-}" ] || export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    return 0
  done
  return 1
}

engine_describe() {
  local mode="rootful"
  [ "$ROOTLESS" = 1 ] && mode="rootless"
  printf '%s (%s, %s)' "$ENGINE" "$ENGINE_FLAVOR" "$mode"
}

# dc_list — TSV lines: <container_id>\t<state>\t<local_folder>\t<config_file>
# Portable across docker/podman: IDs via label filter (identical syntax), details via
# inspect+jq-free Go templates (identical on both engines).
dc_list() {
  local ids id
  ids=$("$ENGINE" ps -a --filter label=devcontainer.local_folder --format '{{.ID}}' 2>/dev/null) || return 0
  for id in $ids; do
    local state folder config
    state=$("$ENGINE" inspect -f '{{.State.Status}}' "$id" 2>/dev/null) || continue
    folder=$("$ENGINE" inspect -f '{{index .Config.Labels "devcontainer.local_folder"}}' "$id" 2>/dev/null)
    config=$("$ENGINE" inspect -f '{{index .Config.Labels "devcontainer.config_file"}}' "$id" 2>/dev/null)
    printf '%s\t%s\t%s\t%s\n' "$id" "$state" "$folder" "$config"
  done
}

# ------------------------------------------------- devcontainer CLI backend --
# The `devcontainer` CLI shells out to a docker-compatible binary. Resolution order:
#   1. a working `docker` on PATH (real docker or an existing shim)   -> nothing to do
#   2. DOCKER_HOST already set                                        -> nothing to do
#   3. podman API socket present                                      -> DOCKER_HOST=that socket
#   4. generate a plugin-scoped `docker`->podman shim                 -> PATH prefix
# Never modifies the user's PATH. Returns "KEY=VALUE" assignments via DC_ENV array.

SHIM_DIR="$STATE_DIR/shim"

dc_env() {
  DC_ENV=()
  if [ "$ENGINE" = docker ] || command -v docker >/dev/null 2>&1; then return 0; fi
  if [ -n "${DOCKER_HOST:-}" ]; then return 0; fi
  local sock="${XDG_RUNTIME_DIR}/podman/podman.sock"
  if [ -S "$sock" ]; then
    DC_ENV=("DOCKER_HOST=unix://$sock")
    return 0
  fi
  mkdir -p "$SHIM_DIR"
  printf '#!/bin/sh\nexec podman "$@"\n' > "$SHIM_DIR/docker"
  chmod +x "$SHIM_DIR/docker"
  DC_ENV=("PATH=$SHIM_DIR:$PATH")
  return 0
}

# dc <args...> — run the devcontainer CLI with the resolved backend.
dc() {
  local -a pre=()
  dc_env || return 1
  ((${#DC_ENV[@]})) && pre=("${DC_ENV[@]}")
  env "${pre[@]}" devcontainer "$@"
}

dc_exec() {  # <workspace-folder> <cmd...>
  local folder="$1"; shift
  dc exec --workspace-folder "$folder" "$@"
}

# current_workspace_id — workspace id from the plugin context (TUI palette) or,
# failing that, from the HERDR_PANE_ID prefix (<ws>:<n>) that herdr 0.9.3 exports
# to plugin children even for CLI invocations. Prints empty when unavailable.
current_workspace_id() {
  local ws
  ws=$(printf '%s' "${HERDR_PLUGIN_CONTEXT_JSON:-}" | jq -r '.workspace_id // empty' 2>/dev/null)
  if [ -z "$ws" ] && [ -n "${HERDR_PANE_ID:-}" ]; then ws="${HERDR_PANE_ID%%:*}"; fi
  printf '%s' "$ws"
}

# pane_open_fallback <workspace_id> <entrypoint> <env-assignments...>
# herdr 0.9.3: split/zoomed plugin panes require an existing target pane; some
# builds also fail to forward --target-pane. Try split (targeting the workspace's
# first pane), then fall back to a plain tab. Prints "split" or "tab" on success;
# on failure prints the CLI output and returns 1.
pane_open_fallback() {
  local ws="$1" entry="$2"; shift 2
  local -a envs=() a target out
  for a in "$@"; do envs+=(--env "$a"); done
  if target=$(hr pane list 2>/dev/null | jq -r --arg ws "$ws" \
      '(.result.panes // .result // [])[]? | select(.workspace_id == $ws) | .pane_id' 2>/dev/null | head -1) \
     && [ -n "$target" ]; then
    out=$(hr plugin pane open --plugin "$PLUGIN_ID" --entrypoint "$entry" \
      --workspace "$ws" --placement split --target-pane "$target" --direction right --no-focus \
      "${envs[@]}" 2>&1) || true
    case "$out" in *plugin_pane_opened*) printf 'split'; return 0;; esac
  fi
  out=$(hr plugin pane open --plugin "$PLUGIN_ID" --entrypoint "$entry" \
    --workspace "$ws" --placement tab --no-focus "${envs[@]}" 2>&1) || true
  case "$out" in *plugin_pane_opened*) printf 'tab'; return 0;; esac
  printf '%s' "$out"
  return 1
}

# dc_probe_agents <folder> <kinds...> — echo the subset of kinds with binaries present.
dc_probe_agents() {
  local folder="$1"; shift
  local kind out=""
  for kind in "$@"; do
    if dc_exec "$folder" sh -lc "command -v $(printf '%s' "$kind" | sed 's/[^a-z0-9_-]//g')" >/dev/null 2>&1; then
      out="$out $kind"
    fi
  done
  printf '%s\n' "${out# }"
}

# ---------------------------------------------------------------- space ops --
# ws_alive <workspace_id> -> 0 if the workspace still exists
ws_alive() { hr workspace get "$1" >/dev/null 2>&1; }

# layout_tree <folder> <agent-kind-or-empty> — declarative tab for a devcontainer.
# Shell pane on the left; if an agent kind is given, a dedicated agent pane on the
# right carrying the HERDR_AGENT hint so Herdr screen-detects it across the boundary.
layout_tree() {
  local folder="$1" kind="$2"
  if [ -n "$kind" ]; then
    jq -n --arg f "$folder" --arg k "$kind" '{
      type: "split", direction: "right", ratio: 0.65,
      first: {
        type: "pane", label: "shell", cwd: $f,
        command: ["devcontainer", "exec", "--workspace-folder", $f, "bash"],
        env: { HERDR_DC_FOLDER: $f }
      },
      second: {
        type: "pane", label: $k, cwd: $f,
        command: ["devcontainer", "exec", "--workspace-folder", $f, $k],
        env: { HERDR_AGENT: $k, HERDR_DC_FOLDER: $f }
      }
    }'
  else
    jq -n --arg f "$folder" '{
      type: "pane", label: "shell", cwd: $f,
      command: ["devcontainer", "exec", "--workspace-folder", $f, "bash"],
      env: { HERDR_DC_FOLDER: $f }
    }'
  fi
}

# space_create <folder> <agent-kind-or-empty> — create workspace + devcontainer tab.
# Prints the workspace id on success. Space label = directory name only (no path,
# no suffix), per product decision.
space_create() {
  local folder="$1" kind="$2"
  local label created ws tab_id
  label=$(basename "$folder")

  created=$(hr workspace create --cwd "$folder" --label "$label" --no-focus) || {
    warn "workspace create failed for $folder"; return 1; }
  ws=$(printf '%s' "$created" | jq -r '.result.workspace.workspace_id')
  tab_id=$(printf '%s' "$created" | jq -r '.result.tab.tab_id // empty')
  [ -n "$ws" ] && [ "$ws" != null ] || { warn "no workspace id in create response"; return 1; }
  log "created workspace $ws ($label)"

  # Replace the default root tab with the devcontainer tab (shell + optional agent).
  if tree=$(layout_tree "$folder" "$kind"); then
    if layout_apply "$ws" "$TAB_LABEL" "$tree"; then
      log "applied devcontainer tab layout ($ws)"
    else
      warn "layout.apply unavailable; keeping default root pane — use the 'shell-here' action"
    fi
  fi
  printf '%s\n' "$ws"
}

# layout_apply_tab <tab_id> <label> <root-tree-json> — replace an EXISTING tab's
# tree in place (api schema: tab_id XOR workspace_id; tab mode closes the old tab
# after opening the replacement). Used by the tab_created hook.
layout_apply_tab() {
  local tab="$1" label="$2" tree="$3" payload resp
  payload=$(jq -n --arg tab "$tab" --arg l "$label" --argjson root "$tree" \
    '{tab_id:$tab, tab_label:$l, focus:false, root:$root}')
  if ! resp=$(api_request layout.apply "$payload"); then
    [ -n "$resp" ] && log "layout.apply: $(printf '%s' "$resp" | jq -r '.error.message // "failed"' 2>/dev/null)"
    return 1
  fi
  return 0
}

# state_folder_for_ws <workspace_id> — managed folder for a workspace, or empty.
state_folder_for_ws() {
  jq -r --arg ws "$1" 'to_entries[] | select(.value.workspace_id==$ws) | .key' \
    "$STATE_FILE" 2>/dev/null | head -1
}

# state_agents_for_ws <workspace_id> — space-separated agent kinds for the workspace.
state_agents_for_ws() {
  jq -r --arg ws "$1" '[to_entries[] | select(.value.workspace_id==$ws) | .value.agents[]?] | join(" ")' \
    "$STATE_FILE" 2>/dev/null
}

# state_upsert <folder> <workspace_id> <container_id> <agents-space-separated>
state_upsert() {
  local folder="$1" ws="$2" cid="$3" agents="$4"
  state_with_lock bash -c '
    file="$1"; folder="$2"; ws="$3"; cid="$4"; agents="$5"
    jq --arg f "$folder" --arg ws "$ws" --arg cid "$cid" --arg a "$agents" \
       ".[\$f] = {workspace_id:\$ws, container_id:\$cid, agents:(\$a | split(\" \") | map(select(length>0)))}" \
       "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  ' _ "$STATE_FILE" "$folder" "$ws" "$cid" "$agents"
}

# state_remove_ws <workspace_id> — drop any folder mapped to it; tombstone the folder.
state_remove_ws() {
  local ws="$1" folder
  folder=$(jq -r --arg ws "$ws" 'to_entries[] | select(.value.workspace_id==$ws) | .key' "$STATE_FILE" 2>/dev/null | head -1)
  state_with_lock bash -c '
    file="$1"; ws="$2"
    jq "with_entries(select(.value.workspace_id != \$ws))" --arg ws "$ws" \
       "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  ' _ "$STATE_FILE" "$ws"
  if [ -n "$folder" ] && [ "$folder" != null ]; then
    : > "$(tombstone_path "$folder")"
    log "tombstoned $folder (workspace closed by user)"
  fi
}
