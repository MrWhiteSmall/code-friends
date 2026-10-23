import test from 'node:test';
import assert from 'node:assert/strict';
import { Addresses } from '../src/addresses.mjs';
import { State } from '../src/state.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('addresses keep the same task identity across restart and discovery order', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-friends-addresses-'));
  try {
    let state = new State(directory);
    let addresses = new Addresses(state.data.addresses);
    addresses.ensure('task-a'); addresses.ensure('task-b');
    addresses.rename('c1', '登录'); state.save();
    state = new State(directory); addresses = new Addresses(state.data.addresses);
    addresses.ensure('task-b'); addresses.ensure('task-c');
    assert.equal(addresses.find('登录'), 'task-a');
    assert.equal(addresses.find('c1'), 'task-a');
    assert.equal(addresses.find('c2'), 'task-b');
    assert.equal(addresses.find('c3'), 'task-c');
  } finally { rmSync(directory, { recursive: true }); }
});

test('mentions route to exact named tasks and remove only recipient prefixes', () => {
  const addresses = new Addresses();
  addresses.ensure('task-a'); addresses.ensure('task-b'); addresses.rename('c1', '登录');
  const live = new Set(['task-a', 'task-b']);
  assert.deepEqual(addresses.route(' @登录 继续，完成后联系 @某人', live), { targets: ['task-a'], text: '继续，完成后联系 @某人' });
  assert.deepEqual(addresses.route('@c1 @登录 @C2 分别汇报进度', live), { targets: ['task-a', 'task-b'], text: '分别汇报进度' });
  assert.equal(addresses.route('普通消息 user@example.com', live), null);
});

test('unknown, disconnected or empty mention requests never resolve partly', () => {
  const addresses = new Addresses(); addresses.ensure('task-a'); addresses.ensure('task-b');
  const live = new Set(['task-a']);
  assert.throws(() => addresses.route('@c1 @unknown 继续', live), /找不到/);
  assert.throws(() => addresses.route('@c2 继续', live), /未连接/);
  assert.throws(() => addresses.route('@c1', live), /加上/);
  assert.throws(() => addresses.route('@all 继续', live), /找不到/);
});

test('aliases cannot shadow another task or a present/future canonical address', () => {
  const addresses = new Addresses(); addresses.ensure('task-a'); addresses.ensure('task-b');
  addresses.rename('c1', 'Login');
  assert.equal(addresses.find('LOGIN'), 'task-a');
  assert.throws(() => addresses.rename('c2', 'login'), /另一个/);
  assert.throws(() => addresses.rename('c2', 'c100'), /保留/);
  assert.throws(() => addresses.rename('c2', 'all'), /保留/);
  assert.throws(() => addresses.rename('c2', '含 空格'), /名字须/);
  addresses.rename('c1', '接口');
  assert.equal(addresses.find('Login'), undefined);
  assert.equal(addresses.find('c1'), 'task-a');
});
