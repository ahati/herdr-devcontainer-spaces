#!/usr/bin/env node
// on-terminal-created.js — invoked per tab.created / pane.created push event
// (by events-subscribe.js). Keeps every terminal of a managed space inside the
// container: new tabs are replaced with an in-container shell tree; split panes
// exec into the container. Plugin-created panes carry labels and are skipped.
import { log, loadConfig, state, layoutTree, layoutApply, panesOf, hr } from './lib.js';

loadConfig();

const ev = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || '{}');
const type = String(ev.event || ev?.data?.type || '').replace(/\./g, '_');

const ourLabels = (ws) => ['shell', ...state.agentsForWs(ws)];

function tabHasOurPane(tabId, ws) {
  const panes = panesOf(ws) || [];
  const labels = ourLabels(ws);
  return panes.some((p) => p.tab_id === tabId && labels.includes(p.label || ''));
}

if (type === 'tab_created') {
  const tab = ev?.data?.tab || {};
  const ws = tab.workspace_id || '';
  if (!ws || !tab.tab_id) process.exit(0);
  const folder = state.folderForWs(ws);
  if (!folder) process.exit(0);                       // not a managed space
  if (tabHasOurPane(tab.tab_id, ws)) process.exit(0); // already ours — no loops
  if (await layoutApply({ tabId: tab.tab_id, tabLabel: process.env.TAB_LABEL || 'devcontainer', root: layoutTree(folder, '') })) {
    log(`tab ${tab.tab_id}: converted to devcontainer shell (${folder})`);
  }
} else if (type === 'pane_created') {
  const pane = ev?.data?.pane || {};
  const ws = pane.workspace_id || '';
  if (!pane.pane_id || !ws || !pane.tab_id) process.exit(0);
  if (pane.label) process.exit(0);                    // plugin panes are labeled
  const folder = state.folderForWs(ws);
  if (!folder) process.exit(0);                       // not a managed space
  // Only convert splits of tabs we manage; the root pane of a brand-new native
  // tab is replaced wholesale by the tab_created branch.
  if (!tabHasOurPane(pane.tab_id, ws)) process.exit(0);
  const r = hr(['pane', 'run', pane.pane_id, `exec devcontainer exec --workspace-folder '${folder}' bash`]);
  if (r.ok) log(`pane ${pane.pane_id}: exec into devcontainer (${folder})`);
}
