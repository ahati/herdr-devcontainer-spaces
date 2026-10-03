#!/usr/bin/env node
// events-subscribe.js — event pump for terminal auto-conversion.
//
// herdr 0.9.3's plugin [[events]] whitelist has no tab/pane lifecycle names, but
// the socket API does (tab.created / pane.created — dot naming). This process
// holds one long-lived subscription connection and, per matching event, invokes
// scripts/on-terminal-created.sh with HERDR_PLUGIN_EVENT_JSON in the same shape
// a manifest event hook would deliver — transport here, policy in bash.
//
// Lifecycle: spawned detached by the startup hook (flock-guarded); reconnects
// with backoff across server restarts; exits never (the startup hook is the
// authority for respawning after session restore).
'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT_DIR = __dirname;
const HANDLER = path.join(SCRIPT_DIR, 'on-terminal-created.sh');

function socketPath() {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  const session = process.env.HERDR_SESSION;
  if (session) {
    return path.join(os.homedir(), '.config', 'herdr', 'sessions', session, 'herdr.sock');
  }
  return path.join(os.homedir(), '.config', 'herdr', 'herdr.sock');
}

function log(msg) {
  process.stderr.write(`[devcontainer-spaces] subscriber: ${msg}\n`);
}

function dispatch(msg) {
  // Pushed lines are {"event":"tab_created","data":{type, tab|pane}} — the same
  // shape herdr delivers to manifest event hooks. Tolerate dot/underscore naming.
  const type = String(msg.event || msg.type || (msg.data && msg.data.type) || '')
    .replace(/\./g, '_');
  if (type !== 'tab_created' && type !== 'pane_created') return;
  const payload = JSON.stringify({ event: type, data: msg.data || msg });
  const child = spawn('bash', [HANDLER], {
    env: Object.assign({}, process.env, {
      HERDR_PLUGIN_EVENT: type,
      HERDR_PLUGIN_EVENT_JSON: payload,
    }),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('error', (e) => log(`handler spawn failed: ${e.message}`));
}

let backoff = 1000;
function connect() {
  const sock = socketPath();
  const conn = net.connect(sock);
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
      // Ack lines carry our request id; pushed events carry .event / .type.
      if (msg.event || msg.type) {
        dispatch(msg);
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
