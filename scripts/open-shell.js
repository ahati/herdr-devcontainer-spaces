#!/usr/bin/env node
// open-shell.js — action "shell-here": open an in-container shell pane in the
// current workspace via the plugin's dc-shell entrypoint.
import { log, die, loadConfig, state, currentWorkspaceId, paneOpenFallback } from './lib.js';

loadConfig();
const ws = currentWorkspaceId();
if (!ws) { log('no workspace context; open a devcontainer space first'); process.exit(1); }

let folder = state.folderForWs(ws);
if (!folder) {
  try {
    const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
    const cand = ctx.workspace_cwd || ctx.focused_pane_cwd || ctx.worktree?.path || ctx.cwd || '';
    if (cand) {
      const tracked = Object.keys(state.containers());
      folder = tracked.find((f) => cand === f || cand.startsWith(f + path.sep)) || cand;
    }
  } catch { /* unparseable */ }
  if (!folder) { log(`workspace ${ws} is not a devcontainer space`); process.exit(1); }
}

log(`opening devcontainer shell for ${folder} in ${ws}`);
try {
  const how = paneOpenFallback(ws, 'dc-shell', [`DEVCONTAINER_FOLDER=${folder}`]);
  log(`opened devcontainer shell pane (${how}) in ${ws}`);
} catch (e) {
  die(e.message);
}
