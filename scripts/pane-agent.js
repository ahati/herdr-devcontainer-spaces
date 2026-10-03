#!/usr/bin/env node
// pane-agent.sh — [[panes]] entrypoint "dc-agent": run a coding agent INSIDE the
// devcontainer with the HERDR_AGENT hint (set in the pane env by the opener).
import { die, loadConfig, detectEngine, dcEnv } from './lib.js';
import { spawn } from 'node:child_process';

loadConfig();

const FOLDER = process.env.DEVCONTAINER_FOLDER || '';
const KIND = process.env.DC_AGENT_KIND || '';
if (!FOLDER) die('DEVCONTAINER_FOLDER not set');
if (!KIND) die('DC_AGENT_KIND not set');

const engine = detectEngine({ ENGINE: 'auto' });
if (!engine) die('no container engine (docker/podman)');

process.stderr.write(`\x1b[1;36m▸ ${KIND} in devcontainer — ${FOLDER}\x1b[0m\n`);
const be = dcEnv(engine.engine);
const child = spawn('devcontainer', ['exec', '--workspace-folder', FOLDER, KIND], {
  stdio: 'inherit',
  env: { ...process.env, ...(be.env || {}) },
});
child.on('error', (e) => die(`devcontainer exec failed: ${e.message}`));
child.on('exit', (code) => process.exit(code ?? 1));
