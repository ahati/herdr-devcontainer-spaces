#!/usr/bin/env node
// start-agent.js — action "agent-here": open a dedicated pane that runs an agent
// inside the container, carrying the HERDR_AGENT hint.
import { log, die, loadConfig, state, currentWorkspaceId, paneOpenFallback, detectEngine, probeAgents, commandExists } from './lib.js';

loadConfig();
const ws = currentWorkspaceId();
if (!ws) { log('no workspace context; open a devcontainer space first'); process.exit(1); }

const folder = state.folderForWs(ws);
if (!folder) { log(`workspace ${ws} is not a devcontainer space`); process.exit(1); }

let kinds = state.agentsForWs(ws);
if (!kinds.length) {
  if (!commandExists('devcontainer')) { log('devcontainer CLI missing; cannot probe agents'); process.exit(1); }
  const engine = detectEngine({ ENGINE: 'auto' });
  if (!engine) { log('no container engine'); process.exit(1); }
  kinds = probeAgents(engine.engine, folder, loadConfig().AGENTS);
}
if (!kinds.length) { log(`no supported agent binary found in the container for ${folder}`); process.exit(1); }

const kind = kinds[0];
log(`opening ${kind} pane for ${folder} in ${ws}`);
try {
  const how = paneOpenFallback(ws, 'dc-agent', [`DEVCONTAINER_FOLDER=${folder}`, `DC_AGENT_KIND=${kind}`, `HERDR_AGENT=${kind}`]);
  log(`opened ${kind} pane (${how}) in ${ws}`);
} catch (e) {
  die(e.message);
}
