#!/usr/bin/env node
// test/run-tests.js — unit + integration tests with mock engines and a mock herdr.
// Node port of run-tests.sh; the mock binaries in test/mock/bin are unchanged.
// Run: timeout 280 node test/run-tests.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SCRIPTS = path.join(ROOT, 'scripts');
const LIB = path.join(SCRIPTS, 'lib.js');
const BASE_PATH = process.env.PATH;
const T = { test: 30000 };   // per-test timeout: failure, never a hang

// self-watchdog: fires only if something else keeps the loop alive
setTimeout(() => { console.error('SUITE WATCHDOG: forced exit after 240s'); process.exit(124); }, 240000).unref();

// ---------------------------------------------------------------- helpers ---
let SC = null;
const cleanup = { procs: [], servers: [] };
function scenario(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `dcsp-${name}.`));
  for (const sub of ['stubs', 'state', 'config', 'home/project-a/.devcontainer', 'screens', 'xdg'])
    fs.mkdirSync(path.join(d, sub), { recursive: true });
  for (const f of fs.readdirSync(path.join(HERE, 'mock', 'bin'))) {
    fs.copyFileSync(path.join(HERE, 'mock', 'bin', f), path.join(d, 'stubs', f));
    fs.chmodSync(path.join(d, 'stubs', f), 0o755);
  }
  const env = {
    ...process.env,
    DOCKER_HOST: '', DOCKER_CONTEXT: '', CONTAINER_HOST: '', HERDR_SOCKET_PATH: '',
    PATH: `${path.join(d, 'stubs')}:${BASE_PATH}`,
    HERDR_BIN_PATH: path.join(d, 'stubs', 'herdr'),
    HERDR_API_STUB: path.join(d, 'stubs', 'herdr-api-stub'),
    HERDR_PLUGIN_STATE_DIR: path.join(d, 'state'),
    HERDR_PLUGIN_CONFIG_DIR: path.join(d, 'config'),
    MOCK: d,
    MOCK_ENGINES: path.join(d, 'engines.json'),
    MOCK_PANES: path.join(d, 'panes.json'),
    MOCK_CALLS: path.join(d, 'calls.log'),
    XDG_RUNTIME_DIR: path.join(d, 'xdg'),
    HERDR_SESSION: 'mock-1',
    HERDR_PLUGIN_EVENT_JSON: '',
    HERDR_PLUGIN_CONTEXT_JSON: '',
    MOCK_RULES: path.join(d, 'rules.json'),
    HOME: path.join(d, 'home'),
  };
  fs.writeFileSync(env.MOCK_CALLS, '');
  SC = { d, env, calls: env.MOCK_CALLS, stateDir: path.join(d, 'state') };
  return SC;
}
const calls = () => fs.readFileSync(SC.calls, 'utf8');
const engines = (obj) => fs.writeFileSync(SC.env.MOCK_ENGINES, JSON.stringify(obj));
const stateFile = (session = 'mock-1') => path.join(SC.stateDir, 'sessions', session, 'containers.json');
const stateJson = (session) => JSON.parse(fs.readFileSync(stateFile(session), 'utf8'));
const run = (script, args = [], extra = {}) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
  env: { ...SC.env, ...extra }, encoding: 'utf8', timeout: 50000,
});
const nodeLib = (code, extra = {}) => spawnSync(process.execPath, ['--input-type=module', '-e',
  `import * as lib from '${LIB}'; ${code}`], { env: { ...SC.env, ...extra }, encoding: 'utf8', timeout: 25000 });
const lastLayout = () => {
  const line = calls().split('\n').filter((l) => l.startsWith('LAYOUT ')).pop() || '';
  return { line, tree: JSON.parse(line.slice(line.indexOf('{'))) };
};
const C1 = (d) => ({ id: 'c1', state: 'running', folder: `${d}/home/project-a`, config: `${d}/home/project-a/.devcontainer/devcontainer.json` });
function pathScrub(cmd) {
  const dir = fs.mkdtempSync(path.join(SC.d, 'scrub.'));
  for (const p of BASE_PATH.split(':')) {
    let ents; try { ents = fs.readdirSync(p); } catch { continue; }
    for (const e of ents) {
      if (e === cmd || fs.existsSync(path.join(dir, e))) continue;
      try { fs.symlinkSync(path.join(p, e), path.join(dir, e)); } catch { /* race */ }
    }
  }
  return dir;
}
function track(p) { cleanup.procs.push(p); return p; }
async function mksock(p) {
  const srv = net.createServer();
  cleanup.servers.push(srv);
  await new Promise((res, rej) => srv.listen(p, res).once('error', rej));
  return srv;
}
after(() => {
  for (const p of cleanup.procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  for (const s of cleanup.servers) { try { s.close(); } catch { /* gone */ } }
});

// ---------------------------------------------------------------- tests -----
test('engine detection: docker rootful / podman rootless / none', { timeout: T.test }, () => {
  scenario('engine-detect');
  const probe = () => nodeLib(`const e=lib.detectEngine({ENGINE:'auto'});console.log(JSON.stringify({e, d:lib.describeEngine(e)}))`);
  engines({ mode: 'docker-rootful', containers: [] });
  let r = JSON.parse(probe().stdout);
  assert.equal(r.e.engine, 'docker');
  assert.equal(r.e.rootless, false);
  assert.equal(r.d, 'docker (docker, rootful)');
  engines({ mode: 'podman-rootless', containers: [] });
  r = JSON.parse(probe().stdout);
  assert.equal(r.e.engine, 'podman');
  assert.equal(r.e.rootless, true);
  assert.equal(r.d, 'podman (podman, rootless)');
  engines({ mode: 'none', containers: [] });
  assert.equal(nodeLib(`console.log(lib.detectEngine({ENGINE:'auto'})===null?'null':'x')`).stdout.trim(), 'null');
});

test('dc_list portability across engines', { timeout: T.test }, () => {
  scenario('dclist');
  engines({ mode: 'docker-rootful', containers: [C1(SC.d), { id: 'c2', state: 'exited', folder: '/srv/o/p', config: '/srv/x' }] });
  let rows = JSON.parse(nodeLib(`console.log(JSON.stringify(lib.dcList('docker')))`).stdout);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].id === 'c1' && rows[0].state === 'running' && rows[0].folder.includes('project-a'));
  engines({ mode: 'podman-rootless', containers: [C1(SC.d)] });
  rows = JSON.parse(nodeLib(`console.log(JSON.stringify(lib.dcList('podman')))`, {}).stdout);
  assert.equal(rows.length, 1);
});

test('discover end-to-end (AUTO_START_AGENTS=1)', { timeout: T.test }, () => {
  scenario('discover-basic');
  fs.writeFileSync(path.join(SC.d, 'config', 'settings.env'), 'AUTO_START_AGENTS=1\n');
  engines({ mode: 'docker-rootful', containers: [C1(SC.d)] });
  fs.writeFileSync(path.join(SC.d, 'agents-present'), 'claude\ncodex\n');
  const r = run('discover.js');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(/workspace\.create .*label=project-a /.test(calls()));
  assert.ok(calls().includes('layout.apply'));
  const st = stateJson();
  assert.deepEqual(Object.values(st)[0].agents, ['claude', 'codex']);
  const { line, tree } = lastLayout();
  assert.equal(tree.root.type, 'split');
  assert.equal(tree.root.first.command[0], 'devcontainer');
  assert.equal(tree.root.second.env.HERDR_AGENT, 'claude');
  assert.ok(line.includes('"tab_id"'), 'creation replaces the default root tab');
  assert.ok(!line.includes('"workspace_id"'), 'exactly one id key (XOR contract)');
  assert.ok(!line.includes('"tab_label"'), 'keep herdr default numbered naming');
  const n = (calls().match(/workspace\.create/g) || []).length;
  assert.equal(run('discover.js').status, 0);       // idempotent
  assert.equal((calls().match(/workspace\.create/g) || []).length, n);
});

test('discover default: no agent pane, kinds still recorded', { timeout: T.test }, () => {
  scenario('discover-no-autostart');
  engines({ mode: 'docker-rootful', containers: [C1(SC.d)] });
  fs.writeFileSync(path.join(SC.d, 'agents-present'), 'claude\n');
  assert.equal(run('discover.js').status, 0);
  const { tree } = lastLayout();
  assert.equal(tree.root.type, 'pane');
  assert.equal(tree.root.label, 'shell');
  assert.ok(!JSON.stringify(tree).includes('HERDR_AGENT'));
  assert.deepEqual(Object.values(stateJson())[0].agents, ['claude']);
});

test('discover: outside $HOME skipped', { timeout: T.test }, () => {
  scenario('discover-outside');
  engines({ mode: 'docker-rootful', containers: [{ id: 'c9', state: 'running', folder: '/srv/other/proj', config: '/x' }] });
  const r = run('discover.js');
  assert.ok(r.stderr.includes('outside $HOME'));
  assert.ok(!calls().includes('workspace.create'));
});

test('discover: stopped containers + AUTO_START_CONTAINERS', { timeout: T.test }, () => {
  scenario('discover-stopped');
  engines({ mode: 'docker-rootful', containers: [{ ...C1(SC.d), state: 'exited' }] });
  assert.ok(run('discover.js').stderr.includes('AUTO_START_CONTAINERS'));
  fs.writeFileSync(path.join(SC.d, 'config', 'settings.env'), 'AUTO_START_CONTAINERS=1\n');
  run('discover.js');
  assert.ok(calls().includes('devcontainer.up'));
});

test('discover: tombstone + resurrect', { timeout: T.test }, () => {
  scenario('discover-tomb');
  engines({ mode: 'docker-rootful', containers: [C1(SC.d)] });
  const tb = (f) => nodeLib(`console.log(lib.tombstonePath(process.env.TF))`, { TF: f }).stdout.trim();
  const tbp = tb(`${SC.d}/home/project-a`);          // resolve once: two
  fs.mkdirSync(path.dirname(tbp), { recursive: true }); // subprocess lookups can
  fs.writeFileSync(tbp, 'x');                           // diverge under load
  assert.ok(run('discover.js').stderr.includes('tombstoned'));
  assert.ok(run('discover.js', ['--resurrect']).stderr.includes('resurrecting'));
});

test('discover: podman-only machine generates scoped shim', { timeout: T.test }, () => {
  scenario('discover-podman-shim');
  engines({ mode: 'podman-rootless', containers: [{ ...C1(SC.d), id: 'p1' }] });
  fs.rmSync(path.join(SC.d, 'stubs', 'docker'));
  fs.writeFileSync(path.join(SC.d, 'agents-present'), 'claude\n');
  const shadow = pathScrub('docker');
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'discover.js')], {
    env: { ...SC.env, PATH: `${path.join(SC.d, 'stubs')}:${shadow}` }, encoding: 'utf8', timeout: 50000,
  });
  assert.ok(r.stderr.includes('created workspace'), r.stderr);
  const shim = path.join(SC.stateDir, 'shim', 'docker');
  assert.ok(fs.existsSync(shim) && fs.statSync(shim).mode & 0o111);
});

test('pane entrypoints exec into the container', { timeout: T.test }, () => {
  scenario('pane-entry');
  engines({ mode: 'docker-rootful', containers: [] });
  const a = run('pane-shell.js', [], { DEVCONTAINER_FOLDER: `${SC.d}/home/project-a` });
  assert.equal(a.status, 0, a.stderr);
  assert.ok(calls().includes(`devcontainer.exec exec --workspace-folder ${SC.d}/home/project-a bash`));
  const b = run('pane-agent.js', [], { DEVCONTAINER_FOLDER: `${SC.d}/home/project-a`, DC_AGENT_KIND: 'claude', HERDR_AGENT: 'claude' });
  assert.equal(b.status, 0, b.stderr);
  assert.ok(calls().includes(`devcontainer.exec exec --workspace-folder ${SC.d}/home/project-a claude`));
});

test('workspace.closed payload shapes', { timeout: T.test }, () => {
  scenario('event-payload');
  const tb = (f) => nodeLib(`console.log(lib.tombstonePath(process.env.TF))`, { TF: f }).stdout.trim();
  const map = { [`${SC.d}/home/project-a`]: { workspace_id: 'wX', container_id: 'c1', agents: [] } };
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(map));
  const ev = (obj, ctx = '') => run('on-workspace-closed.js', [], {
    HERDR_PLUGIN_EVENT_JSON: obj === undefined ? '' : JSON.stringify(obj), HERDR_PLUGIN_CONTEXT_JSON: ctx,
  });
  let r = ev({ event: 'workspace_closed', data: { type: 'workspace_closed', workspace_id: 'wX', workspace: null } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(tb(`${SC.d}/home/project-a`)));
  assert.ok(!stateJson()[`${SC.d}/home/project-a`]);
  fs.writeFileSync(stateFile(), JSON.stringify({ '/legacy/proj': { workspace_id: 'wY', container_id: 'c2', agents: [] } }));
  assert.ok(ev({ workspace_id: 'wY' }).status === 0);
  assert.ok(fs.existsSync(tb('/legacy/proj')));
  fs.writeFileSync(stateFile(), JSON.stringify({ '/ctx/proj': { workspace_id: 'wZ', container_id: 'c3', agents: [] } }));
  ev(undefined, JSON.stringify({ workspace_id: 'wZ' }));
  assert.ok(fs.existsSync(tb('/ctx/proj')));
  r = ev({ foo: 1 });
  assert.equal(r.status, 0);
  assert.ok(r.stderr.includes('keys: foo'));
});

test('shell-here: pane-id fallback + split->tab fallback', { timeout: T.test }, () => {
  scenario('shell-here');
  engines({ mode: 'docker-rootful', containers: [C1(SC.d)] });
  run('discover.js');
  const ws = Object.values(stateJson())[0].workspace_id;
  fs.writeFileSync(SC.env.MOCK_PANES, JSON.stringify({ result: { panes: [
    { pane_id: `${ws}:p1`, workspace_id: ws, tab_id: `${ws}:t1`, label: 'shell' }] } }));
  const env = { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ invocation_source: 'cli' }), HERDR_PANE_ID: `${ws}:p1` };
  let r = run('open-shell.js', [], env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(calls().includes(`pane.open entry=dc-shell ws=${ws} placement=split target=${ws}:p1`));
  assert.ok(r.stderr.includes('(split)'));
  r = run('open-shell.js', [], { ...env, MOCK_PANE_OPEN_MODE: 'fail-split' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(calls().includes('placement=tab'));
  assert.ok(r.stderr.includes('(tab)'));
});

test('session-scoped state', { timeout: T.test }, () => {
  scenario('session-scope');
  engines({ mode: 'docker-rootful', containers: [C1(SC.d)] });
  run('discover.js', [], { HERDR_SESSION: 'sesA' });
  run('discover.js', [], { HERDR_SESSION: 'sesB' });
  assert.ok(fs.existsSync(stateFile('sesA')));
  assert.ok(fs.existsSync(stateFile('sesB')));
  assert.ok(!fs.existsSync(path.join(SC.stateDir, 'containers.json')));
});

test('socket routing precedence', { timeout: T.test }, async () => {
  scenario('socket-routing');
  const cfg = path.join(SC.d, 'home', '.config', 'herdr');
  fs.mkdirSync(path.join(cfg, 'sessions', 'sesX'), { recursive: true });
  await mksock(path.join(cfg, 'herdr.sock'));
  await mksock(path.join(cfg, 'sessions', 'sesX', 'herdr.sock'));
  const r1 = nodeLib(`console.log(lib.socketPath())`, { HERDR_SESSION: 'sesX', HERDR_SOCKET_PATH: '' });
  assert.equal(r1.stdout.trim(), path.join(cfg, 'sessions', 'sesX', 'herdr.sock'));
  const r2 = nodeLib(`console.log(lib.socketPath())`, { HERDR_SESSION: 'sesX', HERDR_SOCKET_PATH: '/tmp/explicit.sock' });
  assert.equal(r2.stdout.trim(), '/tmp/explicit.sock');
});

test('terminal conversion guards (tab/pane events)', { timeout: T.test }, () => {
  scenario('terminal-conversion');
  engines({ mode: 'docker-rootful', containers: [C1(SC.d)] });
  run('discover.js');
  const ws = Object.values(stateJson())[0].workspace_id;
  const seed = (panes) => fs.writeFileSync(SC.env.MOCK_PANES, JSON.stringify({ result: { panes } }));
  const ev = (obj) => run('on-terminal-created.js', [], { HERDR_PLUGIN_EVENT_JSON: JSON.stringify(obj) });

  seed([{ pane_id: `${ws}:p5`, workspace_id: ws, tab_id: `${ws}:t9`, label: '' }]);
  ev({ event: 'tab_created', data: { type: 'tab_created', tab: { tab_id: `${ws}:t9`, workspace_id: ws, label: '' } } });
  let layout = lastLayout().line;
  assert.ok(layout.includes(`"tab_id":"${ws}:t9"`), layout);
  assert.ok(!layout.includes('"tab_label"'), 'unnamed tab keeps herdr default naming');

  // popup-named tab keeps its name through conversion
  seed([{ pane_id: `${ws}:p6`, workspace_id: ws, tab_id: `${ws}:tA`, label: '' }]);
  ev({ event: 'tab_created', data: { type: 'tab_created', tab: { tab_id: `${ws}:tA`, workspace_id: ws, label: 'my-work' } } });
  layout = lastLayout().line;
  assert.ok(layout.includes('"tab_label":"my-work"'), layout);

  const layouts = () => calls().split('\n').filter((l) => l.startsWith('LAYOUT ')).length;
  const n = layouts();
  seed([{ pane_id: `${ws}:p5`, workspace_id: ws, tab_id: `${ws}:t9`, label: 'shell' }]);
  ev({ event: 'tab_created', data: { type: 'tab_created', tab: { tab_id: `${ws}:t9`, workspace_id: ws, label: 'devcontainer' } } });
  assert.equal(layouts(), n, 'already-converted tab untouched');
  ev({ event: 'tab_created', data: { type: 'tab_created', tab: { tab_id: 'wX:t8', workspace_id: 'wX', label: '' } } });
  assert.equal(layouts(), n, 'unmanaged workspace untouched');

  seed([
    { pane_id: `${ws}:p1`, workspace_id: ws, tab_id: `${ws}:t2`, label: 'shell' },
    { pane_id: `${ws}:p2`, workspace_id: ws, tab_id: `${ws}:t2`, label: '' },
  ]);
  ev({ event: 'pane_created', data: { type: 'pane_created', pane: { pane_id: `${ws}:p2`, workspace_id: ws, tab_id: `${ws}:t2`, label: '' } } });
  assert.ok(calls().includes(`pane.run ${ws}:p2 exec devcontainer exec --workspace-folder`));

  const runs = () => (calls().match(/^pane\.run/gm) || []).length;
  const m = runs();
  ev({ event: 'pane_created', data: { type: 'pane_created', pane: { pane_id: `${ws}:p1`, workspace_id: ws, tab_id: `${ws}:t2`, label: 'shell' } } });
  ev({ event: 'pane_created', data: { type: 'pane_created', pane: { pane_id: `${ws}:p7`, workspace_id: ws, tab_id: `${ws}:t9`, label: '' } } });
  assert.equal(runs(), m, 'labeled/native-tab panes left alone');
});

test('concurrent rescans create exactly one space', { timeout: T.test }, async () => {
  scenario('rescan-race');
  engines({ mode: 'docker-rootful', containers: [C1(SC.d)] });
  const ps = ['a', 'b'].map(() => track(spawn(process.execPath, [path.join(SCRIPTS, 'discover.js')], { env: SC.env, stdio: 'ignore' })));
  await Promise.all(ps.map((p) => new Promise((r) => p.on('exit', r))));
  assert.equal((calls().match(/workspace\.create/g) || []).length, 1);
});

test('startup: watcher spawn + held-lock skip', { timeout: 60000 }, async () => {
  scenario('startup-guard');
  engines({ mode: 'docker-rootful', containers: [C1(SC.d)] });
  const procsOf = (script, session) => spawnSync('sh', ['-c',
    `for p in $(pgrep -f "scripts/${script}" 2>/dev/null); do tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -q "^HERDR_SESSION=${session}$" && echo $p; done`],
    { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  const kill = (pids) => pids.forEach((p) => { try { process.kill(Number(p), 'SIGTERM'); } catch { /* gone */ } });
  assert.equal(run('startup.js', [], { HERDR_SESSION: 'guardA' }).status, 0);
  await new Promise((r) => setTimeout(r, 900));
  kill([...procsOf('watcher.js', 'guardA'), ...procsOf('events-subscribe.js', 'guardA')]);
  await new Promise((r) => setTimeout(r, 500));
  const holder = track(spawn('flock', [path.join(SC.stateDir, 'sessions', 'guardA', 'watcher.lock'), 'sleep', '3'], { stdio: 'ignore' }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(run('startup.js', [], { HERDR_SESSION: 'guardA' }).status, 0);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(procsOf('watcher.js', 'guardA').length, 0, 'no duplicate watcher while lock held');
  assert.ok(procsOf('events-subscribe.js', 'guardA').length >= 1, 'subscriber independent of watcher lock');
  holder.kill();
  // the second startup's subscriber is a live daemon too - always reap both,
  // or every suite run leaks one (it attaches to the primary socket!)
  kill([...procsOf('watcher.js', 'guardA'), ...procsOf('events-subscribe.js', 'guardA')]);
  await new Promise((r) => setTimeout(r, 300));
});

test('presence markers: title + multi-hit content; exit banner does not match', { timeout: T.test }, async () => {
  scenario('presence');
  const piRunning = '      ▄▀▀▄        Antigravity-Mode\nGLM-5.3-Flash (always)\npi-agy-mode · agy-compatible surface\n';
  const piExitBanner = '⬢ Antigravity-Mode (always)\n\nroot ➜ /workspaces/x $ ';
  const bare = 'root@container:~$ ';
  const hit = (t, title, k = 'pi') => nodeLib(
    `console.log(lib.presenceMatch(process.env.K, process.env.T, process.env.TITLE, lib.compileMarkers({})))`,
    { T: t, TITLE: title, K: k }).stdout.trim();
  assert.equal(hit(piRunning, 'π - my-project'), 'true', 'running: pi title');
  assert.equal(hit(piRunning, '@abc123: /bin/bash'), 'false', 'banner in viewport + cleared title = agent gone (title-only for pi)');
  assert.equal(hit(piExitBanner, '@abc123: /bin/bash'), 'false', 'exit banner + cleared title');
  assert.equal(hit(bare, '@abc123: /bin/bash'), 'false', 'bare prompt');
  assert.equal(hit('hati@monster: ~/x', 'hati@monster: ~/x'), 'false', 'host prompt');
  // claude / codex / opencode: multi-hit content defaults + prompt guard
  assert.equal(hit('Welcome to Claude Code\n╭──────────╮\n claude', '@c: /bin/bash', 'claude'), 'true', 'claude idle UI');
  assert.equal(hit('some log line', '@c: /bin/bash', 'claude'), 'false', 'claude: single stray string');
  assert.equal(hit('Welcome to Claude Code\nClaude Code\n\nroot ➜ /workspaces/x $ ', '@c: /bin/bash', 'claude'), 'false', 'claude exited: banner in scrollback + prompt at bottom');
  assert.equal(hit('OpenAI Codex v0.9\nesc to interrupt', '@c: /bin/bash', 'codex'), 'true', 'codex idle UI');
  assert.equal(hit('OpenAI Codex\nesc to interrupt\n$ ', '@c: /bin/bash', 'codex'), 'false', 'codex exited: prompt at bottom');
  assert.equal(hit('opencode\nCtrl+C to exit', '@c: /bin/bash', 'opencode'), 'true', 'opencode idle UI');
  assert.equal(hit('opencode\nCtrl+C to exit\nroot@x:~# ', '@c: /bin/bash', 'opencode'), 'false', 'opencode exited: prompt at bottom');
  assert.equal(hit('Model scope: glm-5.3\nescape interrupt · ctrl+c/ctrl+d clear/exit\n0.0%/1.0M (auto)', '@c: /bin/bash', 'pi'), 'true', 'real pi idle in devcontainer');
  assert.equal(hit('Model scope: glm-5.3\nescape interrupt\nroot@x:~$ ', '@c: /bin/bash', 'pi'), 'false', 'pi exited: prompt at bottom');
  assert.equal(hit('Ask anything… "What is the tech stack?"\ntab agents\nctrl+p commands', '@c: /bin/bash', 'opencode'), 'true', 'real opencode idle in devcontainer');
  assert.equal(hit('Ask anything…\ntab agents\nroot@x:~$ ', '@c: /bin/bash', 'opencode'), 'false', 'opencode exited: prompt at bottom');
  assert.equal(nodeLib(`console.log(lib.presenceMatch('agy', 'MY-AGY-BANNER', '', lib.compileMarkers({MARKERS_agy: 'MY-AGY-BANNER'})))`).stdout.trim(), 'true', 'user override');
});

test('restore grace + space subtext + repair', { timeout: T.test }, () => {
  scenario('restore-grace');
  const g = nodeLib(`console.log(lib.withinRestoreGrace(Number(process.env.S), Number(process.env.E), 15000))`, { S: '1000', E: '14000' });
  assert.equal(g.stdout.trim(), 'true', 'within grace window');
  const g2 = nodeLib(`console.log(lib.withinRestoreGrace(Number(process.env.S), Number(process.env.E), 15000))`, { S: '1000', E: '20000' });
  assert.equal(g2.stdout.trim(), 'false', 'past grace window');

  // subtext reported on discover (metadata call recorded by mock herdr)
  engines({ mode: 'docker-rootful', containers: [C1(SC.d)] });
  run('discover.js');
  assert.ok(calls().includes('workspace.report-metadata'), 'subtext metadata reported');
  assert.ok(calls().includes('--token subtext=devcontainer'));

  // repair: tracked space whose panes lost our labels gets its layout back
  const ws = Object.values(stateJson())[0].workspace_id;
  fs.writeFileSync(SC.env.MOCK_PANES, JSON.stringify({ result: { panes: [
    { pane_id: `${ws}:p1`, workspace_id: ws, tab_id: `${ws}:t1`, label: '' }] } }));
  const layouts0 = calls().split('\n').filter((l) => l.startsWith('LAYOUT ')).length;
  const r = run('discover.js');
  assert.equal(calls().split('\n').filter((l) => l.startsWith('LAYOUT ')).length, layouts0 + 1, 'repaired layout re-applied');
  assert.ok(r.stderr.includes('repaired devcontainer tab layout'));
});

test('engine events: container start triggers discovery, die marks the space', { timeout: 60000 }, async () => {
  scenario('engine-events');
  engines({ mode: 'docker-rootful', containers: [] });          // nothing yet
  const evFile = `${SC.env.MOCK_ENGINES}.events`;
  fs.writeFileSync(evFile, '');
  const logF = path.join(SC.d, 'watcher.log');
  const w = track(spawn(process.execPath, [path.join(SCRIPTS, 'watcher.js')], {
    env: { ...SC.env, POLL_SECS: '0.3' }, stdio: ['ignore', fs.openSync(logF, 'a'), fs.openSync(logF, 'a')],
  }));
  await new Promise((r) => setTimeout(r, 700));
  // a closed (tombstoned) space returns when its container restarts
  const tb = (f) => nodeLib(`console.log(lib.tombstonePath(process.env.TF))`, { TF: f }).stdout.trim();
  fs.writeFileSync(tb(`${SC.d}/home/project-a`), 'x');
  // a devcontainer comes up
  engines({ mode: 'docker-rootful', containers: [C1(SC.d)] });
  fs.appendFileSync(evFile, JSON.stringify({ Action: 'start', id: 'c1', Actor: { Attributes: { 'devcontainer.local_folder': `${SC.d}/home/project-a` } } }) + '\n');
  await new Promise((r) => setTimeout(r, 2500));
  const wl = () => fs.readFileSync(logF, 'utf8');
  assert.ok(wl().includes('devcontainer started'), 'start event seen');
  assert.ok(!fs.existsSync(tb(`${SC.d}/home/project-a`)), 'restart cleared the tombstone');
  assert.ok(calls().includes('workspace.create'), 'discovery ran from engine event');
  // it dies
  fs.appendFileSync(evFile, JSON.stringify({ Action: 'die', id: 'c1', Actor: { Attributes: { 'devcontainer.local_folder': `${SC.d}/home/project-a` } } }) + '\n');
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(wl().includes('devcontainer died'), 'die event seen');
  assert.ok(calls().includes('subtext=devcontainer (stopped)'), 'space marked stopped');
  w.kill('SIGTERM');
  await new Promise((r) => w.on('exit', r));
});

test('watcher: report/release of in-shell agent', { timeout: 60000 }, async () => {
  scenario('watcher-basic');
  engines({ mode: 'docker-rootful', containers: [C1(SC.d)] });
  fs.writeFileSync(path.join(SC.d, 'agents-present'), 'claude\n');
  run('discover.js');
  const ws = Object.values(stateJson())[0].workspace_id;
  const seed = (panes) => fs.writeFileSync(SC.env.MOCK_PANES, JSON.stringify({ result: { panes } }));
  seed([
    { pane_id: `${ws}:p1`, workspace_id: ws, tab_id: `${ws}:t2`, label: 'shell' },
    { pane_id: `${ws}:p2`, workspace_id: ws, tab_id: `${ws}:t3`, label: 'claude' },
  ]);
  const rules = (o) => fs.writeFileSync(path.join(SC.d, 'rules.json'), JSON.stringify(o));
  const screen = (p, t) => fs.writeFileSync(path.join(SC.d, 'screens', `${ws}:${p}.txt`), t);
  rules({ claude: { marker: 'claude ui on screen', state: 'working' } });
  screen('p1', 'claude ui on screen\n'); screen('p2', 'claude ui on screen\n');
  const logF = path.join(SC.d, 'watcher.log');
  const w = track(spawn(process.execPath, [path.join(SCRIPTS, 'watcher.js')], {
    env: { ...SC.env, POLL_SECS: '0.3' }, stdio: ['ignore', fs.openSync(logF, 'a'), fs.openSync(logF, 'a')],
  }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1300);
  const wl = () => fs.readFileSync(logF, 'utf8');
  assert.ok(/agent=claude state=working/.test(wl()), wl());
  assert.ok(wl().includes(`pane ${ws}:p1: agent=claude`));
  assert.ok(!wl().includes(`pane ${ws}:p2:`), 'dedicated agent pane skipped');
  assert.ok(calls().includes('pane.report-agent'));
  // turn completion: agent finishes working and transitions to idle while screen remains
  rules({ claude: { marker: 'claude ui on screen', state: 'fallback-idle' } });
  await wait(1300);
  assert.ok(/agent=claude state=idle/.test(wl()), 'turn completion detected (working -> idle)');
  screen('p1', 'just a shell prompt\n');
  rules({ claude: { marker: 'claude ui on screen', state: 'fallback-idle' } });
  await wait(1300);
  assert.ok(wl().includes('released claude'));
  assert.ok(/release-agent[^\n]*--seq/.test(calls()), 'release carries --seq');
  // re-launch in the same terminal: seq must CONTINUE (report > release seq),
  // else herdr drops the report and the agent never reappears
  rules({ claude: { marker: 'claude ui on screen', state: 'working' } });
  screen('p1', 'claude ui on screen\n');
  await wait(1300);
  assert.ok(/report-agent[^\n]*--seq 4(?:\s|$)/.test(calls()), 're-launch reports with incremented seq');
  assert.ok((wl().match(/agent=claude state=working/g) || []).length >= 2, 're-detected after re-launch');
  w.kill('SIGTERM');
  await new Promise((r) => w.on('exit', r));
});

test('duplicate-space: creates new space with single devcontainer shell', { timeout: T.test }, () => {
  scenario('duplicate-space');
  engines({ mode: 'docker-rootful', containers: [C1(SC.d)] });
  run('discover.js');
  const ws1 = Object.values(stateJson())[0].workspace_id;
  const r = run('duplicate-space.js', [], { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: ws1 }) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes('applied single devcontainer shell layout'), r.stderr);
  assert.ok(r.stderr.includes('project-a-2'), r.stderr);
  const c = stateJson();
  const folder = Object.keys(c)[0];
  assert.ok(Array.isArray(c[folder].secondary_workspaces), 'secondary_workspaces present');
  assert.equal(c[folder].secondary_workspaces.length, 1);
  const ws2 = c[folder].secondary_workspaces[0];
  const f = nodeLib(`console.log(lib.state.folderForWs(process.env.WS))`, { WS: ws2 }).stdout.trim();
  assert.equal(f, folder, 'folderForWs resolves secondary workspace');
});

test('discover: RESURRECT_ON_RESCAN config setting resurrects closed space', { timeout: T.test }, () => {
  scenario('resurrect-config');
  engines({ mode: 'docker-rootful', containers: [C1(SC.d)] });
  run('discover.js');
  const ws = Object.values(stateJson())[0].workspace_id;
  run('on-workspace-closed.js', [], { HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ data: { workspace_id: ws } }) });
  const rSkip = run('discover.js');
  assert.ok(rSkip.stderr.includes('tombstoned; use resurrect'));
  const rRes = run('discover.js', [], { RESURRECT_ON_RESCAN: '1' });
  assert.ok(rRes.stderr.includes('resurrecting'), rRes.stderr);
});

test('watcher: pi custom spinner working -> turn completion -> release', { timeout: 60000 }, async () => {
  scenario('watcher-pi');
  engines({ mode: 'docker-rootful', containers: [C1(SC.d)] });
  fs.writeFileSync(path.join(SC.d, 'agents-present'), 'pi\n');
  run('discover.js');
  const ws = Object.values(stateJson())[0].workspace_id;
  const seed = (panes) => fs.writeFileSync(SC.env.MOCK_PANES, JSON.stringify({ result: { panes } }));
  seed([
    { pane_id: `${ws}:p1`, workspace_id: ws, tab_id: `${ws}:t2`, label: 'shell' },
  ]);
  const screen = (p, t) => fs.writeFileSync(path.join(SC.d, 'screens', `${ws}:${p}.txt`), t);
  const logF = path.join(SC.d, 'watcher.log');
  const w = track(spawn(process.execPath, [path.join(SCRIPTS, 'watcher.js')], {
    env: { ...SC.env, POLL_SECS: '0.3' }, stdio: ['ignore', fs.openSync(logF, 'a'), fs.openSync(logF, 'a')],
  }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const wl = () => fs.readFileSync(logF, 'utf8');

  // 1. Pi is working with custom spinner
  screen('p1', '── · Nucleating… ───────────────────────────────────────────────\n2.3%/1.0M (auto)\n');
  await wait(1200);
  assert.ok(/agent=pi state=working/.test(wl()), 'pi working detected with custom spinner');

  // 2. Pi turn completes: spinner gone, answer and prompt rendered
  screen('p1', 'Model scope: glm-5.3\nescape interrupt · ctrl+c/ctrl+d clear/exit\n✻ Turn took 5s\n● Hi there!\n');
  await wait(1200);
  assert.ok(/agent=pi state=idle/.test(wl()), 'pi turn completion detected (working -> idle)');

  // 3. User exits Pi back to bash prompt
  screen('p1', 'root@e4bd23f2b44b:/workspaces$ ');
  await wait(1200);
  assert.ok(wl().includes('released pi'), 'pi released when shell prompt returns');

  w.kill('SIGTERM');
  await new Promise((r) => w.on('exit', r));
});

test('watcher: opencode idle detection -> working -> turn completion -> release', { timeout: 60000 }, async () => {
  scenario('watcher-opencode');
  engines({ mode: 'docker-rootful', containers: [C1(SC.d)] });
  fs.writeFileSync(path.join(SC.d, 'agents-present'), 'opencode\n');
  run('discover.js');
  const ws = Object.values(stateJson())[0].workspace_id;
  const seed = (panes) => fs.writeFileSync(SC.env.MOCK_PANES, JSON.stringify({ result: { panes } }));
  seed([
    { pane_id: `${ws}:p1`, workspace_id: ws, tab_id: `${ws}:t2`, label: 'shell' },
  ]);
  const rules = (o) => fs.writeFileSync(path.join(SC.d, 'rules.json'), JSON.stringify(o));
  const screen = (p, t) => fs.writeFileSync(path.join(SC.d, 'screens', `${ws}:${p}.txt`), t);
  const logF = path.join(SC.d, 'watcher.log');
  const w = track(spawn(process.execPath, [path.join(SCRIPTS, 'watcher.js')], {
    env: { ...SC.env, POLL_SECS: '0.3' }, stdio: ['ignore', fs.openSync(logF, 'a'), fs.openSync(logF, 'a')],
  }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const wl = () => fs.readFileSync(logF, 'utf8');

  // 1. OpenCode launches idle (no interrupt hint)
  screen('p1', 'Ask anything… "What is the tech stack?"\ntab agents\nctrl+p commands\n');
  rules({ opencode: { marker: 'Ask anything', state: 'fallback-idle' } });
  await wait(1200);
  assert.ok(/agent=opencode state=idle/.test(wl()), 'opencode idle detected on launch');

  // 2. OpenCode working on a query
  screen('p1', 'opencode working\nesc to interrupt\n');
  rules({ opencode: { marker: 'esc to interrupt', state: 'working' } });
  await wait(1200);
  assert.ok(/agent=opencode state=working/.test(wl()), 'opencode working detected');

  // 3. OpenCode turn completes
  screen('p1', 'Ask anything… "What is the tech stack?"\ntab agents\nctrl+p commands\n');
  rules({ opencode: { marker: 'Ask anything', state: 'fallback-idle' } });
  await wait(1200);
  assert.ok((wl().match(/agent=opencode state=idle/g) || []).length >= 2, 'opencode turn completion detected (working -> idle)');

  // 4. OpenCode exits back to shell prompt
  screen('p1', 'root@e4bd23f2b44b:/workspaces$ ');
  await wait(1200);
  assert.ok(wl().includes('released opencode'), 'opencode released when shell prompt returns');

  w.kill('SIGTERM');
  await new Promise((r) => w.on('exit', r));
});


