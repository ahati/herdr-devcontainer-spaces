// lib.js — shared core for the Devcontainer Spaces plugin (Node ESM, zero deps).
// Ported from lib.sh: config, session-scoped state, herdr CLI + socket client,
// engine abstraction, devcontainer backend, layout trees, pane helpers.
//
// Env contract (set by herdr 0.9.3 for plugin children):
//   HERDR_PLUGIN_ID / _ROOT / _CONFIG_DIR / _STATE_DIR / _BIN / HERDR_BIN_PATH
//   HERDR_SESSION, HERDR_PANE_ID, HERDR_PLUGIN_CONTEXT_JSON / _EVENT_JSON
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';

export const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || 'devcontainer-spaces';
export const SCRIPTS_DIR = path.dirname(new URL(import.meta.url).pathname);
export const PLUGIN_ROOT = path.dirname(SCRIPTS_DIR);

export function log(msg) { process.stderr.write(`[${PLUGIN_ID}] ${msg}\n`); }
export function warn(msg) { log(`WARN: ${msg}`); }
export function die(msg) { log(`ERROR: ${msg}`); process.exit(1); }

// ---------------------------------------------------------------- config ---
export const SESSION = process.env.HERDR_SESSION || 'default';
export const STATE_ROOT =
  process.env.HERDR_PLUGIN_STATE_DIR ||
  path.join(os.homedir(), '.local', 'state', 'herdr', 'plugins', PLUGIN_ID);
export const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR ||
  path.join(os.homedir(), '.config', 'herdr', 'plugins', PLUGIN_ID);
export const SESSION_DIR = path.join(STATE_ROOT, 'sessions', SESSION);
const STATE_FILE = path.join(SESSION_DIR, 'containers.json');
const PANES_FILE = path.join(SESSION_DIR, 'panes.json');

const DEFAULTS = {
  ENGINE: 'auto',
  AUTO_CREATE_SPACES: 1,
  AUTO_START_CONTAINERS: 0,
  AUTO_START_AGENTS: 0,          // dedicated agent pane is opt-in
  AGENTS: 'claude codex gemini cursor opencode copilot agy pi',
  TAB_LABEL: 'devcontainer',
  POLL_SECS: Number(process.env.POLL_SECS || 3),
};

export function parseSettings(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].trim();
  }
  return out;
}

export function loadConfig() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const cfg = { ...DEFAULTS, ...parseSettings(process.env.POLL_SECS !== undefined ? `POLL_SECS=${process.env.POLL_SECS}` : '') };
  const file = path.join(CONFIG_DIR, 'settings.env');
  try { Object.assign(cfg, parseSettings(fs.readFileSync(file, 'utf8'))); } catch { /* absent */ }
  // settings.env values are strings — coerce the numeric knobs
  for (const k of ['AUTO_CREATE_SPACES', 'AUTO_START_CONTAINERS', 'AUTO_START_AGENTS', 'POLL_SECS']) {
    if (cfg[k] !== undefined && cfg[k] !== '') cfg[k] = Number(cfg[k]) || 0;
  }
  cfg.AGENTS = cfg.AGENTS.split(/\s+/).filter(Boolean);
  cfg.POLL_SECS = Number(cfg.POLL_SECS) || 3;
  return cfg;
}

// ------------------------------------------------------------------ state ---
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n');
  fs.renameSync(tmp, file);
}

// withDirLock — cross-process mutual exclusion without flock addons: atomic
// mkdir, stale-lock stealing, bounded waiting. Critical sections must stay short.
export async function withDirLock(lockDir, fn, { staleMs = 30000, waitMs = 10000 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { fs.mkdirSync(lockDir); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > staleMs) { fs.rmSync(lockDir, { recursive: true, force: true }); continue; }
      } catch { /* raced away */ }
      if (Date.now() > deadline) throw new Error(`lock timeout: ${lockDir}`);
      await sleep(50);
    }
  }
  try { return await fn(); } finally { fs.rmSync(lockDir, { recursive: true, force: true }); }
}

export const state = {
  containers: () => readJson(STATE_FILE, {}),
  panes: () => readJson(PANES_FILE, {}),
  setContainers: (obj) => atomicWriteJson(STATE_FILE, obj),
  setPanes: (obj) => atomicWriteJson(PANES_FILE, obj),
  folderForWs(ws) { return Object.keys(this.containers()).find((f) => this.containers()[f].workspace_id === ws) || ''; },
  agentsForWs(ws) {
    const e = Object.entries(this.containers()).find(([, v]) => v.workspace_id === ws);
    return e ? e[1].agents : [];
  },
  async upsert(folder, ws, cid, agents) {
    await withDirLock(path.join(SESSION_DIR, '.lock.d'), () => {
      const c = this.containers();
      c[folder] = { workspace_id: ws, container_id: cid, agents };
      this.setContainers(c);
    });
  },
  // removeWs returns the folders whose mappings were dropped; callers tombstone.
  async removeWs(ws) {
    const removed = [];
    await withDirLock(path.join(SESSION_DIR, '.lock.d'), () => {
      const c = this.containers();
      for (const [f, v] of Object.entries(c)) {
        if (v.workspace_id === ws) { delete c[f]; removed.push(f); }
      }
      this.setContainers(c);
    });
    return removed;
  },
  // setPanesSafe(mutator) — lock-guarded read-modify-write of panes.json.
  async setPanesSafe(mutator) {
    await withDirLock(path.join(SESSION_DIR, '.lock.d'), () => {
      this.setPanes(mutator(this.panes()));
    });
  },
};

export function tombstonePath(folder) {
  const h = crypto.createHash('md5').update(folder).digest('hex');
  return path.join(STATE_ROOT, `${h}.closed`);
}
export const tombstone = {
  has: (folder) => fs.existsSync(tombstonePath(folder)),
  set: (folder) => { fs.mkdirSync(STATE_ROOT, { recursive: true }); fs.writeFileSync(tombstonePath(folder), folder + '\n'); },
  clear: (folder) => { try { fs.unlinkSync(tombstonePath(folder)); } catch { /* absent */ } },
};

// ------------------------------------------------------------- herdr CLI ---
export const HERDR_BIN = process.env.HERDR_BIN_PATH || process.env.HERDR_BIN || 'herdr';

export function hr(args, { timeoutMs = 20000 } = {}) {
  const r = spawnSync(HERDR_BIN, args, { encoding: 'utf8', timeout: timeoutMs });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
export function hrJson(args, opts) {
  const r = hr(args, opts);
  if (!r.ok) return { ok: false, ...r };
  try { return { ok: true, json: JSON.parse(r.stdout), ...r }; } catch (e) {
    return { ok: false, ...r, error: `unparseable JSON: ${e.message}` };
  }
}

// ----------------------------------------------------------------- socket ---
// Precedence: explicit HERDR_SOCKET_PATH, then the named session's socket
// (plugin children always carry HERDR_SESSION), then the primary path.
export function socketPath() {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  if (process.env.HERDR_SESSION && process.env.HERDR_SESSION !== 'default') {
    const p = path.join(os.homedir(), '.config', 'herdr', 'sessions', process.env.HERDR_SESSION, 'herdr.sock');
    try { if (fs.statSync(p).isSocket()) return p; } catch { /* absent */ }
  }
  return path.join(os.homedir(), '.config', 'herdr', 'herdr.sock');
}

// apiRequest — one NDJSON request over the socket. Test seam: HERDR_API_STUB
// (spawned as <stub> <method> <params-json>; stdout is the response JSON).
export function apiRequest(method, params, timeoutMs = 15000) {
  if (process.env.HERDR_API_STUB) {
    const r = spawnSync(process.env.HERDR_API_STUB, [method, JSON.stringify(params)], { encoding: 'utf8' });
    if (r.status !== 0) return { ok: false, error: (r.stdout || r.stderr || 'stub failed').trim() };
    try { return { ok: true, json: JSON.parse(r.stdout) }; } catch { return { ok: true, json: null }; }
  }
  const sock = socketPath();
  const id = `dcsp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const done = (ok, json) => { try { conn.destroy(); } catch { } resolve({ ok, json }); };
    const timer = setTimeout(() => done(false, { error: 'timeout' }), timeoutMs);
    const conn = net.connect(sock);
    let buf = '';
    conn.on('connect', () => conn.write(JSON.stringify({ id, method, params }) + '\n'));
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === id) { clearTimeout(timer); done(!msg.error, msg); }
      }
    });
    conn.on('error', (e) => { clearTimeout(timer); done(false, { error: e.message }); });
  });
}

// ----------------------------------------------------------------- engine ---
export function detectEngine(cfg) {
  const candidates = cfg.ENGINE === 'docker' || cfg.ENGINE === 'podman' ? [cfg.ENGINE] : ['docker', 'podman'];
  for (const cli of candidates) {
    if (spawnSync(cli, ['version'], { stdio: 'ignore' }).status !== 0) continue;
    if (cli === 'podman') {
      const info = spawnSync('podman', ['info', '-f', '{{.Host.Security.Rootless}}'], { encoding: 'utf8' });
      return { engine: 'podman', flavor: 'podman', rootless: (info.stdout || '').trim() === 'true' };
    }
    const os_ = spawnSync('docker', ['info', '-f', '{{.OperatingSystem}}'], { encoding: 'utf8' });
    const flavor = ((os_.stdout || '').toLowerCase().includes('podman')) ? 'podman-via-shim' : 'docker';
    let rootless = false;
    const ctx = spawnSync('docker', ['context', 'show'], { encoding: 'utf8' });
    if ((ctx.stdout || '').trim() === 'rootless') rootless = true;
    if (/\/\/run\/user\//.test(process.env.DOCKER_HOST || '')) rootless = true;
    if (!process.env.XDG_RUNTIME_DIR) process.env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
    return { engine: 'docker', flavor, rootless };
  }
  return null;
}
export function describeEngine(e) {
  return `${e.engine} (${e.flavor}, ${e.rootless ? 'rootless' : 'rootful'})`;
}

// dcList — TSV-equivalent rows: {id, state, folder, config}
export function dcList(engine) {
  const ps = spawnSync(engine, ['ps', '-a', '--filter', 'label=devcontainer.local_folder', '--format', '{{.ID}}'], { encoding: 'utf8' });
  if (ps.status !== 0) return [];
  const rows = [];
  for (const id of (ps.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)) {
    const q = (tmpl) => (spawnSync(engine, ['inspect', '-f', tmpl, id], { encoding: 'utf8' }).stdout || '').trim();
    rows.push({ id, state: q('{{.State.Status}}'), folder: q('{{index .Config.Labels "devcontainer.local_folder"}}'), config: q('{{index .Config.Labels "devcontainer.config_file"}}') });
  }
  return rows;
}

// dcEnv — devcontainer CLI backend resolution (never touches user PATH).
export function dcEnv(engine) {
  if (engine === 'docker' || commandExists('docker')) return {};
  if (process.env.DOCKER_HOST) return {};
  const sock = path.join(process.env.XDG_RUNTIME_DIR || '', 'podman', 'podman.sock');
  try { if (fs.statSync(sock).isSocket()) return { env: { DOCKER_HOST: `unix://${sock}` } }; } catch { /* absent */ }
  const shimDir = path.join(STATE_ROOT, 'shim');
  fs.mkdirSync(shimDir, { recursive: true });
  const shim = path.join(shimDir, 'docker');
  fs.writeFileSync(shim, '#!/bin/sh\nexec podman "$@"\n');
  fs.chmodSync(shim, 0o755);
  return { env: { PATH: `${shimDir}:${process.env.PATH}` } };
}

export function commandExists(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

// dc — run the devcontainer CLI with the resolved backend. Returns spawnSync result.
export function dc(engine, args, opts = {}) {
  const be = dcEnv(engine);
  return spawnSync('devcontainer', args, {
    encoding: opts.encoding ?? 'utf8',
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(be.env || {}) },
    timeout: opts.timeoutMs,
  });
}

export function probeAgents(engine, folder, kinds) {
  // Probe via both a login shell (~/.profile) and an interactive bash
  // (~/.bashrc — where nvm / ~/.local/bin paths usually live); a single
  // `sh -lc` misses agents installed via bashrc-only PATH setup (observed:
  // claude/codex/opencode unreported while agy/pi were found).
  const shells = [['sh', '-lc'], ['bash', '-ic']];
  const present = [];
  for (const kind of kinds) {
    const clean = kind.replace(/[^a-z0-9_-]/g, '');
    let found = false;
    for (const sh of shells) {
      const r = dc(engine, ['exec', '--workspace-folder', folder, ...sh, `command -v ${clean}`], { stdio: 'ignore' });
      if (r.status === 0) { found = true; break; }
    }
    if (found) present.push(kind);
  }
  return present;
}

// ------------------------------------------------- agent presence markers ---
// herdr's screen manifests decide the agent STATE, but some agents' idle screens
// match no manifest rule (observed: pi 2026.10 on herdr 0.9.3). These markers are
// the plugin's own presence signal. Hard-won specifics:
//   * the pane TITLE is the only reliable live/dead signal for agents that set
//     one — pi sets 'π - …' while running and the shell resets it on exit. The
//     detection viewport (~40 lines) keeps the whole agent banner in scrollback
//     after exit, so content markers stay hot long after the agent is gone
//   * agents WITHOUT a title convention fall back to content markers; use
//     several distinct ones (exit banners quote single marker strings)
// Extend per agent via settings.env: MARKERS_agy='Antigravity|foo' (regex, any hit).
const PRESENCE_MARKERS = {
  pi: {
    title: [/^π - /],        // title-only: content viewport stays contaminated
    content: [],             // after exit (banner remains in scrollback)
  },
  // Best-effort defaults from the agents' documented idle UIs; override or add
  // via settings.env MARKERS_<kind>=<regex> (any-hit semantics). Multi-hit
  // content thresholds avoid matching a single quoted string in scrollback.
  claude: { title: [], content: [/Welcome to Claude Code/, /Claude Code/, /esc to (?:interrupt|clear)/, /╭[─━]{4,}/], minContent: 2 },
  codex:   { title: [], content: [/OpenAI Codex/, /codex v?\d/i, /esc to interrupt/, /⠋|⠙|⠹|⠸/], minContent: 2 },
  opencode: { title: [], content: [/opencode/i, /new (?:session|thread)/i, /Ctrl\+C/i, /▌/], minContent: 2 },
};

export function compileMarkers(cfg) {
  const out = {};
  for (const [k, v] of Object.entries(PRESENCE_MARKERS)) out[k] = v;
  for (const key of Object.keys(cfg)) {
    const m = key.match(/^MARKERS_([a-z0-9_-]+)$/i);
    if (m && cfg[key]) {
      try { out[m[1].toLowerCase()] = { title: [], content: [new RegExp(cfg[key])], minContent: 1 }; } catch (e) { warn(`invalid ${key} regex: ${e.message}`); }
    }
  }
  return out;
}

export function presenceMatch(kind, text, title, markers) {
  const m = markers[kind];
  if (!m) return false;
  if ((m.title || []).length) return m.title.some((re) => re.test(title || ''));
  const hits = (m.content || []).filter((re) => re.test(text || '')).length;
  return hits >= (m.minContent ?? 1);
}

// ---------------------------------------------------------------- layout ---
export function layoutTree(folder, kind) {
  const shell = {
    type: 'pane', label: 'shell', cwd: folder,
    command: ['devcontainer', 'exec', '--workspace-folder', folder, 'bash'],
    env: { HERDR_DC_FOLDER: folder },
  };
  if (!kind) return shell;
  return {
    type: 'split', direction: 'right', ratio: 0.65,
    first: shell,
    second: {
      type: 'pane', label: kind, cwd: folder,
      command: ['devcontainer', 'exec', '--workspace-folder', folder, kind],
      env: { HERDR_AGENT: kind, HERDR_DC_FOLDER: folder },
    },
  };
}

// layoutApply — exactly one of workspaceId / tabId (api schema: XOR).
export async function layoutApply({ workspaceId, tabId, tabLabel, root }) {
  if (!!workspaceId === !!tabId) throw new Error('layoutApply: exactly one of workspaceId/tabId');
  const params = { focus: false, root };
  if (workspaceId) params.workspace_id = workspaceId;   // exactly one id key,
  if (tabId) params.tab_id = tabId;                     // never both (0.9.3 contract)
  if (tabLabel) params.tab_label = tabLabel;             // null => keep herdr default naming
  const r = await apiRequest('layout.apply', params);
  if (!r.ok) {
    const msg = r.json?.error?.message || JSON.stringify(r.json) || 'failed';
    log(`layout.apply: ${msg}`);
    return false;
  }
  return true;
}

// ------------------------------------------------------------ space/panes ---
export function wsAlive(ws) { return hr(['workspace', 'get', ws]).ok; }

export function currentWorkspaceId() {
  try {
    const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
    if (ctx.workspace_id) return ctx.workspace_id;
  } catch { /* unparseable */ }
  if (process.env.HERDR_PANE_ID) return process.env.HERDR_PANE_ID.split(':')[0];
  return '';
}

export function panesOf(ws) {
  const r = hrJson(['pane', 'list']);
  if (!r.ok) return null;
  const panes = r.json?.result?.panes || [];
  return ws ? panes.filter((p) => p.workspace_id === ws) : panes;
}

// paneOpenFallback — split needs a target pane on herdr 0.9.3 (and some builds
// fail to forward --target-pane); fall back to a plain tab. Returns 'split' |
// 'tab' or throws with the CLI output.
export function paneOpenFallback(ws, entrypoint, envAssignments) {
  const argsFor = (placement, target) => [
    'plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', entrypoint,
    '--workspace', ws, '--placement', placement, '--no-focus',
    ...envAssignments.flatMap((kv) => ['--env', kv]),
    ...(target ? ['--target-pane', target, '--direction', 'right'] : []),
  ];
  const target = (panesOf(ws) || []).map((p) => p.pane_id)[0];
  if (target) {
    const r = hr(argsFor('split', target));
    if (r.stdout.includes('plugin_pane_opened')) return 'split';
  }
  const r = hr(argsFor('tab', null));
  if (r.stdout.includes('plugin_pane_opened')) return 'tab';
  throw new Error(`plugin pane open failed: ${(r.stdout || r.stderr).slice(0, 300)}`);
}

// withinRestoreGrace — session restore replays tab.created for every restored
// tab (observed on 0.9.3), which the conversion handler would multiply. The
// subscriber ignores events during this window after its own start.
export function withinRestoreGrace(startedAt, now = Date.now(), graceMs = 15000) {
  return now - startedAt < graceMs;
}

// reportSpaceSubtext — display-only sidebar metadata under the space name.
// herdr renders workspace metadata tokens dimmed in the sidebar; token name
// 'subtext' (set SUBTEXT_TOKEN= in settings.env to change, empty to disable).
export function reportSpaceSubtext(ws, cfg) {
  const token = cfg.SUBTEXT_TOKEN === undefined ? 'subtext' : cfg.SUBTEXT_TOKEN;
  if (!token) return;
  hr(['workspace', 'report-metadata', ws, '--source', 'custom:devcontainer-spaces',
    '--token', `${token}=devcontainer`]);
}
