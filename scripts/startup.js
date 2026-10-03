#!/usr/bin/env node
// startup.js — [[startup]] hook: repair/rediscover spaces, then ensure the
// watcher and the terminal-conversion subscriber are running for this session.
// Failures here never block the server.
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { log, detectEngine, loadConfig, SESSION_DIR, SCRIPTS_DIR, commandExists } from './lib.js';

loadConfig();
fs.mkdirSync(SESSION_DIR, { recursive: true });

// 1) Repair/rediscover spaces (synchronous, like the bash original — the
// hook is a one-shot init command; idempotent, no-ops with no engine).
if (detectEngine({ ENGINE: 'auto' })) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'discover.js')], { stdio: 'ignore', timeout: 120000 });
  if (r.status !== 0) log(`startup: rescan exited ${r.status}`);
} else {
  log('startup: no container engine; watcher idle until one is available');
}

// 2) Watcher daemon (single instance per session; exits with the server).
// flock WRAPS the process: the lock is held for its lifetime, so repeated
// startups never duplicate the daemon.
spawn('setsid', ['flock', '-n', path.join(SESSION_DIR, 'watcher.lock'),
  process.execPath, path.join(SCRIPTS_DIR, 'watcher.js')], { stdio: 'ignore', detached: true }).unref();

// 3) Terminal-conversion subscriber (push-based via socket events.subscribe).
if (commandExists('node')) {
  spawn('setsid', ['flock', '-n', path.join(SESSION_DIR, 'subscriber.lock'),
    process.execPath, path.join(SCRIPTS_DIR, 'events-subscribe.js')], { stdio: 'ignore', detached: true }).unref();
} else {
  log('startup: node not found; terminal auto-conversion disabled');
}

process.exit(0);
