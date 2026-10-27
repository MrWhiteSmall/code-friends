import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalPids, listenerPorts, terminalListeners, terminalThreads } from '../src/terminal-sessions.mjs';

test('only Codex with a controlling terminal counts, never daemon or similarly named helpers', () => {
  assert.deepEqual(terminalPids(`
  11 ttys001 codex
  12 ?? /bin/codex
  13 ttys002 /opt/codex
  14 ttys003 node
  15 ttys004 /opt/codex-code-mode-host
  16 ? codex
`), [11, 13]);
  assert.deepEqual([...listenerPorts('p11\nf35\nn127.0.0.1:5555\np12\nn127.0.0.1:6666\np13\nn[::1]:7777\nn*:8888', [11, 13])], [5555, 7777]);
});

test('partial lsof exit 1 preserves listeners but exited terminal PIDs disappear', async () => {
  let reads = 0;
  const result = await terminalListeners(async (program, args) => {
    if (program === '/bin/ps') return { stdout: ++reads === 1 ? '11 ttys001 codex\n13 ttys002 codex' : '13 ttys002 codex' };
    assert.ok(args.includes('11,13'));
    throw Object.assign(new Error('partial'), { code: 1, stdout: 'p11\nn127.0.0.1:5555\np13\nn127.0.0.1:7777' });
  });
  assert.equal(result.processes, 1);
  assert.deepEqual([...result.ports], [7777]);
  await assert.rejects(terminalListeners(async () => { throw new Error('permission denied'); }), /permission/);
});

test('idle open sessions remain visible while active closed sessions and stale TUI ports are hidden', async () => {
  const threads = [
    { id: 'open-idle', status: { type: 'idle' } },
    { id: 'closed-active', status: { type: 'active' } },
    { id: 'stale-port' }, { id: 'unknown' }, { id: 'other-server' },
  ];
  const calls = [];
  const rpc = { connected: true, async call(method, params) {
    calls.push([method, params]);
    assert.equal(method, 'mcpServerStatus/list');
    assert.equal(params.serverName, 'codex_tui');
    if (params.threadId === 'unknown') throw new Error('unsupported');
    if (params.threadId === 'closed-active') return { data: [] };
    if (params.threadId === 'other-server') return { data: [{ name: 'other', httpOrigin: 'http://127.0.0.1:5555' }] };
    if (params.threadId === 'stale-port') return { data: [{ name: 'codex_tui', httpOrigin: 'http://127.0.0.1:9999' }] };
    return params.cursor ? { data: [{ name: 'codex_tui', httpOrigin: 'http://127.0.0.1:5555' }] } : { data: [], nextCursor: 'page2' };
  } };
  const result = await terminalThreads(rpc, threads, async () => ({ ports: new Set([5555]), processes: 1 }));
  assert.deepEqual(result.threads.map(x => x.id), ['open-idle']);
  assert.equal(result.unconfirmed, 1);
  assert.equal(calls.length, 6);
  const empty = await terminalThreads(rpc, threads, async () => ({ ports: new Set(), processes: 0 }));
  assert.deepEqual(empty.threads, []);
  assert.equal(calls.length, 6);
});

test('transport failure is reported rather than pretending there are no open sessions', async () => {
  const rpc = { connected: false, call: async () => { throw new Error('disconnected'); } };
  await assert.rejects(terminalThreads(rpc, [{ id: 'open' }], async () => ({ ports: new Set([5555]), processes: 1 })), /disconnected/);
});
