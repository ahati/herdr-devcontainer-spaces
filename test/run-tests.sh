#!/usr/bin/env bash
# test/run-tests.sh — unit + integration tests with mock engines and a mock herdr.
# No docker, podman, devcontainer CLI, or herdr server required.
# Full test levels (incl. live tests for another machine): see test/TESTING.md.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

pass=0 fail=0
BASE_PATH="$PATH"   # pristine PATH; scenarios must not accumulate stub dirs
ok()   { pass=$((pass+1)); printf '  ok  %s\n' "$1"; }
fail_(){ fail=$((fail+1)); printf 'FAIL  %s\n' "$1"; }
check(){ if eval "$2"; then ok "$1"; else fail_ "$1 — [$2]"; fi }

# path_scrub <cmd> — print a shadow dir (symlinks to everything on BASE_PATH except
# <cmd>) so `command -v <cmd>` fails even if the ambient machine has the real binary.
path_scrub() {
  local cmd=$1 dir; dir=$(mktemp -d "$MOCK/scrub.XXXXXX")
  local IFS=: d f b
  for d in $BASE_PATH; do
    [ -d "$d" ] || continue
    for f in "$d"/*; do
      [ -e "$f" ] || continue
      b=$(basename "$f"); [ "$b" = "$cmd" ] && continue
      [ -e "$dir/$b" ] || ln -s "$f" "$dir/$b" 2>/dev/null
    done
  done
  printf '%s' "$dir"
}

new_scenario() {  # $1 = name; sets up a fresh mock env; echoes the mock dir
  local name="$1"
  local d; d="$(mktemp -d "/tmp/dcsp-$name.XXXXXX")"
  mkdir -p "$d/bin" "$d/home/project-a/.devcontainer" "$d/state" "$d/stubs" "$d/screens"
  cp "$HERE"/mock/bin/* "$d/stubs/"; chmod +x "$d/stubs"/*
  export PATH="$d/stubs:$BASE_PATH"        # no accumulation across scenarios
  export HERDR_BIN_PATH="$d/stubs/herdr"   # pin the mock herdr (ambient env may set it!)
  unset DOCKER_HOST DOCKER_CONTEXT CONTAINER_HOST  # engine env must not leak in
  export XDG_RUNTIME_DIR="$d/xdg"; mkdir -p "$d/xdg"  # hide real engine sockets
  export MOCK="$d"
  export HERDR_PLUGIN_STATE_DIR="$d/state"
  export HERDR_PLUGIN_CONFIG_DIR="$d/config"; mkdir -p "$d/config"
  export HERDR_API_STUB="$d/stubs/herdr-api-stub"
  export MOCK_ENGINES="$d/engines.json"
  export MOCK_PANES="$d/panes.json"
  export MOCK_CALLS="$d/calls.log"; : > "$MOCK_CALLS"
  export HERDR_SESSION=mock-1                  # plugin state is session-scoped
  SCENARIO_DIR="$d"
}

# ---------------------------------------------------------------- scenarios --
echo "# engine detection"

new_scenario engine-docker-rootful; d=$SCENARIO_DIR
cat > "$MOCK_ENGINES" <<'EOF'
{ "mode": "docker-rootful",
  "containers": [ {"id":"c1","state":"running","folder":"/tmp/ignored/project-a","config":"/tmp/ignored/project-a/.devcontainer/devcontainer.json"} ] }
EOF
source "$ROOT/scripts/lib.sh"
load_config; state_init
engine_detect || true
check "docker engine detected"          '[ "$ENGINE" = docker ]'
check "docker rootful mode"             '[ "$ROOTLESS" = 0 ]'
check "describe mentions rootful"       'engine_describe | grep -q rootful'

new_scenario engine-podman-rootless; d=$SCENARIO_DIR
cat > "$MOCK_ENGINES" <<'EOF'
{ "mode": "podman-rootless", "containers": [] }
EOF
source "$ROOT/scripts/lib.sh"
load_config; engine_detect || true
check "podman engine detected"          '[ "$ENGINE" = podman ]'
check "podman rootless detected"        '[ "$ROOTLESS" = 1 ]'

new_scenario engine-none; d=$SCENARIO_DIR
printf '{"mode":"none","containers":[]}' > "$MOCK_ENGINES"
source "$ROOT/scripts/lib.sh"; load_config
check "engine_detect fails gracefully"  '! engine_detect'

# ---------------------------------------------------------------- dc_list ----
echo "# dc_list portability"

new_scenario dclist; d=$SCENARIO_DIR
cat > "$MOCK_ENGINES" <<EOF
{ "mode": "docker-rootful",
  "containers": [ {"id":"c1","state":"running","folder":"$d/home/project-a","config":"$d/home/project-a/.devcontainer/devcontainer.json"},
                  {"id":"c2","state":"exited","folder":"/srv/other-user/proj","config":"/srv/other-user/proj/.devcontainer/devcontainer.json"} ] }
EOF
source "$ROOT/scripts/lib.sh"; load_config; state_init; engine_detect || true
rows=$(dc_list)
check "dc_list returns both containers"  '[ "$(printf "%s\n" "$rows" | grep -c .)" = 2 ]'
check "dc_list fields (running)"         'printf "%s\n" "$rows" | grep -q "^c1.running."'
check "dc_list fields (folder)"          'printf "%s\n" "$rows" | grep -q "project-a"'
cat > "$MOCK_ENGINES" <<EOF
{ "mode": "podman-rootless",
  "containers": [ {"id":"c1","state":"running","folder":"$d/home/project-a","config":"$d/home/project-a/.devcontainer/devcontainer.json"} ] }
EOF
ENGINE=auto                # re-detect from scratch (previous detect pinned docker)
engine_detect || true
rows_podman=$(dc_list)
check "dc_list identical under podman"   '[ "$(printf "%s" "$rows_podman" | grep -c "^c1.running.")" = 1 ]'

# ---------------------------------------------------------------- discover ---
echo "# discover.sh end-to-end (docker, one running container, claude+codex present)"

new_scenario discover-basic; d=$SCENARIO_DIR
cat > "$MOCK_ENGINES" <<EOF
{ "mode": "docker-rootful",
  "containers": [ {"id":"c1","state":"running","folder":"$d/home/project-a","config":"$d/home/project-a/.devcontainer/devcontainer.json"} ] }
EOF
printf 'claude\ncodex\n' > "$d/agents-present"
export HOME="$d/home"
rc=0; bash "$ROOT/scripts/discover.sh" >"$d/discover.out" 2>&1 || rc=$?
check "discover exits 0"                 "[ $rc -eq 0 ] || tail -5 '$d/discover.out'"
check "workspace created (mock call)"    'grep -q "workspace.create" "$MOCK_CALLS"'
check "space label is directory name only" 'grep -q "workspace.create .*label=project-a " "$MOCK_CALLS"'
check "layout.apply sent"                'grep -q "layout.apply" "$MOCK_CALLS"'
ws=$(jq -r '."'"$d"'/home/project-a".workspace_id' "$HERDR_PLUGIN_STATE_DIR/sessions/mock-1/containers.json")
check "mapping saved"                    '[ -n "$ws" ]'
check "agents probed claude+codex"       'jq -e --arg f "'"$d"'/home/project-a" ".[\$f].agents == [\"claude\",\"codex\"]" "'"$HERDR_PLUGIN_STATE_DIR"'/sessions/mock-1/containers.json" >/dev/null'
tree=$(grep "^LAYOUT " "$MOCK_CALLS" | tail -1 | cut -d" " -f2-)
check "layout tree valid JSON"           'printf "%s" "$tree" | jq -e ".root.type == \"split\"" >/dev/null'
check "layout payload: workspace_id only, no tab_id (0.9.3 contract)" \
  'l=$(grep "^LAYOUT " "$MOCK_CALLS" | tail -1); printf "%s" "$l" | grep -q "\"workspace_id\":" && ! printf "%s" "$l" | grep -q "\"tab_id\":"'
check "tree: shell pane uses devcontainer exec" 'printf "%s" "$tree" | jq -e ".root.first.command[0] == \"devcontainer\"" >/dev/null'
check "tree: agent pane HERDR_AGENT hint" 'printf "%s" "$tree" | jq -e ".root.second.env.HERDR_AGENT == \"claude\"" >/dev/null'

rc=0; bash "$ROOT/scripts/discover.sh" >"$d/discover2.out" 2>&1 || rc=$?
check "second run is idempotent"         '[ "$(grep -c "workspace.create" "$MOCK_CALLS")" -eq 1 ]'

new_scenario discover-outside-home; d=$SCENARIO_DIR
cat > "$MOCK_ENGINES" <<EOF
{ "mode": "docker-rootful",
  "containers": [ {"id":"c9","state":"running","folder":"/srv/other/proj","config":"/srv/other/proj/.devcontainer/devcontainer.json"} ] }
EOF
export HOME="$d/home"
bash "$ROOT/scripts/discover.sh" >"$d/out" 2>&1 || true
check "outside-\$HOME skipped"           'grep -q "outside \$HOME" "$d/out"'
check "no workspace created"             '! grep -q "workspace.create" "$MOCK_CALLS"'

new_scenario discover-stopped; d=$SCENARIO_DIR
cat > "$MOCK_ENGINES" <<EOF
{ "mode": "docker-rootful",
  "containers": [ {"id":"c3","state":"exited","folder":"$d/home/project-a","config":"$d/home/project-a/.devcontainer/devcontainer.json"} ] }
EOF
export HOME="$d/home"
bash "$ROOT/scripts/discover.sh" >"$d/out" 2>&1 || true
check "stopped container skipped by default" 'grep -q "AUTO_START_CONTAINERS" "$d/out"'
printf 'AUTO_START_CONTAINERS=1\n' > "$HERDR_PLUGIN_CONFIG_DIR/settings.env"
bash "$ROOT/scripts/discover.sh" >"$d/out2" 2>&1 || true
check "devcontainer up invoked when enabled" 'grep -q "devcontainer.up" "$MOCK_CALLS"'

new_scenario discover-tombstone; d=$SCENARIO_DIR
cat > "$MOCK_ENGINES" <<EOF
{ "mode": "docker-rootful",
  "containers": [ {"id":"c1","state":"running","folder":"$d/home/project-a","config":"$d/home/project-a/.devcontainer/devcontainer.json"} ] }
EOF
export HOME="$d/home"; source "$ROOT/scripts/lib.sh"; load_config; state_init
: > "$(tombstone_path "$d/home/project-a")"
bash "$ROOT/scripts/discover.sh" >"$d/out" 2>&1 || true
check "tombstoned folder skipped"        'grep -q "tombstoned" "$d/out"'
bash "$ROOT/scripts/discover.sh" --resurrect >"$d/out2" 2>&1 || true
check "resurrect clears tombstone"       'grep -q "resurrecting" "$d/out2"'

new_scenario discover-podman-shim; d=$SCENARIO_DIR
cat > "$MOCK_ENGINES" <<EOF
{ "mode": "podman-rootless",
  "containers": [ {"id":"p1","state":"running","folder":"$d/home/project-a","config":"$d/home/project-a/.devcontainer/devcontainer.json"} ] }
EOF
rm -f "$d/stubs/docker"                  # simulate a podman-only machine:
export PATH="$d/stubs:$(path_scrub docker)"  # no mock docker AND no ambient docker
printf 'claude\n' > "$d/agents-present"
export HOME="$d/home"
bash "$ROOT/scripts/discover.sh" >"$d/out" 2>&1 || true
check "podman-only discovery works"      'grep -q "created workspace" "$d/out"'
check "scoped docker->podman shim generated" '[ -x "$HERDR_PLUGIN_STATE_DIR/shim/docker" ]'

# ------------------------------------------- pane entrypoints (exec-dc fix) --
echo "# pane entrypoints"

new_scenario pane-entrypoints; d=$SCENARIO_DIR
printf '{"mode":"docker-rootful","containers":[]}' > "$MOCK_ENGINES"
export HOME="$d/home"
DEVCONTAINER_FOLDER="$d/home/project-a" bash "$ROOT/scripts/pane-shell.sh" >"$d/s.out" 2>&1
check "pane-shell execs bash in container (function dc, not /usr/bin/dc)" \
  'grep -q "devcontainer.exec exec --workspace-folder $d/home/project-a bash" "$MOCK_CALLS"'
DEVCONTAINER_FOLDER="$d/home/project-a" DC_AGENT_KIND=claude HERDR_AGENT=claude \
  bash "$ROOT/scripts/pane-agent.sh" >"$d/a.out" 2>&1
check "pane-agent execs agent kind in container" \
  'grep -q "devcontainer.exec exec --workspace-folder $d/home/project-a claude" "$MOCK_CALLS"'

# --------------------------------------- event hook payload shapes (0.9.3) --
echo "# workspace.closed payload shapes"

new_scenario event-payload; d=$SCENARIO_DIR
source "$ROOT/scripts/lib.sh"; load_config; state_init
map_file="$HERDR_PLUGIN_STATE_DIR/sessions/mock-1/containers.json"
unset HERDR_PANE_ID HERDR_PLUGIN_CONTEXT_JSON || true
jq -n --arg f "$d/home/project-a" '{($f):{workspace_id:"wX",container_id:"c1",agents:[]}}' > "$map_file"
export HERDR_PLUGIN_EVENT_JSON='{"event":"workspace_closed","data":{"type":"workspace_closed","workspace_id":"wX","workspace":null}}'
out=$(bash "$ROOT/scripts/on-workspace-closed.sh" 2>&1)
remaining=$(jq -r --arg f "$d/home/project-a" '.[$f] // empty' "$map_file" 2>/dev/null)
check "observed 0.9.3 payload (.data.workspace_id) tombstones folder" '[ -f "$(tombstone_path "$d/home/project-a")" ]'
check "observed payload removes mapping" '[ -z "$remaining" ]'
jq -n --arg f "/legacy/proj" '{($f):{workspace_id:"wY",container_id:"c2",agents:[]}}' > "$map_file"
export HERDR_PLUGIN_EVENT_JSON='{"workspace_id":"wY"}'
bash "$ROOT/scripts/on-workspace-closed.sh" >/dev/null 2>&1
check "legacy flat payload shape still handled" '[ -f "$(tombstone_path "/legacy/proj")" ]'
jq -n --arg f "/ctx/proj" '{($f):{workspace_id:"wZ",container_id:"c3",agents:[]}}' > "$map_file"
export HERDR_PLUGIN_EVENT_JSON=''
export HERDR_PLUGIN_CONTEXT_JSON='{"workspace_id":"wZ","invocation_source":"api"}'
bash "$ROOT/scripts/on-workspace-closed.sh" >/dev/null 2>&1
check "context-json fallback when event json empty" '[ -f "$(tombstone_path "/ctx/proj")" ]'
unset HERDR_PLUGIN_CONTEXT_JSON
export HERDR_PLUGIN_EVENT_JSON='{"foo":1}'
out=$(bash "$ROOT/scripts/on-workspace-closed.sh" 2>&1); rc=$?
check "unparseable payload exits 0 and logs keys" '[ $rc -eq 0 ] && printf "%s" "$out" | grep -q "keys: foo"'

# ------------------------------------------- shell-here target/fallback ----
echo "# shell-here pane open"

new_scenario shell-here; d=$SCENARIO_DIR
cat > "$MOCK_ENGINES" <<EOF
{ "mode": "docker-rootful",
  "containers": [ {"id":"c1","state":"running","folder":"$d/home/project-a","config":"$d/home/project-a/.devcontainer/devcontainer.json"} ] }
EOF
export HOME="$d/home"
bash "$ROOT/scripts/discover.sh" >/dev/null 2>&1 || true
ws=$(jq -r '."'"$d"'/home/project-a".workspace_id' "$HERDR_PLUGIN_STATE_DIR/sessions/mock-1/containers.json")
cat > "$MOCK_PANES" <<EOF
{"result":{"panes":[{"pane_id":"$ws:p1","workspace_id":"$ws","label":"shell"}]}}
EOF
export HERDR_PLUGIN_CONTEXT_JSON='{"invocation_source":"cli","correlation_id":"cli:plugin"}'
export HERDR_PANE_ID="$ws:p1"
bash "$ROOT/scripts/open-shell.sh" >"$d/o1" 2>&1
check "shell-here recovers ws from HERDR_PANE_ID (CLI invocation)" 'grep -q "opening devcontainer shell for" "$d/o1"'
check "split attempted with target pane" 'grep -q "placement=split target=$ws:p1" "$MOCK_CALLS"'
check "opened via split" 'grep -q "opened devcontainer shell pane (split)" "$d/o1"'
MOCK_PANE_OPEN_MODE=fail-split bash "$ROOT/scripts/open-shell.sh" >"$d/o2" 2>&1
check "falls back to tab placement when split unavailable" 'grep -q "placement=tab" "$MOCK_CALLS" && grep -q "opened devcontainer shell pane (tab)" "$d/o2"'

# ------------------------------------------------ session-scoped state ------
echo "# session scoping"

new_scenario session-scope; d=$SCENARIO_DIR
cat > "$MOCK_ENGINES" <<EOF
{ "mode": "docker-rootful",
  "containers": [ {"id":"c1","state":"running","folder":"$d/home/project-a","config":"$d/home/project-a/.devcontainer/devcontainer.json"} ] }
EOF
export HOME="$d/home"
HERDR_SESSION=sesA bash "$ROOT/scripts/discover.sh" >/dev/null 2>&1 || true
HERDR_SESSION=sesB bash "$ROOT/scripts/discover.sh" >/dev/null 2>&1 || true
check "state scoped per HERDR_SESSION" '[ -f "$HERDR_PLUGIN_STATE_DIR/sessions/sesA/containers.json" ] && [ -f "$HERDR_PLUGIN_STATE_DIR/sessions/sesB/containers.json" ]'
check "no unscoped top-level containers.json" '! [ -f "$HERDR_PLUGIN_STATE_DIR/containers.json" ]'
HERDR_SESSION=sesA POLL_SECS=0.3 bash "$ROOT/scripts/watcher.sh" >"$d/w.log" 2>&1 &
wpid=$!; sleep 0.8
check "watcher lock is per-session" '[ -f "$HERDR_PLUGIN_STATE_DIR/sessions/sesA/watcher.lock" ]'
kill "$wpid" 2>/dev/null; wait "$wpid" 2>/dev/null || true

# ------------------------------------------- startup guard + rescan race ---
echo "# startup watcher guard + concurrent rescan"

# watchers_of <session> — pids of watcher.sh processes scoped to one HERDR_SESSION
# (reading /proc/<pid>/environ keeps the checks safe on machines that run a real
# watcher from this checkout, and immune to parallel test runs).
watchers_of() {
  local p
  for p in $(pgrep -f "scripts/watcher.sh" 2>/dev/null); do
    if tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -q "^HERDR_SESSION=$1\$"; then
      echo "$p"
    fi
  done
}

new_scenario startup-guard; d=$SCENARIO_DIR
cat > "$MOCK_ENGINES" <<EOF
{ "mode": "docker-rootful",
  "containers": [ {"id":"c1","state":"running","folder":"$d/home/project-a","config":"$d/home/project-a/.devcontainer/devcontainer.json"} ] }
EOF
export HOME="$d/home"
HERDR_SESSION=guardA bash "$ROOT/scripts/startup.sh" >"$d/su1.log" 2>&1
sleep 0.7
n=$(watchers_of guardA | wc -l)
check "startup spawns watcher when lock is free" '[ "$n" -ge 1 ]'
watchers_of guardA | xargs -r kill 2>/dev/null; sleep 0.3
flock "$HERDR_PLUGIN_STATE_DIR/sessions/guardA/watcher.lock" -c 'sleep 2' &
holdpid=$!; sleep 0.2
HERDR_SESSION=guardA bash "$ROOT/scripts/startup.sh" >"$d/su2.log" 2>&1
sleep 0.7
n2=$(watchers_of guardA | wc -l)
check "startup skips spawn when lock is held" '[ "$n2" -eq 0 ]'
wait "$holdpid" 2>/dev/null || true

new_scenario rescan-race; d=$SCENARIO_DIR
cat > "$MOCK_ENGINES" <<EOF
{ "mode": "docker-rootful",
  "containers": [ {"id":"c1","state":"running","folder":"$d/home/project-a","config":"$d/home/project-a/.devcontainer/devcontainer.json"} ] }
EOF
export HOME="$d/home"
bash "$ROOT/scripts/discover.sh" >/dev/null 2>&1 &
bash "$ROOT/scripts/discover.sh" >/dev/null 2>&1 &
wait
check "concurrent rescans create exactly one space" '[ "$(grep -c "workspace.create" "$MOCK_CALLS")" -eq 1 ]'

# ------------------------------------------------- socket routing (lib) ----
echo "# socket routing"

new_scenario socket-routing; d=$SCENARIO_DIR
source "$ROOT/scripts/lib.sh"
mkdir -p "$d/home/.config/herdr/sessions/sesX"
mksock() {  # create a real unix socket file (herdr_socket tests -S)
  python3 -c "import socket; socket.socket(socket.AF_UNIX).bind('$1')" 2>/dev/null \
    || node -e "require('net').createServer().listen('$1')" 2>/dev/null || return 1
}
if mksock "$d/home/.config/herdr/herdr.sock" && mksock "$d/home/.config/herdr/sessions/sesX/herdr.sock"; then
  export HOME="$d/home"; unset HERDR_SOCKET_PATH
  export HERDR_SESSION=sesX
  out=$(herdr_socket)
  check "named session wins over existing default socket" '[ "$out" = "'$d'/home/.config/herdr/sessions/sesX/herdr.sock" ]'
else
  check "named session wins over existing default socket (skipped: no python3/node)" 'true'
fi
export HERDR_SOCKET_PATH=/tmp/explicit.sock
out2=$(herdr_socket)
check "explicit HERDR_SOCKET_PATH wins over session" '[ "$out2" = "/tmp/explicit.sock" ]'
unset HERDR_SOCKET_PATH

# -------------------------------------- terminal conversion (tabs/splits) ---
echo "# terminal conversion (tab_created / pane_created)"

new_scenario terminal-conversion; d=$SCENARIO_DIR
cat > "$MOCK_ENGINES" <<EOF
{ "mode": "docker-rootful",
  "containers": [ {"id":"c1","state":"running","folder":"$d/home/project-a","config":"$d/home/project-a/.devcontainer/devcontainer.json"} ] }
EOF
export HOME="$d/home"
bash "$ROOT/scripts/discover.sh" >/dev/null 2>&1 || true
ws=$(jq -r '."'"$d"'/home/project-a".workspace_id' "$HERDR_PLUGIN_STATE_DIR/sessions/mock-1/containers.json")
unset HERDR_PLUGIN_CONTEXT_JSON HERDR_PANE_ID || true

# 1) tab_created in a managed space with a native (unlabeled) pane -> replace
cat > "$MOCK_PANES" <<EOF
{"result":{"panes":[{"pane_id":"$ws:p5","workspace_id":"$ws","tab_id":"$ws:t9","label":""}]}}
EOF
export HERDR_PLUGIN_EVENT_JSON
HERDR_PLUGIN_EVENT_JSON=$(jq -cn --arg ws "$ws" '{event:"tab_created",data:{type:"tab_created",tab:{tab_id:"'"$ws"':t9",workspace_id:$ws,label:""}}}')
bash "$ROOT/scripts/on-terminal-created.sh" >/dev/null 2>&1
check "tab_created converts native tab to in-container tree" 'grep "^LAYOUT " "$MOCK_CALLS" | tail -1 | grep -q "\"tab_id\":\"'"$ws"':t9\""'

# 2) loop guard: tab already carries a shell-labeled pane -> untouched
before=$(grep -c "^LAYOUT " "$MOCK_CALLS")
cat > "$MOCK_PANES" <<EOF
{"result":{"panes":[{"pane_id":"$ws:p5","workspace_id":"$ws","tab_id":"$ws:t9","label":"shell"}]}}
EOF
HERDR_PLUGIN_EVENT_JSON=$(jq -cn --arg ws "$ws" '{event:"tab_created",data:{type:"tab_created",tab:{tab_id:"'"$ws"':t9",workspace_id:$ws,label:"devcontainer"}}}')
bash "$ROOT/scripts/on-terminal-created.sh" >/dev/null 2>&1
check "already-converted tab is left alone (no loop)" '[ "$(grep -c "^LAYOUT " "$MOCK_CALLS")" -eq "$before" ]'

# 3) unmanaged workspace -> untouched
HERDR_PLUGIN_EVENT_JSON=$(jq -cn '{event:"tab_created",data:{type:"tab_created",tab:{tab_id:"wX:t8",workspace_id:"wX",label:""}}}')
bash "$ROOT/scripts/on-terminal-created.sh" >/dev/null 2>&1
check "unmanaged workspace untouched" '[ "$(grep -c "^LAYOUT " "$MOCK_CALLS")" -eq "$before" ]'

# 4) pane_created: split in a tab we manage (shell pane present), unlabeled -> exec
cat > "$MOCK_PANES" <<EOF
{"result":{"panes":[{"pane_id":"$ws:p1","workspace_id":"$ws","tab_id":"$ws:t2","label":"shell"},
                     {"pane_id":"$ws:p2","workspace_id":"$ws","tab_id":"$ws:t2","label":""}]}}
EOF
HERDR_PLUGIN_EVENT_JSON=$(jq -cn --arg ws "$ws" '{event:"pane_created",data:{type:"pane_created",pane:{pane_id:"'"$ws"':p2",workspace_id:$ws,tab_id:"'"$ws"':t2",label:""}}}')
bash "$ROOT/scripts/on-terminal-created.sh" >/dev/null 2>&1
check "split pane execs into the container" 'grep -q "pane.run '"$ws"':p2 exec devcontainer exec --workspace-folder" "$MOCK_CALLS"'

# 5) labeled (plugin) pane -> not re-exec'd
runs=$(grep -c "^pane\.run" "$MOCK_CALLS")
HERDR_PLUGIN_EVENT_JSON=$(jq -cn --arg ws "$ws" '{event:"pane_created",data:{type:"pane_created",pane:{pane_id:"'"$ws"':p1",workspace_id:$ws,tab_id:"'"$ws"':t2",label:"shell"}}}')
bash "$ROOT/scripts/on-terminal-created.sh" >/dev/null 2>&1
check "labeled plugin pane not re-exec'd" '[ "$(grep -c "^pane\.run" "$MOCK_CALLS")" -eq "$runs" ]'

# 6) unlabeled pane in a native tab (no shell pane) -> left for the tab hook
HERDR_PLUGIN_EVENT_JSON=$(jq -cn --arg ws "$ws" '{event:"pane_created",data:{type:"pane_created",pane:{pane_id:"'"$ws"':p7",workspace_id:$ws,tab_id:"'"$ws"':t9",label:""}}}')
bash "$ROOT/scripts/on-terminal-created.sh" >/dev/null 2>&1
check "root pane of a native tab left for the tab_created hook" '[ "$(grep -c "^pane\.run" "$MOCK_CALLS")" -eq "$runs" ]'

# ---------------------------------------------------------------- watcher ----
echo "# watcher.sh"

new_scenario watcher-basic; d=$SCENARIO_DIR
cat > "$MOCK_ENGINES" <<EOF
{ "mode": "docker-rootful",
  "containers": [ {"id":"c1","state":"running","folder":"$d/home/project-a","config":"$d/home/project-a/.devcontainer/devcontainer.json"} ] }
EOF
printf 'claude\n' > "$d/agents-present"
export HOME="$d/home"
bash "$ROOT/scripts/discover.sh" >/dev/null 2>&1 || true
ws=$(jq -r '."'"$d"'/home/project-a".workspace_id' "$HERDR_PLUGIN_STATE_DIR/sessions/mock-1/containers.json")

# Two panes in the managed workspace:
#   p1 "shell"  — generic shell where the user started claude from the prompt
#   p2 "claude" — dedicated agent pane (HERDR_AGENT hint); watcher must skip it
cat > "$MOCK_PANES" <<EOF
{"result":{"panes":[
  {"pane_id":"$ws:p1","workspace_id":"$ws","label":"shell"},
  {"pane_id":"$ws:p2","workspace_id":"$ws","label":"claude"}
]}}
EOF
printf 'claude ui on screen\n' > "$d/screens/$ws:p1.txt"
printf 'claude ui on screen\n' > "$d/screens/$ws:p2.txt"
cat > "$d/rules.json" <<'EOF'
{ "claude": { "marker": "claude ui on screen", "state": "working" } }
EOF
export MOCK_RULES="$d/rules.json"

POLL_SECS=0.3 bash "$ROOT/scripts/watcher.sh" >"$d/watcher.log" 2>&1 &
wpid=$!
sleep 1.2
check "watcher reports in-shell agent"   'grep -q "agent=claude state=working" "$d/watcher.log"'
check "report targeted the shell pane"   'grep -q "pane '"$ws"':p1: agent=claude" "$d/watcher.log"'
check "dedicated agent pane skipped"     '[ "$(grep -c "pane '"$ws"':p2:" "$d/watcher.log")" -eq 0 ]'

# agent exits -> screen back to a bare prompt (explain returns fallback idle) -> release
printf 'just a shell prompt\n' > "$d/screens/$ws:p1.txt"
cat > "$d/rules.json" <<'EOF'
{ "claude": { "marker": "claude ui on screen", "state": "fallback-idle" } }
EOF
sleep 1.2
check "watcher releases on agent exit"   'grep -q "released claude" "$d/watcher.log"'
check "pane list --json rejected (0.9.3 CLI contract)" '! hr pane list --json >/dev/null 2>&1'
kill "$wpid" 2>/dev/null; wait "$wpid" 2>/dev/null || true
check "report-agent call recorded"       'grep -q "pane.report-agent" "$MOCK_CALLS"'
check "release-agent call recorded"      'grep -q "pane.release-agent" "$MOCK_CALLS"'

# ---------------------------------------------------------------- summary ----
echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
