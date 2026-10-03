# 01 — Herdr platform research

Sources: herdr.dev official docs (plugins, agents, cli-reference, socket-api,
agent-automation), flaviocopes.com deep dive, YC company page. All findings below are
from the published documentation of Herdr (YC company, Rust binary, terminal workspace
manager for coding agents).

## What Herdr is

- "tmux rebuilt around coding agents": a terminal multiplexer where every agent gets a
  real PTY pane, organized as **Session → Workspace ("Space" in the UI sidebar) →
  Tab → Pane**, with agents as recognized processes inside panes.
- The server owns PTYs and persists across client detach/reattach.
- Single Rust binary; local CLI + JSON-over-Unix-socket API. No plugin SDK —
  **the entire Herdr CLI/socket API is the plugin API**.

## Terminology mapping (user request → Herdr)

| User term | Herdr concept |
|---|---|
| "space" | **workspace** (`herdr workspace create`, rendered as "Space" rows in the sidebar) |
| "shell within the devcontainer" | a pane whose command is `devcontainer exec --workspace-folder <repo> bash` |
| "agent detected" | pane occupant recognized as an agent with lifecycle state `idle/working/blocked/done/unknown` |

## Plugin model (v1)

A plugin = a directory with `herdr-plugin.toml` + argv commands. Herdr owns install,
manifest validation, keybindings, panes, events, invocation context, socket access.

Manifest sections relevant to us:

```toml
id = "example.x"            # required; ASCII [A-Za-z0-9.:_-]
name, version, min_herdr_version   # required (version gate enforced at link)
platforms = ["linux", "macos", "windows"]

[[startup]]      # runs once per enabled plugin after session restore & API socket ready
command = ["bash", "scripts/startup.sh"]

[[actions]]      # user/menu/keybind invocations; contexts = ["workspace", ...]
id = "rescan"
command = ["bash", "scripts/discover.sh"]

[[events]]       # hooks on server events; name validated at link time
on = "worktree.created"
command = ["..."]

[[panes]]        # manifest-declared pane entrypoints with arbitrary argv commands
id = "shell"
command = ["bash", "scripts/in-container.sh"]
placement = "split"            # overlay (default) | popup | split | tab | zoomed
```

Runtime env injected into plugin commands:
`HERDR_SOCKET_PATH`, `HERDR_BIN_PATH` (preferred CLI entry), `HERDR_ENV=1`,
`HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`,
`HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_CONTEXT_JSON`, plus
`HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`/`HERDR_PANE_ID` when available, and
`HERDR_PLUGIN_EVENT`/`HERDR_PLUGIN_EVENT_JSON` for event hooks.

- Startup hooks are **one-shot init commands**, not supervised daemons (documented
  pattern: reapPLY declarative state saved under `HERDR_PLUGIN_STATE_DIR`). A long-running
  watcher must be spawned detached by the startup hook.
- `herdr plugin link /path/to/plugin` for local dev; `plugin log list` for logs.
- `HERDR_PLUGIN_CONFIG_DIR` for user config; `HERDR_PLUGIN_STATE_DIR` for runtime state.

## CLI surface we rely on

```
herdr workspace create --cwd PATH --label TEXT [--env K=V] [--no-focus]
  → JSON: .result.workspace.workspace_id, .result.tab.tab_id, .result.root_pane.pane_id
herdr workspace list / get / rename / close
herdr pane list / get / process-info / read / run / split
herdr plugin pane open --plugin ID --entrypoint ID \
  [--placement split|tab|...] [--workspace ID] [--target-pane PANE] [--env K=V]
herdr agent list / get / explain / start / prompt / wait
herdr pane report-agent <pane> --source ID --agent LABEL --state idle|working|blocked|unknown \
  [--seq N] [--message TEXT]
herdr pane release-agent <pane> --source ID --agent LABEL
herdr agent explain --file screen.txt --agent claude --json   # LOCAL evaluation of a saved
                                                              # screen snapshot against the
                                                              # active detection manifests
```

Key detail: `workspace create` makes workspace + first tab + root pane **but panes cannot
be given a custom argv via the pane commands** — plain `pane split` only takes
`--cwd/--env`. Two supported ways to launch a custom command in a pane:

1. **`layout.apply` (socket method)** — creates a fresh tab from a declarative BSP tree.
   Pane nodes accept `label`, `cwd`, **`command` (argv)** and **`env`** (map). This is the
   cleanest primitive: one call builds the whole tab of in-container shells.
2. **Plugin `[[panes]]` entrypoints** via `plugin pane open --workspace ID` — manifest
   argv command; placement split/tab; env via `--env`.

`layout.apply` example (from socket-api docs):

```json
{"id":"1","method":"layout.apply","params":{
  "workspace_id":"w1","tab_label":"dev","focus":false,
  "root":{"type":"split","direction":"right","ratio":0.6,
    "first":{"type":"pane","label":"shell","cwd":"/repo"},
    "second":{"type":"pane","label":"claude","cwd":"/repo",
      "command":["devcontainer","exec","--workspace-folder","/repo","claude"],
      "env":{"HERDR_AGENT":"claude"}}}}}
```

## How agent detection works (critical for us)

1. Herdr detects the **foreground process of the pane** — this is host-side process
   inspection (`pane process_info` exposes shell pid / foreground pgid / argv).
2. For known agents it reads the **live bottom of the pane screen** ("detection" buffer)
   and matches per-agent **screen manifests** (bundled + remote-updated + local overrides
   at `~/.config/herdr/agent-detection/<agent>.toml`) to classify
   `idle / working / blocked`.
3. Official **integrations** (`herdr integration install codex`, etc.) report state (and
   native session ids for resume) via hooks — they run inside the *agent's config dir on
   the host*.

### The container problem, stated by the docs themselves

> "On Linux and macOS, a host-visible wrapper can hide the real agent process from Herdr.
> Set `HERDR_AGENT=<agent>` on the wrapper command to tell Herdr which existing agent
> screen manifest to use... **Herdr cannot see it if you set it only inside a VM or
> container.** Avoid exporting it globally unless every inherited foreground process
> should be treated as that agent."

Implications:

- A devcontainer pane's host-visible foreground is the `devcontainer exec` / `docker exec`
  client process — the in-container `claude` process is invisible to host detection.
- `HERDR_AGENT=<kind>` set **on the host-side wrapper command** (i.e. as pane env) makes
  Herdr use that agent's screen manifest for the pane. The in-container agent's UI is
  drawn into the same host PTY, so **screen-manifest classification works across the
  container boundary**.
- Caveat: the hint applies to the foreground process — a plain shell prompt in a hinted
  pane may classify as `idle` for that agent (`default_known_agent_idle_fallback`),
  i.e. a false-positive "agent present". Mitigations in design doc §4.
- The custom-hook API `pane report-agent` lets an external process become the pane's
  **lifecycle authority** (`--source custom:...`, monotonic `--seq`), and
  `pane release-agent` ends that authority. This is the sanctioned mechanism for
  "agents Herdr cannot see" — exactly the in-container case.
- `herdr agent explain --file PATH --agent LABEL --json` evaluates a saved detection
  snapshot against the active manifests **locally**, so a watcher can reuse Herdr's own
  screen rules instead of hand-rolling regexes. (Verify flag availability on the
  installed binary via `herdr agent explain --help`.)
- `agent start --kind <kind> --pane <id>` expects to detect the started process on the
  host; in-container starts are **not** expected to satisfy that gate (see gaps doc).

## Events (validated names for `[[events]]` / `events.subscribe`)

- workspace: `workspace.created|updated|renamed|moved|reordered|closed|focused`,
  `workspace.metadata_updated`
- tab: `tab.created|closed|focused|renamed|moved`
- pane: `pane.created|updated|closed|focused|moved|exited|agent_detected|
  agent_status_changed|output_matched|scroll_changed`
- layout: `layout.updated`; worktree: `worktree.created|opened|removed`

For the watcher, `pane.created` / `pane.exited` / `pane.updated` are the triggers; a
periodic poll as fallback. Event-hook spawn-per-event is fine for cheap bookkeeping;
continuous matching belongs in the daemon.

## Relevant prior art in the ecosystem

- Marketplace has 1,200+ plugins; cookbook repo `ogulcancelik/herdr-plugin-examples`
  includes `dev-layout-bootstrap` and `agent-telegram-notify` — good structural templates
  (manifest + Node/Bash callbacks via `HERDR_BIN_PATH`).
- Publishing = GitHub repo with topic `herdr-plugin` + manifest at root/subdir.
