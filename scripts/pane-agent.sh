#!/usr/bin/env bash
# pane-agent.sh — [[panes]] entrypoint "dc-agent": run a coding agent INSIDE the
# devcontainer. The launcher (start-agent.sh / discover.sh) passes:
#   DEVCONTAINER_FOLDER=<host workspace folder>   DC_AGENT_KIND=<claude|codex|...>
# and sets HERDR_AGENT in the pane env so Herdr uses that agent's screen manifest.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

load_config

FOLDER="${DEVCONTAINER_FOLDER:-}"
KIND="${DC_AGENT_KIND:-}"
[ -n "$FOLDER" ] || die "DEVCONTAINER_FOLDER not set"
[ -n "$KIND" ]   || die "DC_AGENT_KIND not set"
command -v devcontainer >/dev/null 2>&1 || die "devcontainer CLI not found on PATH"
engine_detect || die "no container engine (docker/podman)"

printf '\x1b[1;36m▸ %s in devcontainer — %s\x1b[0m\n' "$KIND" "$FOLDER"
# NOTE: no `exec` here on purpose — exec bypasses bash functions, so `exec dc …`
# would run /usr/bin/dc (the desk calculator) instead of lib.sh's dc() wrapper.
dc exec --workspace-folder "$FOLDER" "$KIND"
