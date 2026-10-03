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

Expected output ends with **`34 passed, 0 failed`** and exit code 0.

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
panes are never touched.

```bash
export HERDR_SESSION=dcsp-test

# 1) start a headless named-session server (background; it stays running)
herdr server & sleep 1

# 2) link the plugin from this checkout
herdr plugin link "$PWD"          # or an absolute path to the repo
herdr plugin list --json | jq     # expect id "devcontainer-spaces", enabled: true, warnings: []

# 3) actions registered
herdr plugin action list --plugin devcontainer-spaces
#    expect: rescan, resurrect, shell-here, agent-here

# 4) rescan — with no engine installed expect a clean actionable error, rc != 0, no crash:
herdr plugin action invoke devcontainer-spaces.rescan
herdr plugin log list --plugin devcontainer-spaces --limit 10
#    expect log lines: "ERROR: no working container engine found (tried docker, podman) ..."

# 5) event hook fires on workspace closure
herdr workspace create --cwd /tmp --label hook-test --no-focus
herdr workspace close <workspace_id from above>
herdr plugin log list --plugin devcontainer-spaces --limit 10
#    expect a command log record for scripts/on-workspace-closed.sh

# 6) teardown
herdr plugin unlink devcontainer-spaces
herdr session stop dcsp-test
```

Pass criteria: no manifest warnings at link time, all four actions listed, rescan error
message actionable, event hook log record present, clean unlink + session stop.

Note: with an engine installed, step 4 instead performs a real scan — that is Level 3
territory; on this level prefer a machine without engines or accept the scan as a bonus.

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
herdr plugin link "$PWD" && herdr server & sleep 1   # startup hook rescans automatically
herdr plugin action invoke devcontainer-spaces.rescan
herdr plugin log list --plugin devcontainer-spaces --limit 20
herdr workspace list | jq -r '.result.workspaces[] | "\(.workspace_id) \(.label)"'
```

Pass: a workspace labeled `dcsp-demo` (directory name only); logs show
`engine: docker|podman (...)`, `agents present in ...:`, `created workspace`,
`applied devcontainer tab layout`.

### 3.2 In-container shell pane works

```bash
pane=$(herdr pane list --json | jq -r '.result.panes[] | select(.label=="shell") | .pane_id' | head -1)
herdr pane run "$pane" "cat /etc/os-release"
herdr pane wait-output "$pane" --match "PRETTY_NAME" --timeout 15000
```

Pass: output contains the container's `PRETTY_NAME` (proves the pane runs inside the
container, not on the host).

### 3.3 Agent detection — dedicated pane (HERDR_AGENT hint)

If the image has an agent (install one, e.g. `claude`, via devcontainer features or
`npm install -g @anthropic-ai/claude-code` inside the container), re-run rescan: the
tab gains a second pane labeled with the agent kind.

```bash
herdr agent list | jq     # the hinted pane should appear once the agent UI is up
```

Pass: agent row exists with state `idle` (or `working`/`blocked` once you use it).
Screen classification works across the container boundary.

### 3.4 Agent detection — watcher path (ad-hoc agent from the shell)

Open the in-container **shell** pane, type the agent command (e.g. `claude`) manually.
Within `POLL_SECS` (default 3 s):

```bash
herdr agent list | jq     # new agent row hosted by the *shell* pane
herdr plugin log list --plugin devcontainer-spaces --limit 5   # "pane <id>: agent=claude state=..."
```

Then exit the agent (`/exit` or ctrl+c twice). Within one poll cycle the row disappears
(`released` in plugin logs). Pass: appears on start, states change (working/blocked
during a turn/approval), disappears on exit.

If you have no agent credentials, validate the plumbing only:
`herdr pane read <pane> --source detection > /tmp/snap && herdr agent explain --file /tmp/snap --agent claude --json`
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
herdr plugin action invoke devcontainer-spaces.rescan
# log must show: skip /etc/... (label outside $HOME on a shared engine)
docker rm -f dcsp-junk
```

### 3.6 Lifecycle

- [ ] Close the space (`herdr workspace close <id>`): mapping dropped, folder
      tombstoned, subsequent rescans do **not** recreate it.
- [ ] `herdr plugin action invoke devcontainer-spaces.resurrect`: tombstone cleared,
      space recreated.
- [ ] `herdr session stop` + restart: startup hook restores spaces from state; agent
      panes return as fresh hinted panes; watcher daemon running again
      (`pgrep -af watcher.sh`).

### Known-benign log lines

- `WARN: layout.apply unavailable; keeping default root pane` — herdr < 0.9 socket method missing
- `skip <folder> (container exited; ...)` — `AUTO_START_CONTAINERS=0` default
- `[dc-watcher] herdr unreachable; watcher exiting` — normal at server stop

### Cleanup after Level 3

```bash
herdr plugin unlink devcontainer-spaces
herdr session stop dcsp-test
devcontainer down? # not implemented upstream: docker rm -f the demo container if desired
rm -rf ~/dcsp-demo
```

---

## Reporting

File failures with: level, engine + mode (`docker/podman`, `rootless/rootful`),
`herdr --version`, full `herdr plugin log list --plugin devcontainer-spaces --limit 50`
output, and the exact command that failed.
