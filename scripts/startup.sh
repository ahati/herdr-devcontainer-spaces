#!/usr/bin/env bash
# startup.sh — [[startup]] hook. Runs once per session after restore.
# One-shot pattern: re-apply declarative state, then make sure the watcher daemon
# is running for this session's socket. Failures here never block the server.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

load_config
state_init

# 1) Repair/rediscover spaces (idempotent; no-ops with no engine installed).
if engine_detect; then
  bash "$SCRIPT_DIR/discover.sh" || true
else
  log "startup: no container engine; watcher idle until one is available"
fi

# 2) Watcher daemon (single instance per session; exits with the server).
# flock -n probe: exit 0 ⇔ lock was free ⇔ no watcher running → spawn one.
LOCK="$SESSION_DIR/watcher.lock"
if flock -n "$LOCK" true 2>/dev/null; then
  setsid bash "$SCRIPT_DIR/watcher.sh" </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi

# 3) Terminal-conversion subscriber (node; per-session). Push-based via the
# socket events.subscribe API — the manifest [[events]] whitelist (herdr 0.9.3)
# has no tab/pane lifecycle names. `flock -n` WRAPS the process: the lock is held
# for node's lifetime, so repeated startups never duplicate the subscriber.
# Requires node; without it conversion simply stays off.
if command -v node >/dev/null 2>&1; then
  setsid flock -n "$SESSION_DIR/subscriber.lock" \
    node "$SCRIPT_DIR/events-subscribe.js" </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
else
  log "startup: node not found; terminal auto-conversion disabled"
fi

exit 0
