import test from 'node:test';
import assert from 'node:assert/strict';
import { authorized, matchingCode, parsePairCommand, PendingRequests, approvalResult } from '../src/core.mjs';
import { Telegram, redact, splitText } from '../src/telegram.mjs';
import { CodexRPC } from '../src/rpc.mjs';

test('only the paired user in the paired private chat is authorized', () => {
  const owner = { chatId: 12, userId: 34 };
  assert.equal(authorized(owner, { id: 12, type: 'private' }, { id: 34 }), true);
  assert.equal(authorized(owner, { id: 12, type: 'group' }, { id: 34 }), false);
  assert.equal(authorized(owner, { id: 12, type: 'private' }, { id: 99 }), false);
  assert.equal(authorized(owner, { id: 99, type: 'private' }, { id: 34 }), false);
  assert.equal(authorized(null, { id: 12, type: 'private' }, { id: 34 }), false);
  assert.equal(matchingCode('abcdef', 'abcdef'), true);
  assert.equal(matchingCode('abcdef', 'abc'), false);
  assert.equal(matchingCode('', ''), false);
});

test('phone pairing accepts surrounding whitespace and bot-qualified commands', () => {
  const code = 'aabbccddeeff001122334455';
  assert.equal(parsePairCommand(`\n/pair ${code}\n`), code);
  assert.equal(parsePairCommand(`/pair@CodexFriendsBot ${code.toUpperCase()}`), code);
  assert.equal(parsePairCommand('/pair …'), undefined);
  assert.equal(parsePairCommand(`/pair ${code} extra`), undefined);
  assert.equal(parsePairCommand(`/other ${code}`), undefined);
});

test('resolved approval buttons expire only for their exact task and request', () => {
  const p = new PendingRequests();
  const a = p.add({ id: 5, params: { threadId: 'task-a' } });
  const b = p.add({ id: 5, params: { threadId: 'task-b' } });
  const c = p.add({ id: '5', params: { threadId: 'task-a' } });
  p.resolved('task-a', 5);
  assert.equal(p.take(a), undefined);
  assert.ok(p.entries.has(b));
  assert.ok(p.entries.has(c));
  assert.ok(p.take(b));
  assert.equal(p.take(b), undefined);
  p.clear();
  assert.equal(p.entries.size, 0);
});

test('approvals cannot grant persistent rules or unsupported decisions', () => {
  const command = { method: 'item/commandExecution/requestApproval', params: { availableDecisions: ['decline'] } };
  assert.throws(() => approvalResult(command, 'accept'));
  assert.throws(() => approvalResult(command, 'acceptForSession'));
  assert.deepEqual(approvalResult(command, 'decline'), { decision: 'decline' });
  const permissions = { method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } };
  assert.deepEqual(approvalResult(permissions, 'accept'), { permissions: { network: { enabled: true } }, scope: 'turn' });
  assert.deepEqual(approvalResult(permissions, 'decline'), { permissions: {}, scope: 'turn' });
  assert.throws(() => approvalResult({ method: 'item/tool/call', params: {} }, 'accept'));
});

test('RPC correlation separates client responses and server requests with the same ID', async () => {
  const rpc = new CodexRPC();
  const output = [];
  rpc.write = x => output.push(x);
  const first = rpc.call('thread/read', { threadId: 'a' });
  const second = rpc.call('thread/read', { threadId: 'b' });
  let request;
  rpc.on('request', x => { request = x; });
  rpc.receive({ id: output[0].id, method: 'item/commandExecution/requestApproval', params: { threadId: 'a' } });
  assert.equal(request.method, 'item/commandExecution/requestApproval');
  rpc.receive({ id: output[1].id, result: { id: 'b' } });
  rpc.receive({ id: output[0].id, result: { id: 'a' } });
  assert.deepEqual(await first, { id: 'a' });
  assert.deepEqual(await second, { id: 'b' });
});

test('Telegram errors and delivered text do not expose the token', async () => {
  const fakeToken = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
  assert.ok(!redact(`https://api.telegram.org/bot${fakeToken}/getMe`, fakeToken).includes(fakeToken));
  assert.ok(!redact(`https://api.telegram.org/bot${fakeToken}/getMe`).includes(fakeToken));
  const api = new Telegram(fakeToken, async () => {
    const error = new Error(`failed: https://api.telegram.org/bot${fakeToken}/getMe`);
    error.cause = { url: fakeToken };
    throw error;
  });
  await assert.rejects(api.call('getMe'), error => !error.message.includes(fakeToken) && !error.cause);
  const bodies = [];
  const sending = new Telegram(fakeToken, async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return { json: async () => ({ ok: true, result: { message_id: bodies.length } }) };
  });
  await sending.send(12, `key=${fakeToken}`);
  assert.ok(!bodies[0].text.includes(fakeToken));
});

test('long Unicode output is split without losing text or exceeding Telegram limits', () => {
  const text = '任务😀'.repeat(4000);
  const chunks = splitText(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(x => x.length <= 3500 && x.isWellFormed()));
});

test('a failed Telegram send does not prevent subsequent messages', async () => {
  let calls = 0;
  const api = new Telegram('local-test', async () => {
    if (++calls === 1) throw new Error('offline');
    return { json: async () => ({ ok: true, result: { message_id: 2 } }) };
  });
  await assert.rejects(api.send(1, 'first'));
  assert.deepEqual(await api.send(1, 'second'), { message_id: 2 });
});
