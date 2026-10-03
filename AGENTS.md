# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## What this is

`herdr-devcontainer-spaces` — a [Herdr](https://herdr.dev) plugin (bash + jq) that:

1. discovers devcontainers via the `devcontainer.local_folder` docker/podman label
   (docker **and** podman, rootless **and** rootful),
2. creates a Herdr workspace ("space") per devcontainer, named **the directory name
   only** (`basename` — no path, no suffix; this is a product decision, do not add
   suffixes), with panes that run `devcontainer exec --workspace-folder <dir> bash`
   plus a `HERDR_AGENT`-hinted agent pane,
3. runs a watcher daemon that makes *ad-hoc* agents started inside those containers
   visible to Herdr (`pane read --source detection` → `agent explain --file` →
   `pane report-agent` / `pane release-agent`).

## Layout

```
herdr-plugin.toml      manifest (id: devcontainer-spaces, min_herdr_version: 0.9.0)
scripts/lib.sh         engine abstraction (docker|podman), herdr/socket helpers, state
scripts/discover.sh    rescan + space creation (idempotent, tombstone-aware)
scripts/watcher.sh     agent-state daemon (one per session, flock-guarded)
scripts/startup.sh     [[startup]] hook: rescan + (re)spawn watcher
scripts/*.sh           actions (shell-here, agent-here), event hook, pane entrypoints
test/run-tests.sh      mock suite (34 checks; runs anywhere bash+jq exist)
test/mock/bin/         stub docker/podman/devcontainer/herdr/api — heredoc-driven
test/TESTING.md        full test instructions — READ BEFORE RUNNING TESTS
docs/01..04-*.md       research + design background
```

## Environment notes

- The authoring dev container has **herdr 0.9.3, jq, node, bash, gh — but no
  docker/podman/devcontainer CLI**. Container-level validation must happen elsewhere;
  follow [test/TESTING.md](test/TESTING.md) levels 0–2 locally, level 3 on an engine
  host.
- `HERDR_BIN_PATH` and `HERDR_SOCKET_PATH` may be set ambiently; scripts honor them by
  design. Tests pin `HERDR_BIN_PATH` to the mock — keep it that way, or you will create
  real workspaces in a live herdr session.
- Never start/stop herdr servers or create workspaces outside a **named test session**
  (`HERDR_SESSION=dcsp-test`) on a machine that has a live default session.

## Non-obvious implementation constraints

- The herdr CLI has **no raw socket passthrough** (`herdr api` is only
  `snapshot`/`schema`), so `layout.apply` goes over the newline-delimited JSON socket
  via node or python3 (`api_request` in lib.sh; test seam: `HERDR_API_STUB`).
- Plain `pane split` cannot launch custom argv — custom pane commands come from either
  socket `layout.apply` (preferred) or the manifest `[[panes]]` entrypoints (fallback).
- `HERDR_AGENT=<kind>` must be set **host-side** (pane env); setting it inside the
  container is invisible to Herdr.
- One lifecycle authority per pane: hinted panes belong to Herdr, generic shells to the
  watcher (`custom:devcontainer` source). Never mix on one pane.
- The devcontainer CLI needs a docker-compatible backend; on podman-only machines the
  plugin may generate a **scoped** `docker`→`podman` shim under plugin state and
  prepend it to PATH only for its own invocations — never modify the user's PATH.
- Plugins are one-shot startup hooks + detached daemons; the watcher must exit when the
  socket dies and get restarted by the next `[[startup]]`.

## Testing

```bash
bash -n scripts/*.sh && bash test/run-tests.sh   # expect: 34 passed, 0 failed
```

For live tests (herdr smoke, docker/podman end-to-end, engine matrix, lifecycle),
**follow [test/TESTING.md](test/TESTING.md) exactly** — it defines levels, named
session usage, pass criteria, and cleanup.

## Publishing (maintainers only)

Do **not** publish without owner approval. When approved:

```bash
gh repo create ahati/herdr-devcontainer-spaces --public --source . --push
gh repo edit ahati/herdr-devcontainer-spaces --add-topic herdr-plugin
```

Marketplace indexing requires the `herdr-plugin` topic and the manifest at repo root
(already the case).
