# herdr-devcontainer-spaces

A [Herdr](https://herdr.dev) plugin that turns your devcontainers into managed agent
workspaces.

```
┌──────────────────────────────────────────────────────────────────────┐
│  your machine                                                        │
│                                                                      │
│  docker/podman ── devcontainers (per project)                        │
│       │              │ project-a            │ project-b              │
│       │              ▼                      ▼                       │
│       │         [devcontainer exec]   [devcontainer exec]            │
│       ▼                                                              │
│  Herdr Spaces:         "project-a"              "project-b"           │
│       tabs:      devcontainer │ devcontainer                          │
│       panes:     shell  claude │  shell  codex                        │
│       agents:    ● working      │  ● blocked     ← in the sidebar     │
└──────────────────────────────────────────────────────────────────────┘
```

**What it does**

- **Discovers** every devcontainer on the machine — Docker *and* Podman, rootless or
  rootful — via the standard `devcontainer.local_folder` container labels.
- **Creates a Herdr space per devcontainer** with a tab containing a shell that runs
  *inside* the container (`devcontainer exec`), plus a dedicated pane for the first
  coding agent found in the container's image.
- **Detects agents started inside containers.** Herd's process detection is host-side
  and cannot see container processes; this plugin bridges that gap two ways:
  - dedicated agent panes carry a `HERDR_AGENT` hint so Herdr screen-detects them, and
  - a small watcher daemon classifies generic shell panes against Herdr's own agent
    screen manifests and reports state via `pane report-agent` — so `claude` typed at
    an in-container shell prompt shows up in the sidebar as a real agent with
    `working / blocked / idle` states, and `herdr agent wait/prompt/read` work on it.
- **Stays out of the way**: spaces you close are never auto-recreated; removing the
  plugin leaves your containers untouched.

## Install

Requires: [Herdr](https://herdr.dev) ≥ 0.9 (verified on 0.9.3), `bash`, `jq`, a Docker-
or Podman-compatible engine, and the [`devcontainer` CLI](https://code.visualstudio.com/docs/devcontainers/devcontainer-cli)
(`npm install -g @devcontainers/cli`). Coding agents must be installed inside each
container (image or devcontainer feature) to get dedicated panes.

```bash
herdr plugin install ahati/herdr-devcontainer-spaces
```

Or for local development:

```bash
git clone https://github.com/ahati/herdr-devcontainer-spaces
herdr plugin link ./herdr-devcontainer-spaces
```

Then start/attach Herd. The startup hook scans immediately; you can also run the
`Devcontainers: rescan` action (or `herdr plugin action invoke devcontainer-spaces.rescan`).

## Actions

| Action id | What it does |
|---|---|
| `devcontainer-spaces.rescan` | Rescan devcontainers; create missing spaces (respects tombstones) |
| `devcontainer-spaces.resurrect` | Rescan and re-create spaces you previously closed |
| `devcontainer-spaces.shell-here` | Open another in-container shell pane in the current space |
| `devcontainer-spaces.agent-here` | Open a dedicated pane running an in-container agent |

Bind them to keys in your Herdr config:

```toml
[[keys.command]]
key = "prefix+d"
type = "plugin_action"
command = "devcontainer-spaces.rescan"
description = "rescan devcontainers"
```

## Configuration

```bash
herdr plugin config-dir devcontainer-spaces   # prints the config dir
cp settings.env.example settings.env && $EDITOR settings.env
```

See [settings.env.example](settings.env.example) — engine pin (`auto|docker|podman`),
auto-start of stopped containers, which agent kinds to probe, poll interval, tab label.

## How detection works

Herdr identifies an agent by its **host-side foreground process**, then classifies state
by matching **screen manifests** against the bottom of the pane. A container hides the
agent process, but the agent's UI still flows through the host PTY — so:

1. **Dedicated agent panes** (`layout.apply` / `agent-here`) set `HERDR_AGENT=<kind>` in
   the pane env. Herdr uses that agent's manifest for the pane. No plugin code involved.
2. **The watcher** (started by the plugin's `[[startup]]` hook) handles *ad-hoc* agents:
   it polls panes in managed spaces, reads each pane's detection buffer
   (`pane read --source detection`), classifies it with `herdr agent explain --file …`
   (reusing Herdr's own manifests — no hand-rolled rules), and reports state as the
   pane's lifecycle authority (`pane report-agent` / `pane release-agent`).

Each pane has exactly one authority: hinted panes belong to Herdr, generic shells to the
watcher. Details and trade-offs in [docs/04-plugin-design.md](docs/04-plugin-design.md)
and [docs/03-feasibility-and-gaps.md](docs/03-feasibility-and-gaps.md).

## Engine compatibility

| Setup | Supported | Notes |
|---|---|---|
| Docker rootful | ✅ | shared daemon → containers outside `$HOME` are skipped |
| Docker rootless | ✅ | engine is user-scoped; `DOCKER_HOST` respected |
| Podman rootless | ✅ | default podman mode; no service socket required |
| Podman rootful | ✅ | shared → `$HOME` heuristic applies |
| Podman Desktop / `podman machine` (macOS) | ⚠️ | expected to work via socket; not CI-tested |

The `devcontainer` CLI needs a docker-compatible backend. The plugin uses, in order:
a working `docker` on PATH → your existing `DOCKER_HOST` → the podman API socket → a
**plugin-scoped** `docker`→`podman` PATH shim (created only inside the plugin's own
invocations; your `PATH` is never modified).

## Limitations

- `herdr agent start` does not work against in-container agents (host-side detection
  gate) — use the `agent-here` action or type the agent name in the shell.
- Native session resume across Herdr server restarts is not available for in-container
  agents (integration hooks cannot reach Herdr's socket from inside a container).
- First-time image *builds* are not triggered by default (`AUTO_START_CONTAINERS=0`);
  builds under podman/buildah are the project's own concern (SELinux `:z/:Z`, userns).
- Agents Herdr cannot screen-recognize will show as plain terminals (as on the host).

## Uninstall

```bash
herdr plugin unlink devcontainer-spaces   # or uninstall for GitHub installs
```

State (mappings, tombstones, the watcher lock) lives under the plugin state dir; closing
a Herdr session stops the watcher. Containers are never touched.

## Development

- [docs/01-herdr-platform-research.md](docs/01-herdr-platform-research.md) — Herdr plugin/API research
- [docs/02-devcontainer-discovery-research.md](docs/02-devcontainer-discovery-research.md) — labels, engines, `devcontainer exec`
- [docs/03-feasibility-and-gaps.md](docs/03-feasibility-and-gaps.md) — gaps, risks, what is impossible without upstream changes
- [docs/04-plugin-design.md](docs/04-plugin-design.md) — architecture and flows

```bash
bash -n scripts/*.sh         # syntax
test/run-tests.sh            # mock-engine unit tests (no docker/podman needed)
```

## License

MIT — see [LICENSE](LICENSE).
