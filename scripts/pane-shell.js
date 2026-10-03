#!/usr/bin/env node
// pane-shell.js — [[panes]] entrypoint "dc-shell": an interactive shell INSIDE
// the devcontainer. Opened with --env DEVCONTAINER_FOLDER=<host workspace folder>.
// Node replaces the bash `exec dc` trap: the devcontainer CLI runs as a direct
// child with inherited stdio; the pane closes when it exits.
import { die, loadConfig, detectEngine, dcEnv } from './lib.js';
import { spawn } from 'node:child_process';

loadConfig();

const FOLDER = process.env.DEVCONTAINER_FOLDER || '';
if (!FOLDER) die('DEVCONTAINER_FOLDER not set — open this pane via the shell-here action');

const engine = detectEngine({ ENGINE: 'auto' });
if (!engine) die('no container engine (docker/podman)');

process.stderr.write(`\x1b[1;36m▸ devcontainer shell — ${FOLDER}\x1b[0m\n`);
const be = dcEnv(engine.engine);
const child = spawn('devcontainer', ['exec', '--workspace-folder', FOLDER, 'bash'], {
  stdio: 'inherit',
  env: { ...process.env, ...(be.env || {}) },
});
child.on('error', (e) => die(`devcontainer exec failed: ${e.message}`));
child.on('exit', (code) => process.exit(code ?? 1));
