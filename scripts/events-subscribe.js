#!/usr/bin/env node
// events-subscribe.js — event pump for terminal auto-conversion.
// Holds one long-lived events.subscribe connection (tab.created + pane.created)
// and invokes on-terminal-created.js per event with the manifest-hook payload
// shape. Transport here, policy in the handler. Spawns detached by startup.js
// (flock-guarded); reconnects with backoff across server restarts.
'use strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { socketPath } from './lib.js';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const HANDLER = path.join(SCRIPTS_DIR, 'on-terminal-created.js');

function log(msg) { process.stderr.write(`[devcontainer-spaces] subscriber: ${msg}\n`); }

function dispatch(msg) {
  const type = String(msg.event || msg.type || msg?.data?.type || '').replace(/\./g, '_');
  if (type !== 'tab_created' && type !== 'pane_created') return;
  const payload = JSON.stringify({ event: type, data: msg.data || msg });
  const child = spawn(process.execPath, [HANDLER], {
    env: { ...process.env, HERDR_PLUGIN_EVENT: type, HERDR_PLUGIN_EVENT_JSON: payload },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('error', (e) => log(`handler spawn failed: ${e.message}`));
}

let backoff = 1000;
function connect() {
  const conn = net.connect(socketPath());
  let buf = '';
  conn.on('connect', () => {
    backoff = 1000;
    conn.write(JSON.stringify({
      id: 'dcsp-sub-' + process.pid,
      method: 'events.subscribe',
      params: { subscriptions: [{ type: 'tab.created' }, { type: 'pane.created' }] },
    }) + '\n');
  });
  conn.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.event || msg.type) {
        dispatch(msg.event && typeof msg.event === 'object' && msg.event.type ? msg.event : msg);
      } else if (msg.error) {
        log(`subscription error: ${JSON.stringify(msg.error)}`);
      }
    }
  });
  conn.on('error', () => { /* retry below */ });
  conn.on('close', () => {
    conn.destroy();
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  });
}

log(`listening on ${socketPath()}`);
connect();
