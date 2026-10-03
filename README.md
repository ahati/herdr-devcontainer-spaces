# herdr-devcontainer-spaces

A [Herdr](https://herdr.dev) plugin that turns your devcontainers into managed agent
workspaces. All plugin code is **Node ESM, zero npm dependencies, no build step**.

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
│       tabs:      every terminal in-container (auto-converted)        │
│       agents:    ● working      │  ● blocked     ← in the sidebar     │
└──────────────────────────────────────────────────────────────────────┘
```

**What it does**

- **Discovers** every devcontainer on the machine — Docker *and* Podman, rootless or
  rootful — via the standard `devcontainer.local_folder` container labels, and keeps
  watching: a `devcontainer up` anywhere gets its space automatically (engine event
  stream); a dying container marks its space `devcontainer (stopped)`.
- **Creates a Herdr space per devcontainer**, named after the directory, whose shell
  pane runs *inside* the container (`devcontainer exec`). **Every new tab or split in
  the space is converted to an in-container terminal** (push-based, via a socket event
  subscription — new tabs keep the name you gave them).
- **Detects agents started inside containers** — Herdr's process detection is
  host-side and cannot see container processes. The plugin bridges that with Herdr's
  own screen manifests *plus* presence markers for agents whose idle screens match no
  manifest rule (pi, claude, codex, opencode built in; add your own via settings).
  Start `pi` at an in-container prompt → it appears in the sidebar with
  `working / blocked / idle` states; exit → it disappears. `herdr agent wait/prompt/read`
  work on it.
- **Agents are never auto-started.** `agent-here` (or typing the agent name yourself)
  starts one on demand; discovery only *records* what's available.
- **Closing a space is never a dead end**: it stays closed for the rest of the Herdr
  session and returns automatically at the next session start — or immediately when
  its container restarts.

## Install

Requires: [Herdr](https://herdr.dev) ≥ 0.9 (verified on 0.9.3), **`node` ≥ 18**, `jq`,
a Docker- or Podman-compatible engine, and the
[`devcontainer` CLI](https://code.visualstudio.com/docs/devcontainers/devcontainer-cli)
(`npm install -g @devcontainers/cli`). Coding agents must be installed inside each
container to be detected.

```bash
herdr plugin install ahati/herdr-devcontainer-spaces
```

Then (re)start Herdr. The startup hook scans immediately and spawns two daemons
(agent watcher + terminal-conversion subscriber); their logs live under the plugin
state dir at `sessions/<name>/{watcher,subscriber}.log`.

## Keybindings (shipped in the manifest)

| Key | Action |
|---|---|
| `ctrl+alt+r` | Re-scan devcontainers |
| `ctrl+alt+shift+r` | Resurrect (re-create closed spaces) |
| `ctrl+alt+h` | Open an in-container shell in the current space |
| `ctrl+alt+g` | Start an in-container agent in the current space |

Notes: a TUI attached *before* installing needs a full restart to pick up new
bindings; some terminals swallow `ctrl+alt` combos (rebind via `[[keys.command]]` in
your config if needed). Herdr 0.9.3 has no command palette or plugin space in the
spaces context menu — bindings and the CLI are the action surfaces.

## Configuration

```bash
herdr plugin config-dir devcontainer-spaces   # prints the config dir
cp settings.env.example settings.env && $EDITOR settings.env
```

| Key | Default | Meaning |
|---|---|---|
| `ENGINE` | `auto` | `auto \| docker \| podman` |
| `AUTO_CREATE_SPACES` | `1` | create spaces for discovered devcontainers |
| `AUTO_START_CONTAINERS` | `0` | `devcontainer up` stopped containers during rescan |
| `AUTO_START_AGENTS` | `0` | dedicated agent pane in discovered spaces (opt-in) |
| `AGENTS` | `claude codex gemini cursor opencode copilot agy pi` | kinds probed per container |
| `POLL_SECS` | `3` | watcher poll interval |
| `TOMBSTONE_SESSION_ONLY` | `1` | closed spaces return next session (`0` = old persistent tombstone) |
| `MARKERS_<kind>` | — | custom presence regex for an agent (e.g. `MARKERS_agy='MY-BANNER'`) |
| `SUBTEXT_TOKEN` | `subtext` | sidebar metadata token name (empty disables) |
| `RESTORE_GRACE_MS` | `15000` | ignore tab/pane events right after session restore |

### Sidebar subtext ("devcontainer" under the space name)

The plugin reports display-only metadata per space; Herdr renders it only when your
config asks for it. Add to `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["branch", "git_status"], [{ token = "$subtext", dim = true }]]
```

then `herdr server reload-config`.

## How detection works

Herdr identifies agents by host-side foreground process — invisible for in-container
agents — but the agent's UI still flows through the host PTY. Per managed pane the
watcher reads the detection viewport (`pane read --source detection`) and:

1. classifies it with `herdr agent explain` (Herdr's own screen manifests decide the
   state whenever a rule actually matches);
2. falls back to **presence markers**: a title pattern (pi sets `π - …` while running,
   the shell resets it on exit) or multiple distinct content markers **guarded by a
   shell-prompt check** — a bare prompt at the viewport's last line means the shell
   owns the screen, so lingering agent banners in scrollback never keep a dead agent
   "alive";
3. reports/releases via `pane report-agent` / `pane release-agent` with a **monotonic
   `--seq`** per pane (Herdr ignores non-increasing sequences — the counter survives
   agent restarts, so re-launching an agent in the same terminal is detected again).

Each pane has exactly one lifecycle authority: `HERDR_AGENT`-hinted panes belong to
Herdr, generic shells to the watcher. Design background in
[docs/04-plugin-design.md](docs/04-plugin-design.md).

## Engine compatibility

| Setup | Supported | Notes |
|---|---|---|
| Docker rootful | ✅ | shared daemon → containers outside `$HOME` are skipped |
| Docker rootless | ✅ | engine is user-scoped; `DOCKER_HOST` respected |
| Podman rootless | ✅ | default podman mode; no service socket required |
| Podman rootful | ✅ | shared → `$HOME` heuristic applies |

The `devcontainer` CLI needs a docker-compatible backend. The plugin uses, in order:
a working `docker` on PATH → your existing `DOCKER_HOST` → the podman API socket → a
**plugin-scoped** `docker`→`podman` PATH shim (created only for the plugin's own
invocations; your `PATH` is never modified).

## Limitations

- `herdr agent start` does not work against in-container agents (host-side detection
  gate) — use `agent-here` or type the agent name in the shell.
- Screen-detection inherits Herdr's manifests; agents whose idle UI matches no rule
  rely on the plugin's markers (title/multi-hit) — add `MARKERS_<kind>` for exotic
  agents. Broken agent binaries in a container simply won't be probed.
- First-time image *builds* are not triggered by default (`AUTO_START_CONTAINERS=0`).
- Terminal auto-conversion needs `node`; without it spaces still work, but new tabs
  are host shells (use `shell-here`).

## Development

```bash
node --check scripts/*.js test/run-tests.js   # syntax
timeout 280 node test/run-tests.js            # 20 mock-engine tests (~15s, never hangs)
```

Research and design docs live in [docs/](docs/). Live-test levels (herdr smoke,
engine matrix, lifecycle) are defined in [test/TESTING.md](test/TESTING.md).

## License

MIT — see [LICENSE](LICENSE).
