#!/usr/bin/env node
// watcher.js — make ad-hoc agents inside devcontainers visible to Herdr.
// Polls managed panes, reads each pane's detection snapshot, classifies it via
// `herdr agent explain`, reports/releases lifecycle authority. Dedicated agent
// panes (labeled) are Herdr's — skipped. Single instance per session (lock dir).
import path from 'node:path';
import fs from 'node:fs';
import {
  log, loadConfig, state, hr, hrJson, SESSION_DIR, compileMarkers, presenceMatch,
} from './lib.js';

const cfg = loadConfig();
const MARKERS = compileMarkers(cfg);

const LOCK = path.join(SESSION_DIR, 'watcher.lock.d');
try { fs.mkdirSync(LOCK); } catch { process.exit(0); }   // already running
const PIDFILE = path.join(LOCK, 'pid');
fs.writeFileSync(PIDFILE, String(process.pid));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function soleOwner() {                                   // self-heal duplicates
  try {
    const other = Number(fs.readFileSync(PIDFILE, 'utf8'));
    if (other !== process.pid && alive(other)) {
      const cmd = fs.readFileSync(`/proc/${other}/cmdline`, 'utf8');
      if (cmd.includes('watcher.js')) return false;       // a peer lives — yield
    }
  } catch { /* no pidfile */ }
  fs.writeFileSync(PIDFILE, String(process.pid));
  return true;
}
process.on('exit', () => { try { if (fs.readFileSync(PIDFILE, 'utf8').trim() === String(process.pid)) fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* gone */ } });
process.on('SIGTERM', () => process.exit(0));

log(`watcher started (poll=${cfg.POLL_SECS}s)`);

// classify — herdr's manifests decide the state when they actually match; a
// fallback-derived idle is NOT evidence (explain falls back on any screen for a
// known agent kind). Presence markers close the gap for agents whose idle UI
// matches no manifest rule (pi on herdr 0.9.3): marker hit => agent present,
// state falls back to idle.
function classify(snapFile, snapText, title, kind) {
  const r = hrJson(['agent', 'explain', '--file', snapFile, '--agent', kind, '--json']);
  if (r.ok && r.json) {
    const st = r.json.state || '';
    if (st && st !== 'unknown' && !(r.json.idle_fallback_reason || r.json.fallback_reason)) return st;
  }
  if (presenceMatch(kind, `${snapText}\n${title}`, MARKERS)) return 'idle';
  return '';
}

function serverAlive() { return hr(['workspace', 'list'], { timeoutMs: 10000 }).ok; }

async function tick() {
  if (!soleOwner()) { log('duplicate watcher detected; exiting'); process.exit(0); }
  const rows = Object.entries(state.containers()).map(([folder, v]) => ({ ws: v.workspace_id, folder, kinds: v.agents || [] }));
  if (!rows.length) return;

  const listing = hrJson(['pane', 'list']);
  if (!listing.ok) {
    if (!serverAlive()) {
      log('herdr unreachable; watcher exiting (startup hook will restart it)');
      process.exit(0);
    }
    return; // transient failure; retry next poll
  }
  const allPanes = listing.json?.result?.panes || [];

  for (const { ws, folder, kinds } of rows) {
    if (!ws) continue;
    if (!hr(['workspace', 'get', ws], { timeoutMs: 10000 }).ok) continue; // closed; event hook cleans up
    for (const p of allPanes.filter((x) => x.workspace_id === ws)) {
      const pane = p.pane_id;
      if (!pane) continue;
      const label = p.label || '';
      if (kinds.includes(label)) continue;              // dedicated agent pane — Herdr owns it

      const snap = path.join(SESSION_DIR, `.snap.${pane}`);
      const rd = hr(['pane', 'read', pane, '--source', 'detection']);
      if (!rd.ok) {
        fs.rmSync(snap, { force: true });
        const panes = state.panes();
        const prev = panes[pane]?.agent;
        if (prev) {
          hr(['pane', 'release-agent', pane, '--source', 'custom:devcontainer', '--agent', prev]);
          await state.setPanesSafe((pp) => { delete pp[pane]; return pp; });
          log(`pane ${pane} gone; released ${prev}`);
        }
        continue;
      }
      fs.writeFileSync(snap, rd.stdout);
      const title = `${p.terminal_title_stripped || ''} ${p.terminal_title || ''} ${p.label || ''}`;

      let best = '', bestState = '';
      for (const k of kinds) {
        const st = classify(snap, rd.stdout, title, k);
        if (st) { best = k; bestState = st; break; }
      }
      fs.rmSync(snap, { force: true });

      const panes = state.panes();
      const prev = panes[pane]?.agent || '';
      const prevState = panes[pane]?.state || '';
      if (best) {
        if (best !== prev || bestState !== prevState) {
          if (prev && prev !== best) {
            hr(['pane', 'release-agent', pane, '--source', 'custom:devcontainer', '--agent', prev]);
          }
          const seq = (panes[pane]?.seq || 0) + 1;
          if (hr(['pane', 'report-agent', pane, '--source', 'custom:devcontainer', '--agent', best, '--state', bestState, '--seq', String(seq)]).ok) {
            await state.setPanesSafe((pp) => { pp[pane] = { agent: best, state: bestState, seq }; return pp; });
            log(`pane ${pane}: agent=${best} state=${bestState}`);
          }
        }
      } else if (prev) {
        const seq = (panes[pane]?.seq || 0) + 1;
        hr(['pane', 'release-agent', pane, '--source', 'custom:devcontainer', '--agent', prev]);
        await state.setPanesSafe((pp) => { delete pp[pane]; return pp; });
        log(`pane ${pane}: released ${prev} (no agent on screen)`);
      }
    }
  }
}

for (;;) {
  await new Promise((r) => setTimeout(r, cfg.POLL_SECS * 1000));
  await tick();
}
