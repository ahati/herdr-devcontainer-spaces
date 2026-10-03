#!/usr/bin/env bash
# pane-shell.sh — [[panes]] entrypoint "dc-shell": an interactive shell INSIDE the
# devcontainer. Opened with --env DEVCONTAINER_FOLDER=<host workspace folder>.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

load_config

FOLDER="${DEVCONTAINER_FOLDER:-}"
[ -n "$FOLDER" ] || die "DEVCONTAINER_FOLDER not set — open this pane via the 'shell-here' action"
command -v devcontainer >/dev/null 2>&1 || die "devcontainer CLI not found on PATH"
engine_detect || die "no container engine (docker/podman)"

printf '\x1b[1;36m▸ devcontainer shell — %s\x1b[0m\n' "$FOLDER"
# NOTE: no `exec` here on purpose — exec bypasses bash functions, so `exec dc …`
# would run /usr/bin/dc (the desk calculator) instead of lib.sh's dc() wrapper.
dc exec --workspace-folder "$FOLDER" bash
