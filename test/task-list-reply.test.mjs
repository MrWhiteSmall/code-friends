import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskListReply } from '../src/task-list-reply.mjs';

test('failed lists survive restart and render current sessions on recovery', async () => {
  let saved;
  const state = { data: {}, save() { saved = structuredClone(this.data); } };
  let sessions = ['open-a'];
  const rendered = [];
  const first = new TaskListReply(state, { render: async () => {
    rendered.push([...sessions]);
    throw new Error('Telegram timeout');
  } });
  await assert.rejects(first.request(), /Telegram timeout/);
  assert.equal(saved.tasksReplyPending, true);
  sessions = ['open-b'];
  const restartedState = { data: saved, save() {} };
  const restarted = new TaskListReply(restartedState, { render: async () => {
    rendered.push([...sessions]);
    return { message_id: 42 };
  } });
  await restarted.retry();
  await restarted.retry();
  assert.deepEqual(rendered, [['open-a'], ['open-b']]);
  assert.equal(restartedState.data.tasksReplyPending, false);
});

test('repeated commands and recovery checks share one delivery; failures back off', async () => {
  let now = 0, attempts = 0, resolve;
  const state = { data: {}, save() {} };
  const reply = new TaskListReply(state, { now: () => now, render: () => {
    attempts++;
    if (attempts === 1) throw new Error('offline');
    return new Promise(done => { resolve = done; });
  } });
  await assert.rejects(reply.request(), /offline/);
  now = 1999;
  await reply.retry();
  assert.equal(attempts, 1);
  now = 2000;
  const sending = reply.retry();
  assert.equal(reply.request(), sending);
  assert.equal(reply.retry(), sending);
  await Promise.resolve();
  assert.equal(attempts, 2);
  resolve({ message_id: 43 });
  await sending;
  assert.equal(state.data.tasksReplyPending, false);
  await reply.retry();
  assert.equal(attempts, 2);
});
