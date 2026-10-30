import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { CodexRPC } from '../src/rpc.mjs';
import { Telegram } from '../src/telegram.mjs';
import { loadThreadSnapshot, threadOwners } from '../src/threads.mjs';

test('read-only timeout errors are redacted without overwriting their message', async () => {
  const token = 'fake-private-token';
  const original = Object.freeze(new DOMException(`timeout at ${token}`, 'TimeoutError'));
  const telegram = new Telegram(token, async () => { throw original; });
  await assert.rejects(telegram.call('getUpdates'), error => {
    assert.equal(error.message, 'timeout at [TOKEN]');
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(original.message, `timeout at ${token}`);
});

test('Telegram API errors preserve fatal codes and rate-limit delays', async () => {
  for (const code of [401, 409, 429]) {
    const telegram = new Telegram('test', async () => ({
      json: async () => ({ ok: false, error_code: code, description: 'failure', parameters: { retry_after: 3 } }),
    }));
    await assert.rejects(telegram.call('getMe'), error => error.code === code && error.retryAfter === 3);
  }
});

test('snapshot separates roots and subagents and skips stale sessions across pages', async () => {
  const reads = [];
  const rpc = { async call(method, params) {
    if (method === 'thread/loaded/list') return params.cursor
      ? { data: ['child', 'last'] } : { data: ['stale', 'first'], nextCursor: 'page2' };
    reads.push(params.threadId);
    if (params.threadId === 'stale') throw new Error('no rollout found for thread id stale');
    return { thread: { id: params.threadId, ...(params.threadId === 'child' ? { parentThreadId: 'first' } : {}) } };
  } };
  const snapshot = await loadThreadSnapshot(rpc);
  assert.deepEqual(snapshot.threads.map(x => x.id), ['first', 'last']);
  assert.deepEqual(snapshot.subagents.map(x => x.id), ['child']);
  assert.deepEqual(snapshot.missingIds, ['stale']);
  assert.deepEqual(reads, ['stale', 'first', 'child', 'last']);
});

test('lineage assigns descendants to the correct root without inheriting across forks, orphans or cycles', () => {
  const roots = [{ id: 'root-a' }, { id: 'root-b', forkedFromId: 'root-a' }];
  const children = [
    { id: 'grandchild', parentThreadId: 'child-a' },
    { id: 'child-b', parentThreadId: 'root-b' },
    { id: 'child-a', parentThreadId: 'root-a' },
    { id: 'legacy-child', source: { subAgent: { thread_spawn: { parent_thread_id: 'root-a' } } } },
    { id: 'orphan', parentThreadId: 'missing' },
    { id: 'loop-a', parentThreadId: 'loop-b' }, { id: 'loop-b', parentThreadId: 'loop-a' },
    { id: 'conflicting', parentThreadId: 'root-b', source: { subAgent: { thread_spawn: { parent_thread_id: 'root-a' } } } },
  ];
  const owners = threadOwners(roots, children);
  assert.equal(owners.get('root-b'), 'root-b');
  assert.equal(owners.get('child-a'), 'root-a');
  assert.equal(owners.get('grandchild'), 'root-a');
  assert.equal(owners.get('legacy-child'), 'root-a');
  assert.equal(owners.get('child-b'), 'root-b');
  for (const id of ['orphan', 'loop-a', 'loop-b', 'conflicting']) assert.equal(owners.has(id), false);
});

test('snapshot propagates transport failure instead of claiming a healthy empty list', async () => {
  const rpc = { async call(method) {
    if (method === 'thread/loaded/list') return { data: ['task'] };
    throw new Error('socket disconnected');
  } };
  await assert.rejects(loadThreadSnapshot(rpc), /socket disconnected/);
});

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cf-rpc-'));
  const path = join(directory, 'test.sock');
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  let connections = 0;
  const received = [];
  sockets.on('connection', socket => {
    connections++;
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      received.push(message);
      if (message.method === 'initialize' || message.method === 'read') {
        socket.send(JSON.stringify({ id: message.id, result: { ok: true } }));
      }
    });
  });
  const rpc = new CodexRPC({ resolveSocketPath: async () => path, ...options });
  t.after(async () => {
    rpc.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(path);
  await once(server, 'listening');
  return { rpc, sockets, received, connections: () => connections };
}

test('RPC reconnects after socket loss, rejects pending calls and joins only once', async t => {
  const { rpc, sockets, connections, received } = await fixture(t);
  await Promise.all([rpc.connect(), rpc.connect()]);
  assert.equal(connections(), 1);
  const lost = once(rpc, 'disconnect');
  const old = rpc.socket;
  const pending = assert.rejects(rpc.call('mutation'), /连接已断开/);
  for (const socket of sockets.clients) socket.terminate();
  await lost;
  await pending;
  assert.equal(rpc.connected, false);
  assert.equal(rpc.calls.size, 0);
  await Promise.all([rpc.connect(), rpc.connect()]);
  assert.equal(connections(), 2);
  assert.equal(rpc.connected, true);
  old.emit('close'); // A late event on the old socket must not kill the new one.
  assert.equal(rpc.connected, true);
  assert.deepEqual(await rpc.call('read'), { ok: true });
  assert.ok(received.filter(x => x.method === 'mutation').length <= 1);
  let disconnected = false;
  rpc.on('disconnect', () => { disconnected = true; });
  rpc.close();
  assert.equal(disconnected, false);
  await assert.rejects(rpc.connect(), /已关闭/);
});

test('RPC timeout drops the hung connection and never resends a mutation on recovery', async t => {
  const { rpc, received, connections } = await fixture(t, { requestTimeoutMs: 150 });
  await rpc.connect();
  const lost = once(rpc, 'disconnect');
  await assert.rejects(rpc.call('mutation'), /请求超时.*不自动重发/);
  await lost;
  assert.equal(rpc.connected, false);
  await rpc.connect();
  await rpc.call('read');
  assert.equal(connections(), 2);
  assert.equal(received.filter(x => x.method === 'mutation').length, 1);
});

test('RPC can retry when the daemon was unavailable during discovery', async t => {
  const { rpc } = await fixture(t);
  const resolve = rpc.resolveSocketPath;
  rpc.resolveSocketPath = async () => { throw new Error('daemon offline'); };
  await assert.rejects(rpc.connect(), /daemon offline/);
  rpc.resolveSocketPath = resolve;
  await rpc.connect();
  assert.equal(rpc.connected, true);
});
