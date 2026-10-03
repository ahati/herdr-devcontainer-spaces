#!/usr/bin/env node
// discover.js — enumerate devcontainers and create/repair spaces (rescan action).
import path from 'node:path';
import fs from 'node:fs';
import {
  log, warn, die, loadConfig, detectEngine, describeEngine, dcList, dc, probeAgents,
  layoutTree, layoutApply, state, tombstone, hr, hrJson, commandExists, SESSION_DIR,
  reportSpaceSubtext, panesOf,
} from './lib.js';

const RESURRECT = process.argv.includes('--resurrect');
const cfg = loadConfig();
const engine = detectEngine(cfg);
if (!engine) {
  die(`no working container engine found (tried docker, podman). Install one, or pin ENGINE=docker|podman in settings.env`);
}

// Serialize concurrent rescans (startup hook x user action race creates dupes).
const rescanLock = path.join(SESSION_DIR, 'rescan.lock.d');
fs.mkdirSync(SESSION_DIR, { recursive: true });
try { fs.mkdirSync(rescanLock); } catch {
  const deadline = Date.now() + 60000;
  for (;;) {
    try { fs.mkdirSync(rescanLock); break; } catch {
      if (Date.now() > deadline) die('another rescan is holding the lock');
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
process.on('exit', () => { try { fs.rmdirSync(rescanLock); } catch { /* gone */ } });

log(`engine: ${describeEngine(engine)}; user-scope filter: ${
  engine.rootless ? 'engine is user-scoped (rootless); $HOME check is a sanity pass' : '$HOME path heuristic (shared engine)'}`);
if (!commandExists('devcontainer')) warn('devcontainer CLI not found — spaces will be created, but shells cannot exec until it is installed');

const home = path.resolve(process.env.HOME || '~');
let created = 0;
for (const row of dcList(engine.engine)) {
  const folder = row.folder;
  if (!folder) continue;
  if (!path.resolve(folder).startsWith(home + path.sep)) {
    log(`skip ${folder} (outside $HOME on a shared engine)`);
    continue;
  }
  if (tombstone.has(folder) && !RESURRECT) { log(`skip ${folder} (tombstoned; use resurrect to re-create)`); continue; }
  if (RESURRECT && tombstone.has(folder)) { tombstone.clear(folder); log(`resurrecting ${folder} (tombstone cleared)`); }

  if (row.state !== 'running') {
    if (cfg.AUTO_START_CONTAINERS !== 1) {
      log(`skip ${folder} (container ${row.state}; enable AUTO_START_CONTAINERS=1 in settings.env or start it manually)`);
      continue;
    }
    log(`starting container for ${folder} (AUTO_START_CONTAINERS=1)`);
    dc(engine.engine, ['up', '--workspace-folder', folder], { timeoutMs: 300000, stdio: 'ignore' });
  }

  const existing = state.containers()[folder];
  if (existing && hr(['workspace', 'get', existing.workspace_id]).ok) {
    log(`tracked: ${folder} -> ${existing.workspace_id}`);
    // Repair: session restore brings tabs back without our pane labels — if the
    // space lost its in-container shell entirely, re-apply the layout once.
    const panes = panesOf(existing.workspace_id) || [];
    const labels = ['shell', ...(existing.agents || [])];
    if (!panes.some((p) => labels.includes(p.label || ''))) {
      if (await layoutApply({ workspaceId: existing.workspace_id, tabLabel: null, root: layoutTree(folder, '') })) {
        log(`repaired devcontainer tab layout (${existing.workspace_id})`);
      }
    }
    reportSpaceSubtext(existing.workspace_id, cfg);
    continue;
  }

  const kinds = commandExists('devcontainer') ? probeAgents(engine.engine, folder, cfg.AGENTS) : [];
  log(`agents present in ${folder}:${kinds.length ? ' ' + kinds.join(' ') : ' none'}`);
  const kind = cfg.AUTO_START_AGENTS === 1 && kinds.length ? kinds[0] : '';

  const made = hrJson(['workspace', 'create', '--cwd', folder, '--label', path.basename(folder), '--no-focus']);
  const ws = made.json?.result?.workspace?.workspace_id;
  const rootTab = made.json?.result?.tab?.tab_id || null;
  if (!made.ok || !ws) { warn(`workspace create failed for ${folder}`); continue; }
  log(`created workspace ${ws} (${path.basename(folder)})`);

    const applied = rootTab
    ? await layoutApply({ tabId: rootTab, tabLabel: null, root: layoutTree(folder, kind) })   // replace the default root tab ("1")
    : await layoutApply({ workspaceId: ws, tabLabel: null, root: layoutTree(folder, kind) });
  if (applied) {
    log(`applied devcontainer tab layout (${ws})`);
  } else {
    warn('layout.apply unavailable; keeping default root pane — use the shell-here action');
  }
  reportSpaceSubtext(ws, cfg);
  await state.upsert(folder, ws, row.id, kinds);
  created++; 
}
log(`rescan done (created: ${created})`);
