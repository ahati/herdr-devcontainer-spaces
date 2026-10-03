# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## What this is

`herdr-devcontainer-spaces` — a [Herdr](https://herdr.dev) plugin (Node ESM, zero
npm deps, no build step; bash survives only in test fixtures) that:

1. discovers devcontainers via the `devcontainer.local_folder` docker/podman label
   (docker **and** podman, rootless **and** rootful), live via an engine-event stream,
2. creates a Herdr workspace ("space") per devcontainer, named **the directory name
   only** (`basename` — no path, no suffix; this is a product decision, do not add
   suffixes), whose terminals run inside the container (`devcontainer exec`); **every
   new tab/split in a managed space is auto-converted** to an in-container terminal;
   agents are probed and recorded but **never auto-started** (`AUTO_START_AGENTS=0`),
3. makes *ad-hoc* agents started inside those containers visible to Herdr: watcher
   classifies each managed pane's detection viewport (`agent explain` + presence
   markers) and reports/releases with monotonic `--seq`,
4. closes cleanly: tombstones are **session-scoped** (a closed space returns at the
   next session start or container restart; `TOMBSTONE_SESSION_ONLY=0` restores the
   old persistent behavior).

## Layout

```
herdr-plugin.toml      manifest (id: devcontainer-spaces; keybindings + actions + events)
scripts/lib.js         shared core: config, session-scoped state, herdr CLI + NDJSON
                       socket client, engine abstraction, layouts, presence markers
scripts/discover.js    rescan + resurrect (idempotent, tombstone-aware, race-locked)
scripts/watcher.js     agent detection poll + engine-event stream (live discovery)
scripts/events-subscribe.js  socket event pump (tab/pane conversion, restore grace)
scripts/on-terminal-created.js  conversion policy (per push event)
scripts/on-workspace-closed.js  tombstone hook
scripts/startup.js     [[startup]]: rescan + spawn daemons (flock-wrapped, logged)
scripts/open-shell.js / start-agent.js   actions (shell-here / agent-here)
scripts/pane-shell.js / pane-agent.js    [[panes]] entrypoints (in-container exec)
test/run-tests.js      node:test suite (20 tests; node ≥18; never hangs — it fails)
test/mock/bin/         stub docker/podman/devcontainer/herdr/api — heredoc-driven
test/TESTING.md        live-test levels — READ BEFORE RUNNING LIVE TESTS
docs/01..04-*.md       research + design background
```

## Environment notes

- The authoring dev container has **herdr 0.9.3, jq, node, bash, gh, a working
  rootless docker** (client+server 29.8.1, via `DOCKER_HOST=unix:///run/user/1000/docker.sock`),
  the **devcontainer CLI 0.89.0**, and **no podman** (podman matrix needs another
  machine). Follow [test/TESTING.md](test/TESTING.md).
- `HERDR_BIN_PATH` and `HERDR_SOCKET_PATH` may be set ambiently (panes get them!);
  scripts honor them by design. Tests pin `HERDR_BIN_PATH` to the mock — keep it that
  way, or you will create real workspaces in a live herdr session.
- Never start/stop herdr servers or create workspaces outside a **named test session**
  (`HERDR_SESSION=dcsp-test`) on a machine that has a live default session. Daemon
  logs: `sessions/<name>/{watcher,subscriber}.log` under the plugin state dir.

## herdr 0.9.3 API contracts (hard-won; do not regress)

- `layout.apply` takes **exactly one** of `tab_id` / `workspace_id` (omit null keys);
  `tab_id` mode replaces the tab (used for conversion), `workspace_id` adds one.
- `pane report-agent` / `release-agent` need a **monotonic `--seq` per (pane, source)**;
  herdr silently ignores non-increasing sequences. The per-pane counter must survive
  agent restarts (else re-launches are invisible) — keep `{agent: null, seq}` on release.
- `workspace.closed` payload wraps the id: `.data.workspace_id`.
- `pane list` prints JSON by default (**no `--json` flag**); `herdr api schema` answers
  **locally** (never use it as a liveness probe).
- The `[[events]]` manifest whitelist has **no tab/pane lifecycle names** — push-based
  conversion rides the socket `events.subscribe` API (`tab.created`, `pane.created`,
  dot-named). Session restore replays `tab.created` for restored tabs → the subscriber
  ignores events for `RESTORE_GRACE_MS` after start.
- `HERDR_SESSION` selects the session socket for the CLI; a named session must
  **never** fall back to the primary socket (a stale daemon would attach to the user's
  live default session).
- Plugin `contexts` is a free-form, unvalidated hint; 0.9.3 has **no command palette
  and no plugin entries in the spaces context menu** — keybindings + CLI are the only
  action surfaces.
- The detection viewport is ~40 lines and **retains agent banners after exit** —
  content markers alone keep dead agents "alive". Presence = title pattern (agents
  that set one) or multi-hit content **guarded by a shell-prompt-at-last-line check**.
- `HERDR_AGENT=<kind>` must be set host-side (pane env); one lifecycle authority per
  pane (hinted panes → Herdr; generic shells → watcher, source `custom:devcontainer`).
- The devcontainer CLI needs a docker-compatible backend; on podman-only machines a
  **scoped** `docker`→`podman` shim is generated under plugin state (never touch the
  user's PATH). Agent probing uses both `sh -lc` and `bash -ic` (bashrc-only PATHs).

## Testing

```bash
node --check scripts/*.js test/run-tests.js && \
  timeout 280 node test/run-tests.js   # expect: 20 tests, 0 failed (~15s)
```

Per-test timeouts + a self-watchdog: the suite never hangs, it fails. Scenarios scrub
ambient engine env (`DOCKER_HOST`, real `docker` on PATH) by construction. Daemon
tests reap what they spawn — never leak subscribers onto the primary socket.

For live tests, **follow [test/TESTING.md](test/TESTING.md) exactly**.

## Publishing (maintainers only)

Do **not** push/publish without owner approval. The repo is live at
`ahati/herdr-devcontainer-spaces` (topic `herdr-plugin`, marketplace-indexed);
shipping = commit → `git push origin main` → `herdr plugin install
ahati/herdr-devcontainer-spaces -y` on target machines → restart Herdr (the TUI
keymap only refreshes on full restart). Beware: `herdr plugin unlink` in *any*
session can remove a globally installed plugin.
