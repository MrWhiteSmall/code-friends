import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverInput } from '../src/delivery.mjs';

function scenario({ status = 'idle', queues = [[{ id: 'submission-1' }]], startError, history = [] } = {}) {
  const calls = [];
  let queueReads = 0;
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'thread/resume') return {};
      if (method === 'thread/queue/add') return { queuedSubmission: { id: 'submission-1' } };
      if (method === 'thread/read') return { thread: { status: { type: status } } };
      if (method === 'thread/queue/list') return { data: queues[Math.min(queueReads++, queues.length - 1)] };
      if (method === 'thread/queue/start') { if (startError) throw startError; return {}; }
      if (method === 'thread/items/list') return { data: history };
      throw new Error(`Unexpected method ${method}`);
    },
  };
}
const delivered = [{ item: { type: 'userMessage', clientId: 'telegram-message-1' } }];

test('a terminal that consumes and finishes before the status read does not get a second start', async () => {
  const rpc = scenario({ status: 'idle', queues: [[]], history: delivered });
  assert.deepEqual(await deliverInput(rpc, 'task-a', '进度如何', 'telegram-message-1'), { status: 'consumed' });
  assert.equal(rpc.calls.filter(x => x.method === 'thread/queue/start').length, 0);
  assert.equal(rpc.calls.filter(x => x.method === 'thread/queue/add').length, 1);
});

test('consumption between checking the queue and starting it is verified without resend', async () => {
  const rpc = scenario({ queues: [[{ id: 'submission-1' }], []], startError: new Error('queued submission not found: submission-1'), history: delivered });
  assert.deepEqual(await deliverInput(rpc, 'task-a', '进度如何', 'telegram-message-1'), { status: 'consumed' });
  assert.equal(rpc.calls.filter(x => x.method === 'thread/queue/add').length, 1);
  assert.equal(rpc.calls.filter(x => x.method === 'thread/queue/start').length, 1);
});

test('an idle task with a pending submission starts that exact submission', async () => {
  const rpc = scenario();
  assert.deepEqual(await deliverInput(rpc, 'task-a', '继续', 'telegram-message-1'), { status: 'started' });
  assert.deepEqual(rpc.calls.find(x => x.method === 'thread/queue/start').params, { threadId: 'task-a', queuedSubmissionId: 'submission-1' });
});

test('an active task keeps its submission queued', async () => {
  const rpc = scenario({ status: 'active' });
  assert.deepEqual(await deliverInput(rpc, 'task-a', '继续', 'telegram-message-1'), { status: 'queued' });
  assert.equal(rpc.calls.filter(x => x.method === 'thread/queue/start').length, 0);
});

test('a disappearance with no matching client ID is not falsely reported as execution', async () => {
  const rpc = scenario({ queues: [[]], history: [{ item: { type: 'userMessage', clientId: 'some-other-message', content: [{ text: '继续' }] } }] });
  assert.deepEqual(await deliverInput(rpc, 'task-a', '继续', 'telegram-message-1'), { status: 'acceptedUnconfirmed' });
  assert.equal(rpc.calls.filter(x => x.method === 'thread/queue/add').length, 1);
});

test('unrelated errors and a still-present submission are not swallowed', async () => {
  for (const error of [new Error('permission denied'), new Error('queued submission not found: another-submission')]) {
    const rpc = scenario({ startError: error });
    await assert.rejects(deliverInput(rpc, 'task-a', '继续', 'telegram-message-1'), error);
  }
  const error = new Error('queued submission not found: submission-1');
  await assert.rejects(deliverInput(scenario({ startError: error }), 'task-a', '继续', 'telegram-message-1'), error);
});

test('queue and message verification follow pagination', async () => {
  const rpc = scenario();
  const originalCall = rpc.call.bind(rpc);
  rpc.call = async (method, params) => {
    if (method === 'thread/queue/list') return params.cursor
      ? { data: [{ id: 'submission-1' }] } : { data: [], nextCursor: 'next-queue' };
    return originalCall(method, params);
  };
  assert.deepEqual(await deliverInput(rpc, 'task-a', '继续', 'telegram-message-1'), { status: 'started' });
  rpc.call = async (method, params) => {
    if (method === 'thread/queue/list') return { data: [] };
    if (method === 'thread/items/list') return params.cursor
      ? { data: delivered } : { data: [], nextCursor: 'next-items' };
    return originalCall(method, params);
  };
  assert.deepEqual(await deliverInput(rpc, 'task-a', '继续', 'telegram-message-1'), { status: 'consumed' });
});
