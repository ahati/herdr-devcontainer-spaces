#!/usr/bin/env node
// duplicate-space.js — action "duplicate-space": create an additional workspace
// for the current devcontainer containing only one in-container shell.
import path from 'node:path';
import {
  log, warn, die, loadConfig, state, currentWorkspaceId,
  layoutTree, layoutApply, reportSpaceSubtext, hrJson,
} from './lib.js';

const cfg = loadConfig();
const currentWs = currentWorkspaceId();

let folder = '';
if (currentWs) {
  folder = state.folderForWs(currentWs);
}

if (!folder) {
  try {
    const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
    const cand = ctx.workspace_cwd || ctx.focused_pane_cwd || ctx.worktree?.path || ctx.cwd || '';
    if (cand) {
      const tracked = Object.keys(state.containers());
      folder = tracked.find((f) => cand === f || cand.startsWith(f + path.sep)) || cand;
    }
  } catch { /* unparseable */ }
}

if (!folder) {
  // Check if current directory or a parent is a tracked devcontainer
  const cwd = process.cwd();
  const tracked = Object.keys(state.containers());
  folder = tracked.find((f) => cwd === f || cwd.startsWith(f + path.sep)) || '';
}

if (!folder) {
  die('no devcontainer space context found; switch to a devcontainer workspace first');
}

const base = path.basename(folder);
const wsList = hrJson(['workspace', 'list']);
const existingLabels = (wsList.json?.result?.workspaces || []).map((w) => w.label || '');

let copyIndex = 2;
let targetLabel = `${base}-${copyIndex}`;
while (existingLabels.includes(targetLabel)) {
  copyIndex++;
  targetLabel = `${base}-${copyIndex}`;
}

log(`duplicating devcontainer space for ${folder} as "${targetLabel}"`);

// 1) Create the new workspace
const made = hrJson(['workspace', 'create', '--cwd', folder, '--label', targetLabel, '--no-focus']);
const newWs = made.json?.result?.workspace?.workspace_id;
const rootTab = made.json?.result?.tab?.tab_id || null;
if (!made.ok || !newWs) {
  die(`workspace create failed for ${folder}: ${made.stderr || made.error || 'unknown error'}`);
}
log(`created workspace ${newWs} (${targetLabel})`);

// 2) Apply single-shell layout (kind='' ensures single shell pane)
const applied = rootTab
  ? await layoutApply({ tabId: rootTab, tabLabel: null, root: layoutTree(folder, '') })
  : await layoutApply({ workspaceId: newWs, tabLabel: null, root: layoutTree(folder, '') });

if (applied) {
  log(`applied single devcontainer shell layout (${newWs})`);
} else {
  warn(`layout.apply unavailable; keeping default root pane`);
}

reportSpaceSubtext(newWs, cfg);
await state.addSecondaryWs(folder, newWs);

log(`duplicate devcontainer space ready: ${newWs} (${targetLabel})`);
