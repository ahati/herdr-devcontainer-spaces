# Testing guide

How to validate the **devcontainer-spaces** plugin. Written for any agent or human
picking this repo up cold. Start at Level 0 and go as high as the machine allows.

**Environment reality check** — the dev container this repo was authored in has
`herdr` 0.9.3, `jq`, `node`, `bash`, `git`, `gh`, but **no docker, no podman, no
devcontainer CLI**. Therefore:

| Level | Needs | Runs in the authoring container? |
|---|---|---|
| 0 — static checks | bash (jq for tests) | ✅ |
| 1 — mock suite | bash + jq only | ✅ |
| 2 — live herdr smoke | herdr ≥ 0.9 | ✅ |
| 3 — live end-to-end | docker *or* podman + devcontainer CLI (+ agent binary for full agent checks) | ❌ — use another machine |

---

## Level 0 — static checks

```bash
bash -n scripts/*.sh test/mock/bin/* test/run-tests.sh && echo SYNTAX-OK
# optional, if shellcheck is installed:
shellcheck scripts/*.sh || true   # warnings are advisory; failures in SC2xxx logic matter
```

Expected: `SYNTAX-OK`.

## Level 1 — mock suite (no containers, no herdr server, safe anywhere)

```bash
bash test/run-tests.sh
```

Expected output ends with **`53 passed, 0 failed`** and exit code 0.

What it covers, via the stubs in `test/mock/bin/` (fake docker, podman, devcontainer,
herdr, socket-API):

- engine detection: docker rootful, podman rootless, no-engine failure path
- `dc_list` portability: identical TSV output under docker and podman
- `discover.sh` end-to-end: space created, **space label = directory name only**,
  `layout.apply` payload is valid JSON with `devcontainer exec` shell pane and a
  `HERDR_AGENT`-hinted agent pane, agent probing, state mapping, idempotent re-run
- `$HOME` filter on shared engines, stopped-container policy (`AUTO_START_CONTAINERS`),
  tombstone + `--resurrect` semantics
- podman-only machine: discovery works without docker; scoped `docker`→`podman` shim
  is generated under plugin state (user PATH untouched)
- watcher: reports in-shell agent via `pane report-agent`, skips dedicated agent panes,
  releases authority when the agent leaves the screen

The suite pins `HERDR_BIN_PATH` to the mock — it **cannot** touch a real herdr server.

## Level 2 — live herdr smoke test (no containers needed)

Goal: manifest links cleanly, actions/events registered, graceful no-engine failure,
event hook fires, logs visible. **Use a named session** so the default session and its
panes are never touched. On herdr 0.9.3 the session **must** be selected with the
`--session` CLI flag — `export HERDR_SESSION=dcsp-test` is ignored by `herdr server`.

```bash
# 1) start a headless named-session server (background; it stays running)
nohup herdr --session dcsp-test server >/tmp/dcsp-test.log 2>&1 & sleep 1

# 2) link the plugin from this checkout
herdr --session dcsp-test plugin link "$PWD"        # or an absolute path to the repo
herdr --session dcsp-test plugin list --json | jq   # expect id "devcontainer-spaces", enabled: true, warnings: []

# 3) actions registered
herdr --session dcsp-test plugin action list --plugin devcontainer-spaces
#    expect: rescan, resurrect, shell-here, agent-here

# 4) rescan — with no engine installed expect a clean actionable error, rc != 0, no crash:
herdr --session dcsp-test plugin action invoke devcontainer-spaces.rescan
herdr --session dcsp-test plugin log list --plugin devcontainer-spaces --limit 10
#    expect log lines: "ERROR: no working container engine found (tried docker, podman) ..."

# 5) event hook fires on workspace closure
herdr --session dcsp-test workspace create --cwd /tmp --label hook-test --no-focus
herdr --session dcsp-test workspace close <workspace_id from above>
herdr --session dcsp-test plugin log list --plugin devcontainer-spaces --limit 10
#    expect a command log record for scripts/on-workspace-closed.sh

# 6) teardown — the default session's server is a per-user singleton; never stop it
herdr --session dcsp-test plugin unlink devcontainer-spaces
herdr --session dcsp-test session stop       # or: herdr session stop dcsp-test
herdr session delete dcsp-test               # removes the session dir
```

Pass criteria: no manifest warnings at link time, all four actions listed, rescan error
message actionable, event hook log record present, clean unlink + session stop/delete.

Note: with an engine installed, step 4 instead performs a real scan — that is Level 3
territory; on this level prefer a machine without engines or accept the scan as a bonus.

Action caveat: `plugin action invoke` sets **no workspace id** in the context for the
child script (`HERDR_PLUGIN_CONTEXT_JSON` only carries `{"invocation_source":"cli",...}`),
but `HERDR_PANE_ID` is still exported — the plugin recovers the workspace from the
pane-id prefix, so `shell-here` works from both the TUI palette and the CLI.

### herdr 0.9.3 API notes

Verified live against herdr 0.9.3 (docker rootless 29.8.1, devcontainer CLI 0.89.0):

- **Named sessions**: the `HERDR_SESSION` env var is ignored by `herdr server` (it
  targets the default session's socket and refuses if one is running). Use the flag —
  `herdr --session dcsp-test server` — and repeat `--session dcsp-test` on **every**
  follow-up command. `herdr session list` shows both sessions. The default session's
  server is a per-user singleton — never stop it.
- **`pane list`**: no `--json` option (`unknown option: --json`); plain
  `herdr pane list` already outputs JSON (object with `.result.panes[]`).
- **`plugin action invoke`**: no `--workspace` option and no workspace id in the
  context (`HERDR_PLUGIN_CONTEXT_JSON` only contains
  `{"invocation_source":"cli",...}`), but `HERDR_PANE_ID` is still exported — the
  plugin recovers the workspace from the pane-id prefix, so actions work from the CLI
  too.
- **`plugin pane open --placement split`**: fails `invalid_params` — "split and zoomed
  plugin panes target an existing pane; use target_pane_id". The `--target-pane <PANE>`
  flag's forwarding appeared broken on 0.9.3 (same error with a valid pane id).
  `--placement tab` works — use it.
- **Plugin child env**: herdr exports `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT`,
  `HERDR_PLUGIN_CONFIG_DIR` (`~/.config/herdr/plugins/config/<id>`),
  `HERDR_PLUGIN_STATE_DIR` (`~/.local/state/herdr/plugins/<id>`), `HERDR_BIN_PATH`,
  `HERDR_SESSION`, `HERDR_PANE_ID`, plus `HERDR_PLUGIN_EVENT` /
  `HERDR_PLUGIN_EVENT_JSON` for events. The `workspace.closed` payload is
  `{"event":"workspace_closed","data":{"type":"workspace_closed","workspace_id":"w1","workspace":{...}|null}}`
  — workspace id at `.data.workspace_id`.

## Level 3 — live end-to-end (machine with docker *or* podman)

Prereqs: `herdr` ≥ 0.9, `jq`, `bash`, engine (docker or podman, rootless or rootful),
devcontainer CLI (`npm install -g @devcontainers/cli`), and — for the agent-detection
steps — a coding agent installed *inside* the container image (or network + npm to
install one there).

### 3.0 Prepare a demo devcontainer

```bash
mkdir -p ~/dcsp-demo/.devcontainer
cat > ~/dcsp-demo/.devcontainer/devcontainer.json <<'EOF'
{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }
EOF
devcontainer up --workspace-folder ~/dcsp-demo   # pre-build once; the plugin defers builds
```

### 3.1 Discovery + space creation

```bash
herdr --session dcsp-test plugin link "$PWD" && nohup herdr --session dcsp-test server >/tmp/dcsp-test.log 2>&1 & sleep 1   # startup hook rescans automatically
herdr --session dcsp-test plugin action invoke devcontainer-spaces.rescan
herdr --session dcsp-test plugin log list --plugin devcontainer-spaces --limit 20
herdr --session dcsp-test workspace list | jq -r '.result.workspaces[] | "\(.workspace_id) \(.label)"'
```

Pass: a workspace labeled `dcsp-demo` (directory name only); logs show
`engine: docker|podman (...)`, `agents present in ...:`, `created workspace`,
`applied devcontainer tab layout`.

### 3.2 In-container shell pane works

```bash
pane=$(herdr --session dcsp-test pane list | jq -r '.result.panes[] | select(.label=="shell") | .pane_id' | head -1)
herdr --session dcsp-test pane run "$pane" "cat /etc/os-release"
herdr --session dcsp-test pane wait-output "$pane" --match "PRETTY_NAME" --timeout 15000
```

Pass: output contains the container's `PRETTY_NAME` (proves the pane runs inside the
container, not on the host).

### 3.3 Agent detection — dedicated pane (HERDR_AGENT hint)

If the image has an agent (install one, e.g. `claude`, via devcontainer features or
`npm install -g @anthropic-ai/claude-code` inside the container), re-run rescan: the
tab gains a second pane labeled with the agent kind.

```bash
herdr --session dcsp-test agent list | jq     # the hinted pane should appear once the agent UI is up
```

Pass: agent row exists with state `idle` (or `working`/`blocked` once you use it).
Screen classification works across the container boundary.

### 3.4 Agent detection — watcher path (ad-hoc agent from the shell)

Open the in-container **shell** pane, type the agent command (e.g. `claude`) manually.
Within `POLL_SECS` (default 3 s):

```bash
herdr --session dcsp-test agent list | jq     # new agent row hosted by the *shell* pane
herdr --session dcsp-test plugin log list --plugin devcontainer-spaces --limit 5   # "pane <id>: agent=claude state=..."
```

Then exit the agent (`/exit` or ctrl+c twice). Within one poll cycle the row disappears
(`released` in plugin logs). Pass: appears on start, states change (working/blocked
during a turn/approval), disappears on exit.

If you have no agent credentials, validate the plumbing only:
`herdr --session dcsp-test pane read <pane> --source detection > /tmp/snap && herdr agent explain --file /tmp/snap --agent claude --json`
must exit 0 and print valid JSON (`unknown` state is fine).

### 3.5 Engine matrix

Repeat 3.1–3.4 with:

- [ ] docker rootful
- [ ] docker rootless (`dockerd-rootless`; `DOCKER_HOST` set)
- [ ] podman rootless (default; **no** `docker` binary on PATH → verify the shim is
      created under `$(herdr plugin config-dir devcontainer-spaces)`'s sibling state
      dir: `state/shim/docker`, and that `devcontainer exec` still works)
- [ ] podman rootful (optional)

Same-user filtering (rootful engines only):

```bash
docker run -d --name dcsp-junk --label devcontainer.local_folder=/etc alpine sleep infinity
herdr --session dcsp-test plugin action invoke devcontainer-spaces.rescan
# log must show: skip /etc/... (label outside $HOME on a shared engine)
docker rm -f dcsp-junk
```

### 3.6 Lifecycle

- [ ] Close the space (`herdr --session dcsp-test workspace close <id>`): mapping
      dropped, folder tombstoned, subsequent rescans do **not** recreate it.
- [ ] `herdr --session dcsp-test plugin action invoke devcontainer-spaces.resurrect`:
      tombstone cleared, space recreated.
- [ ] `herdr --session dcsp-test session stop` (or `herdr session stop dcsp-test`) +
      restart: startup hook restores spaces from state; agent panes return as fresh
      hinted panes; watcher daemon running again (`pgrep -af watcher.sh`).

### Known-benign log lines

- `WARN: layout.apply unavailable; keeping default root pane` — herdr < 0.9 socket method missing
- `skip <folder> (container exited; ...)` — `AUTO_START_CONTAINERS=0` default
- `[dc-watcher] herdr unreachable; watcher exiting` — normal at server stop

### Cleanup after Level 3

```bash
herdr --session dcsp-test plugin unlink devcontainer-spaces
herdr --session dcsp-test session stop       # or: herdr session stop dcsp-test
herdr session delete dcsp-test               # removes the session dir
devcontainer down? # not implemented upstream: docker rm -f the demo container if desired
rm -rf ~/dcsp-demo
```

---

## Reporting

File failures with: level, engine + mode (`docker/podman`, `rootless/rootful`),
`herdr --version`, full `herdr plugin log list --plugin devcontainer-spaces --limit 50`
output, and the exact command that failed.

---

## Mock-suite hermeticity (ambient environment)

The Level 1 mock suite must pass identically on any machine — including hosts that
have a real docker/podman installed and engine environment variables set. As of the
hermeticity fix, `new_scenario` in `test/run-tests.sh` sanitizes every scenario:

- `DOCKER_HOST`, `DOCKER_CONTEXT`, `CONTAINER_HOST` are unset. An ambient
  `DOCKER_HOST=unix:///run/user/<uid>/...` otherwise matches the rootless-docker
  heuristic in `scripts/lib.sh` (`_engine_rootless_docker`) and flips the mock
  "docker-rootful" scenario to rootless (`ROOTLESS=1`).
- `XDG_RUNTIME_DIR` points at an empty scenario dir, hiding real engine sockets.
  Otherwise, on a rootless-podman host, `dc_env` in `scripts/lib.sh` finds the real
  `podman.sock` and skips scoped-shim generation — failing the podman-shim test only
  on machines that actually run podman.
- The podman-only scenario (`discover-podman-shim`) additionally rebuilds PATH via
  `path_scrub docker`, so `command -v docker` fails even when the host has
  `/usr/bin/docker`. Deleting the mock stub alone is not enough: `dc_env` correctly
  refuses to generate the scoped shim when any working `docker` is resolvable —
  which is right plugin behavior, just wrong test premise.

If you add scenarios, inherit this sanitation rather than setting PATH/env by hand;
use `path_scrub <cmd>` when a scenario needs a binary to be absent. Expected suite
result on every machine: `53 passed, 0 failed`.
