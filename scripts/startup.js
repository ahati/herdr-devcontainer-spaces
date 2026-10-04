#!/usr/bin/env node
// startup.js — [[startup]] hook: repair/rediscover spaces, then ensure the
// watcher and the terminal-conversion subscriber are running for this session.
// Failures here never block the server.
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { log, detectEngine, loadConfig, tombstone, SESSION_DIR, SCRIPTS_DIR, commandExists } from './lib.js';

const cfg = loadConfig();
fs.mkdirSync(SESSION_DIR, { recursive: true });

// 0) Session start: clean up session-scoped tombstones from prior runs.
// Per AGENTS.md contract, tombstones are session-scoped (a closed space
// returns at the next session start).
if (cfg.TOMBSTONE_SESSION_ONLY !== 0) {
  tombstone.clearSession();
}

// 1) Repair/rediscover spaces (synchronous, like the bash original — the
// hook is a one-shot init command; idempotent, no-ops with no engine).
if (detectEngine({ ENGINE: 'auto' })) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'discover.js'), '--resurrect'], { stdio: 'inherit', timeout: 120000 });
  if (r.status !== 0) log(`startup: rescan exited ${r.status}`);
} else {
  log('startup: no container engine; watcher idle until one is available');
}

// 2) Watcher daemon (single instance per session; exits with the server).
// flock WRAPS the process and the daemon self-heals duplicates (pid heartbeat
// inside its lock dir). Output appends to a per-session log for diagnosability.
const daemonOut = (name) => fs.openSync(path.join(SESSION_DIR, `${name}.log`), 'a');
spawn('setsid', ['flock', '-n', path.join(SESSION_DIR, 'watcher.lock'),
  process.execPath, path.join(SCRIPTS_DIR, 'watcher.js')], { stdio: ['ignore', daemonOut('watcher'), daemonOut('watcher')], detached: true }).unref();

// 3) Terminal-conversion subscriber (push-based via socket events.subscribe).
if (commandExists('node')) {
  spawn('setsid', ['flock', '-n', path.join(SESSION_DIR, 'subscriber.lock'),
    process.execPath, path.join(SCRIPTS_DIR, 'events-subscribe.js')], { stdio: ['ignore', daemonOut('subscriber'), daemonOut('subscriber')], detached: true }).unref();
} else {
  log('startup: node not found; terminal auto-conversion disabled');
}

process.exit(0);
