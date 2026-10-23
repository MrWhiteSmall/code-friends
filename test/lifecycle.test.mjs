import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectService, startService, stopService } from '../src/lifecycle.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-friends-service-'));
  for (const name of ['src', 'scripts', '.local']) mkdirSync(join(root, name));
  writeFileSync(join(root, '.local', 'state.json'), JSON.stringify({ owner: { chatId: 1, userId: 1 }, addresses: { a: { code: 'c1', alias: '登录' } } }));
  writeFileSync(join(root, 'scripts', 'run.zsh'), '#!/bin/zsh\ntask_dir=${0:A:h:h}\nexec node "$task_dir/src/main.mjs"\n');
  writeFileSync(join(root, 'src', 'main.mjs'), `
    import {writeFileSync, unlinkSync} from 'node:fs';
    import {dirname, join} from 'node:path';
    import {fileURLToPath} from 'node:url';
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const pidPath = join(root, '.local', 'bridge.pid');
    writeFileSync(pidPath, String(process.pid));
    writeFileSync(join(root, '.local', 'runtime.json'), JSON.stringify({pid:process.pid,status:'running'}));
    const timer = setInterval(() => {}, 1000);
    process.on('SIGTERM', () => {clearInterval(timer);unlinkSync(pidPath);process.exit(0);});
  `);
  return root;
}

test('start, duplicate start and stop operate only on the detached bridge', async () => {
  const root = fixture();
  try {
    const first = await startService(root, 8000);
    assert.equal(first.running, true);
    assert.equal(first.paired, true);
    assert.equal(inspectService(root).pid, first.pid);
    assert.equal((await startService(root, 8000)).pid, first.pid);
    assert.equal((statSync(join(root, '.local', 'bridge.log')).mode & 0o777), 0o600);
    await stopService(root);
    assert.equal(inspectService(root).running, false);
    assert.equal(inspectService(root).paired, true);
    assert.equal(JSON.parse(readFileSync(join(root, '.local', 'state.json'))).addresses.a.alias, '登录');
    assert.equal((await stopService(root)).alreadyStopped, true);
  } finally { await stopService(root); rmSync(root, { recursive: true }); }
});

test('a force-killed bridge leaves a stale PID that the next start recovers', async () => {
  const root = fixture();
  try {
    const first = await startService(root, 8000);
    process.kill(first.pid, 'SIGKILL');
    for (let i = 0; i < 50 && inspectService(root).running; i++) await pause(50);
    const stopped = inspectService(root);
    assert.equal(stopped.running, false);
    assert.equal(stopped.stalePid, true);
    const next = await startService(root, 8000);
    assert.equal(next.running, true);
    assert.notEqual(next.pid, first.pid);
    assert.equal(next.paired, true);
  } finally { await stopService(root); rmSync(root, { recursive: true }); }
});

test('a PID belonging to another process is never reported or stopped as the bridge', async () => {
  const root = fixture();
  try {
    writeFileSync(join(root, '.local', 'bridge.pid'), String(process.pid));
    assert.equal(inspectService(root).running, false);
    await stopService(root);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
    assert.equal(existsSync(join(root, '.local', 'bridge.pid')), false);
  } finally { rmSync(root, { recursive: true }); }
});
