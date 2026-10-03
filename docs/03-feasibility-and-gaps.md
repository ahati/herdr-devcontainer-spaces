# 03 — Feasibility & gaps

Requirement-by-requirement mapping of the user's ask against verified Herdr APIs.

| # | Requirement | Mechanism | Status |
|---|---|---|---|
| 1 | Plugin that runs automatically | `herdr-plugin.toml` + `[[startup]]` hook, `herdr plugin link` | ✅ documented |
| 2 | Detect all devcontainers on the system | `engine ps -a --filter label=devcontainer.local_folder` where `engine` = docker **or podman** (identical syntax) + user filter | ✅ documented (heuristic for "same user") |
| 3 | Automatically create spaces | `herdr workspace create --cwd <repo> --label "<basename>"` (space name = directory name only) | ✅ documented |
| 4 | Shells *inside* the devcontainer in those spaces | socket `layout.apply` pane nodes with `"command":["devcontainer","exec","--workspace-folder",X,"bash"]` (or plugin `[[panes]]` via `plugin pane open --workspace ID`) | ✅ documented |
| 5a | Agents in dedicated panes detected | pane env `HERDR_AGENT=<kind>` on the host-side wrapper → screen-manifest classification across the PTY | ✅ documented (docs describe exactly this for sandbox wrappers) |
| 5b | Agents started ad-hoc *from those shells* detected | watcher daemon: `pane read --source detection` → `herdr agent explain --file ... --agent <kind> --json` → `pane report-agent` / `release-agent` | ✅ sanctioned API (`report-agent` exists precisely for custom authorities); watcher logic is plugin-side work |
| 6 | Same-user containers only | rootless engines: user-scoped by construction; shared engines: `$HOME`-prefix heuristic on labels | ✅ per stated assumption |
| 7 | Docker **and Podman**, rootless/rootful | engine abstraction in `lib.sh`: resolve `docker`-compatible CLI (config pin → `docker` → `podman`); podman backend for the devcontainer CLI via existing `DOCKER_HOST`, podman socket, or a plugin-scoped `docker`→`podman` PATH shim | ✅ documented (devcontainer-CLI-podman integrations are established patterns) |

## Gaps, risks, open questions

1. **In-container processes are invisible to host process detection.** Confirmed by docs
   ("Herdr cannot see it if you set it only inside a VM or container"). Everything must
   flow through (a) the `HERDR_AGENT` hint or (b) `report-agent` authority. No Herd core
   change needed, but detection quality for ad-hoc agents == quality of the watcher's
   screen matching. Mitigation: reuse Herdr's own manifests via `agent explain --file`.
2. **`HERDR_AGENT` false positives on shell panes.** A hinted generic shell can read as
   "claude idle" at an empty prompt. → Use the hint only on dedicated agent panes; leave
   generic shells to the watcher.
3. **Authority exclusivity.** `report-agent` (custom source) and Herdr's own detection
   (`HERDR_AGENT` hint) shouldn't fight over the same pane. Design rule: one authority per
   pane; watcher skips hinted panes (identifiable via `pane get` env? — not exposed;
   instead watcher tracks which panes it created per-agent and skips them).
4. **`agent start` in devcontainer shells is not expected to work** (host-side detection
   gate + canonical executable resolved host-side). Plugin offers its own
   "start agent here" action instead: `pane run <pane> "claude"` (bracketed-paste safe,
   submits Enter) and lets the watcher take authority. Experiment later whether
   `agent start` happens to work when the binary exists in the container.
5. **Native session resume / integrations won't cross the boundary.** `herdr integration
   install claude` writes hooks on the host; the in-container agent can't reach the host
   Unix socket (mounting it is only possible at container-creation time and is a security
   tradeoff). v1: no native session ids; `-- RESUME_COMMAND` on `report-agent` could
   later supply `devcontainer exec ... claude --resume ...` style resume args.
6. **`devcontainer exec` needs a running container** → plugin must `devcontainer up`
   (idempotent) before opening panes; first-time builds must be explicit/opt-in.
7. **Watch out for rebuilds/recreates**: `devcontainer exec` resolves by workspace folder,
   so panes keep working across container replacement; but a running in-container agent
   dies with the container — watcher should detect the resulting dead pane/prompt and
   `release-agent`.
8. **Version gating.** `layout.apply`, `plugin pane open --workspace`, `report-agent`,
   `explain --file` — verify availability on the installed binary with
   `herdr api schema --json` / `--help`; set `min_herdr_version` accordingly.
9. **Session scoping.** Plugins are global per user, but workspaces live in a session;
   the startup hook inherits the right `HERDR_SOCKET_PATH` — the watcher daemon must
   inherit and pin it (and exit if the server stops; restart on next startup hook).
10. **Watch event floods.** `pane.updated` can be chatty (titles, scroll). Watcher should
    subscribe narrowly (`pane.created`, `pane.exited`, `pane.agent_status_changed`) and
    poll cheaply (`pane list` every few seconds) rather than react to every update.
12. **Engine matrix (docker/podman × rootless/rootful).** Everything the plugin needs is
    portable (label filter, `inspect`, `exec`), but four engine-specific risks remain:
    - *Podman + devcontainer CLI*: the `devcontainer` CLI needs a docker-compatible
      backend. Prefer, in order: existing working `docker` (real or shim) → existing
      `DOCKER_HOST` → podman socket (`podman.socket`) → generate a **plugin-scoped**
      `docker`→`podman` shim under `HERDR_PLUGIN_STATE_DIR/shim/` and prepend to PATH
      only for the plugin's `devcontainer` invocations. Never touch the user's PATH.
    - *Shared engines (rootful)*: `$HOME` heuristic is the only privacy boundary — a
      container with a label pointing outside `$HOME` must be skipped + logged.
    - *Rootless*: `$XDG_RUNTIME_DIR` must be set when invoking engines from non-login
      contexts (startup hooks inherit Herdr's env — verify `XDG_RUNTIME_DIR` is present;
      if absent, derive as `/run/user/$(id -u)` for socket paths).
    - *Builds*: `devcontainer up` first-time builds behave differently under buildah
      (SELinux `:z/:Z`, userns). Already deferred by design; keep it that way.
12. **Cleanup semantics.** When a devcontainer workspace is closed by the user
    (`workspace.closed` event hook), the plugin must drop its state mapping and stop
    managing panes; never auto-recreate a space the user explicitly closed (tombstone in
    state dir; `rescan` action clears tombstones on demand).

## What is NOT possible without upstream changes

- True *process-level* detection/identification of arbitrary in-container agents by the
  Herdr server itself (it never sees those PIDs). The watcher approach emulates it at the
  screen level, which the docs sanction ("report custom agent state from hooks and
  plugins" is a first-class socket capability).
- Native integration hooks (session ids for restart-resume) inside containers without
  socket bridging — deferred.
