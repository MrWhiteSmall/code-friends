import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Clash, ClashGuard } from '../src/clash.mjs';

function fixture(options = {}) {
  const ps = {
    group: { type: 'Selector', now: '日本自选', all: ['日本自选', '🇯🇵日本 A', '🇯🇵日本 B', '🇺🇸美国'] },
    日本自选: { type: 'URLTest', now: '🇯🇵日本 A', all: ['🇯🇵日本 A', '🇯🇵日本 B'] },
    '🇯🇵日本 A': { type: 'Vless' }, '🇯🇵日本 B': { type: 'Vless' }, '🇺🇸美国': { type: 'Vless' },
  };
  const selections = [], probes = [];
  let now = 0, cleanup = 0;
  const clash = {
    mode: async () => 'rule',
    proxies: async () => structuredClone(ps),
    reachable: async node => { probes.push(node); return node === '🇯🇵日本 B' ? 100 : null; },
    select: async (group, node) => { selections.push(node); ps[group].now = node; },
    closeTelegramConnections: async () => { cleanup++; return 2; },
  };
  const guard = new ClashGuard(clash, { group: 'group', now: () => now, report: s => s, ...options });
  return { ps, clash, guard, probes, selections, cleanup: () => cleanup, setNow: value => { now = value; } };
}

test('two failed probes switch to a tested Japanese node and keep healthy nodes without churn', async () => {
  const { guard, selections, cleanup } = fixture();
  assert.equal((await guard.check()).status, 'retrying');
  assert.deepEqual(selections, []);
  const result = await guard.check();
  assert.equal(result.status, 'switched');
  assert.deepEqual(selections, ['🇯🇵日本 B']);
  assert.equal(cleanup(), 1);
  assert.equal(result.closed, 2);
  await guard.check();
  assert.equal(selections.length, 1);
});

test('all nodes failing, a non-Japanese manual choice, and disabled guard never change selection', async () => {
  const bad = fixture();
  bad.clash.reachable = async () => null;
  await bad.guard.check();
  assert.equal((await bad.guard.check()).status, 'unavailable');
  assert.deepEqual(bad.selections, []);
  const manual = fixture();
  manual.ps.group.now = '🇺🇸美国';
  assert.equal((await manual.guard.check()).status, 'paused');
  assert.deepEqual(manual.probes, []);
  const disabled = fixture({ canSwitch: () => false });
  await disabled.guard.check();
  assert.equal((await disabled.guard.check()).status, 'disabled');
  assert.deepEqual(disabled.selections, []);
  const global = fixture();
  global.clash.mode = async () => 'global';
  assert.equal((await global.guard.check()).status, 'paused');
  assert.deepEqual(global.probes, []);
});

test('manual or native node changes during candidate tests are preserved', async () => {
  const f = fixture();
  f.clash.reachable = async node => {
    if (node === '🇯🇵日本 B') { f.ps.group.now = '🇺🇸美国'; return 100; }
    return null;
  };
  await f.guard.check();
  assert.equal((await f.guard.check()).status, 'changed');
  assert.deepEqual(f.selections, []);
});

test('switch cooldown and concurrent checks prevent repeated switching', async () => {
  const f = fixture();
  await f.guard.check();
  await Promise.all([f.guard.check(), f.guard.check()]);
  assert.equal(f.selections.length, 1);
  f.clash.reachable = async node => node === '🇯🇵日本 A' ? 90 : null;
  await f.guard.check();
  await f.guard.check();
  assert.equal(f.selections.length, 1);
  f.setNow(180000);
  assert.equal((await f.guard.check()).status, 'switched');
  assert.deepEqual(f.selections, ['🇯🇵日本 B', '🇯🇵日本 A']);
});

test('native URLTest rotations across broken nodes do not reset consecutive failure counts', async () => {
  const f = fixture();
  f.ps['日本自选'].all.push('🇯🇵日本 C');
  f.ps['🇯🇵日本 C'] = { type: 'Vless' };
  await f.guard.check();
  f.ps['日本自选'].now = '🇯🇵日本 C';
  assert.equal((await f.guard.check()).status, 'switched');
  assert.deepEqual(f.selections, ['🇯🇵日本 B']);
});

test('a native URLTest recovery during candidate probes is kept', async () => {
  const f = fixture();
  f.clash.reachable = async node => {
    if (node === '🇯🇵日本 B') { f.ps['日本自选'].now = node; return 90; }
    return null;
  };
  await f.guard.check();
  assert.equal((await f.guard.check()).status, 'healthy');
  assert.deepEqual(f.selections, []);
});

test('connection cleanup failure still records the switch and cooldown', async () => {
  const f = fixture();
  f.clash.closeTelegramConnections = async () => { throw new Error('unavailable'); };
  await f.guard.check();
  const result = await f.guard.check();
  assert.equal(result.status, 'switched');
  assert.match(result.cleanupError, /清理失败/);
  assert.equal(f.selections.length, 1);
});

test('native controller bypasses proxy env, encodes node names, and closes only Telegram connections in the controlled group', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cf-clash-'));
  const calls = [];
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer local-secret');
    const url = new URL(req.url, 'http://localhost');
    calls.push({ path: url.pathname, method: req.method });
    let result = {};
    if (url.pathname.endsWith('/delay')) {
      assert.equal(url.searchParams.get('url'), 'https://api.telegram.org');
      result = { delay: 100 };
    }
    if (url.pathname === '/connections') result = { connections: [
      { id: 'tg1', metadata: { host: 'api.telegram.org' }, chains: ['group'] },
      { id: 'tg2', metadata: { host: 'flora.web.telegram.org' }, chains: ['group'] },
      { id: 'other', metadata: { host: 'chatgpt.com' }, chains: ['group'] },
      { id: 'fake', metadata: { host: 'nottelegram.org' }, chains: ['group'] },
      { id: 'another-group', metadata: { host: 'api.telegram.org' }, chains: ['other'] },
    ] };
    res.end(JSON.stringify(result));
  });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = join(root, 'config.yaml');
  await writeFile(config, `external-controller: 127.0.0.1:${server.address().port}\nsecret: 'local-secret'\n`);
  const clash = new Clash(config);
  assert.equal(await clash.reachable('🇯🇵日本 / A'), 100);
  assert.ok(calls[0].path.includes(encodeURIComponent('🇯🇵日本 / A')));
  assert.equal(await clash.closeTelegramConnections('group'), 2);
  assert.deepEqual(calls.filter(x => x.method === 'DELETE').map(x => x.path), ['/connections/tg1', '/connections/tg2']);
  const code = `import { Clash } from ${JSON.stringify(new URL('../src/clash.mjs', import.meta.url).href)}; console.log(await new Clash(${JSON.stringify(config)}).reachable('日本 A'));`;
  const result = await promisify(execFile)(process.execPath, ['--use-env-proxy', '--input-type=module', '-e', code], {
    env: { ...process.env, http_proxy: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1',
      https_proxy: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', no_proxy: '', NO_PROXY: '' },
    timeout: 15000,
  });
  assert.equal(result.stdout.trim(), '100', 'controller must bypass a broken environment proxy');
  await writeFile(config, 'external-controller: 0.0.0.0:9097\nsecret: local-secret\n');
  assert.throws(() => clash.call('/proxies'), /回环地址/);
});
