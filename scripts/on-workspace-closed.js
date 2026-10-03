#!/usr/bin/env node
// on-workspace-closed.js — [[event]] hook on workspace.closed.
// Drops the state mapping for the closed workspace and tombstones its folder so
// auto-scan does not resurrect a space the user deliberately closed.
import { log, loadConfig, state, tombstone } from './lib.js';

loadConfig();

function extractWs() {
  try {
    const ev = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || 'null');
    if (ev) {
      const d = ev.data || ev;
      if (d?.workspace_id) return d.workspace_id;
      if (d?.id) return d.id;
    }
  } catch { /* unparseable */ }
  try {
    const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || 'null');
    if (ctx?.workspace_id) return ctx.workspace_id;
  } catch { /* unparseable */ }
  return '';
}

const ws = extractWs();
if (!ws) {
  let keys = 'none';
  try { keys = Object.keys(JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || '{}')).join(',') || 'none'; } catch { /* keep none */ }
  log(`workspace.closed: no workspace id in event payload (keys: ${keys})`);
  process.exit(0);
}

for (const folder of await state.removeWs(ws)) {
  tombstone.set(folder);
  log(`tombstoned ${folder} (workspace closed by user)`);
}
