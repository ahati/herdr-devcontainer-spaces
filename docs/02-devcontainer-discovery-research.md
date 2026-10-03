# 02 — Devcontainer discovery & execution research

Sources: code.visualstudio.com devcontainer CLI docs, devcontainers/cli GitHub issues,
community posts confirming label-based discovery. User constraints: `devcontainer` CLI is
installed; only containers started by the same user are in scope.

## Discovery: how to find "all devcontainers on the system"

The devcontainer CLI (and VS Code, which uses the same implementation) **labels** every
container it creates:

| Docker label | Value |
|---|---|
| `devcontainer.local_folder` | absolute path of the workspace folder on the host, e.g. `/home/me/project` |
| `devcontainer.config_file` | absolute path of the `devcontainer.json` used |

Confirmed usage pattern (from devcontainers/cli issue tracker / community):

```bash
# all devcontainers (running + stopped)
docker ps -a --filter label=devcontainer.local_folder --format '{{.ID}}\t{{.Label "devcontainer.local_folder"}}\t{{.Label "devcontainer.config_file"}}\t{{.State}}\t{{.Names}}'

# devcontainer for one repo
docker ps -q -a --filter label=devcontainer.local_folder=/home/me/project
```

`docker ps` `--format '{{.Label "..."}}'` works on modern Docker; otherwise fall back to
`docker inspect` per container.

### "Started by the same user" filtering

The Docker daemon does not record *which OS user ran the client* on a container. Practical
filters, in order of robustness:

1. **Per-user engine (no filter needed):** rootless podman / rootless docker expose only
   that user's containers — the scope requirement holds by construction. Detection is
   cheap (`podman info -f '{{.Host.Security.Rootless}}'`, `docker context show`, or
   `DOCKER_HOST` under `/run/user/$UID/`); see the engine-compatibility section below.
2. **Path-ownership heuristic (shared engines):** keep containers whose
   `devcontainer.local_folder` / `devcontainer.config_file` resolves under the current
   user's `$HOME` (and whose recorded config file is readable/owned by `$USER`). This is
   the authoritative filter on rootful docker/podman where the daemon is shared. In the
   common single-user-per-machine setup this is exact.
3. **Explicit allowlist:** plugin config file (`HERDR_PLUGIN_CONFIG_DIR/config.toml`)
   may pin workspace folders; auto-discovery can be disabled.

Scope note (per user's framing): we *assume* same-user-only applicability; filter 1 is the
documented heuristic and the plugin should log skipped containers rather than fail.

### Caveats

- Containers created by tools that don't set these labels (hand-written `docker run`, some
  third-party wrappers) will not be discovered. Acceptable: they're not devcontainer-CLI
  managed, so `devcontainer exec` against them is unreliable anyway.
- A stopped container + deleted workspace folder → discovery should verify the folder
  still exists before offering/creating a space.
- Label missing on very old VS Code versions (<2021). Out of scope unless requested.

## Running things inside the devcontainer

```bash
# ensure built & running (idempotent; fast no-op when already up)
devcontainer up --workspace-folder /home/me/project

# exec a command in the RUNNING container (fails if not running → always `up` first)
devcontainer exec --workspace-folder /home/me/project bash
devcontainer exec --workspace-folder /home/me/project claude
```

- `devcontainer exec` resolves the container via the workspace folder (label lookup) and
  the workspace's `devcontainer.json` — so a pane only needs the **host repo path**,
  not a container id. This survives container restarts/rebuilds, which is exactly the
  right level of indirection for long-lived Herdr panes.
- `exec` requires the container running → the plugin must ensure `devcontainer up`
  beforehand (an explicit action, or best-effort with a timeout during discovery).
  First-time *builds* can take minutes — do not block Herdr startup on it; design: only
  auto-`up` containers already created, surface a `build` action for the rest.
- Env into the container: recent CLI versions support passing environment on exec
  (`-e/--env`); verify against the installed version (`devcontainer exec --help`). Where
  unsupported, export inside the remote command: `devcontainer exec ... sh -lc 'export
  FOO=...; exec bash'`.
- The agent binary (e.g. `claude`, `codex`) must exist **inside** the image/features of
  the devcontainer. The plugin should probe once per container
  (`devcontainer exec ... sh -lc 'command -v claude'`) and only create per-agent panes for
  agents actually present.

## Engine compatibility: Docker *and* Podman, rootless or rootful

The devcontainer CLI labels containers itself, so **both engines get the same labels**
(`devcontainer.local_folder`, `devcontainer.config_file`) — labels are applied by the
`devcontainer` CLI through the engine-agnostic Docker API, not by the engine.

### Portability of the queries we need

| Operation | Docker | Podman | Portable? |
|---|---|---|---|
| `ps -a --filter label=devcontainer.local_folder` | ✅ | ✅ identical syntax | ✅ |
| `ps --format '{{.ID}}\t{{.State}}\t{{.Label "devcontainer.local_folder"}}'` | ✅ | ✅ (podman-ps docs list `.Label string` and `.Labels` placeholders) | ✅ |
| `ps -a --format json` | ✅ (NDJSON, one object/line) | ✅ (JSON array) | ⚠️ different shapes |
| `inspect --format '{{json .Config.Labels}}' <id>` | ✅ | ✅ | ✅ |
| `inspect --format '{{.State.Status}}' <id>` | ✅ | ✅ | ✅ |
| `exec`, `start`, `version`, `info` | ✅ | ✅ docker-compatible CLI | ✅ |

Defensive strategy for scripts: enumerate IDs with `ps -a --filter label=... --format
'{{.ID}}'` (universally identical), then `inspect` each container and parse with `jq`
(`.Config.Labels`, `.State.Status`). This avoids the `ps --format json` shape difference
entirely and works unchanged under `docker`, `podman`, and any `docker`→`podman` shim.

### The four deployment modes

| Mode | Container visibility | Engine endpoint |
|---|---|---|
| docker rootful | **shared daemon** — all users' containers visible | `/var/run/docker.sock` |
| docker rootless | per-user | `$XDG_RUNTIME_DIR/docker.sock` (`DOCKER_HOST=unix:///run/user/$UID/docker.sock`, context `rootless`) |
| podman rootless (default for non-root) | **per-user** (graph root `~/.local/share/containers`) | no service needed for the `podman` CLI; optional API socket `$XDG_RUNTIME_DIR/podman/podman.sock` via `systemctl --user enable --now podman.socket` |
| podman rootful | shared | `/run/podman/podman.sock` (service) |

Implication for the "same user" filter: **rootless modes are naturally user-scoped** —
the engine only shows that user's containers, so the filter holds by construction.
**Rootful modes see everything**, so the `$HOME`-path heuristic on
`devcontainer.local_folder` does the real filtering there. The plugin should detect the
mode and log which filter is authoritative.

Rootless detection:

```bash
podman info --format '{{.Host.Security.Rootless}}'   # true/false (podman)
docker context show                                  # "rootless" → rootless (docker)
# fallback: DOCKER_HOST / endpoint path contains "/run/user/$UID/"
```

macOS/Windows podman runs inside a `podman machine` VM — socket path via
`podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}'`
(out of primary Linux scope, kept as a note).

### Making the `devcontainer` CLI work on podman

The `devcontainer` CLI shells out to a docker-compatible binary. Documented podman
integrations, in plugin order of preference:

1. **`docker` already works** (real docker, existing shim, or `DOCKER_HOST` already set)
   → use as-is.
2. **`DOCKER_HOST` → podman socket** (documented pattern:
   `export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman/podman.sock"`) → requires the
   user's `podman.socket` to be enabled.
3. **Scoped PATH shim (no service socket needed)** — generate a `docker` →
   `exec podman "$@"` wrapper under `HERDR_PLUGIN_STATE_DIR/shim/` and prepend that dir
   to `PATH` **only for the plugin's own `devcontainer up/exec` invocations**. Podman's
   CLI is docker-compatible for build/run/exec/ps/inspect, so the devcontainer CLI works
   with no daemon socket at all. Never modify the user's own PATH.
4. (VS Code users typically set `dev.containers.dockerPath=podman`; irrelevant to the
   standalone CLI but explains existing setups discovery may encounter.)

Engine resolution order: config pin (`[engine] name`) → working `docker` CLI → working
`podman` CLI → fail with an actionable message.

### Rootless/podman quirks (build/run level — not the plugin's job)

- SELinux: workspaces may need `:z`/`:Z` mount options in their `devcontainer.json` —
  owned by the repo config.
- `--userns=keep-id` affects in-container file ownership, not our exec flow.
- `devcontainer up` *builds* hit buildah/BuildKit differences — the design already defers
  builds (only `up` of already-created containers); first-time builds under podman remain
  the repo owner's concern.

## Mapping discovered containers → plugin state

Persist under `HERDR_PLUGIN_STATE_DIR/containers.json`:

```json
{
  "/home/me/project": {
    "workspace_id": "w3",
    "container_id": "abc123",
    "config_file": "/home/me/project/.devcontainer/devcontainer.json",
    "agents": ["claude", "codex"]
  }
}
```

Used for idempotent startup re-apply (the documented startup-hook pattern: save a
declarative view in state, re-validate and re-apply on startup) and for the watcher to
know which panes belong to devcontainers.
