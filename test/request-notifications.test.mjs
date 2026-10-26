import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingRequests } from '../src/core.mjs';
import { RequestNotifications } from '../src/request-notifications.mjs';
import { Telegram } from '../src/telegram.mjs';

const request = { id: 'approval-1', params: { threadId: 'task-a' } };

test('failed notifications retry with backoff; delivered cards and replayed requests are deduplicated', async () => {
  const pending = new PendingRequests();
  const key = pending.add(request);
  let now = 0, attempts = 0, delivered = 0;
  let online = false;
  const notifications = new RequestNotifications(pending, {
    now: () => now,
    render: async () => {
      attempts++;
      if (!online) throw new Error('Bad Gateway');
      return { message_id: 1 };
    },
    delivered: () => delivered++,
  });
  await assert.rejects(notifications.show(key), /Bad Gateway/);
  await notifications.retry();
  assert.equal(attempts, 1);
  now = 2000;
  await notifications.retry();
  assert.equal(attempts, 2);
  online = true;
  now = 5999;
  await notifications.retry();
  assert.equal(attempts, 2);
  now = 6000;
  await Promise.all([notifications.retry(), notifications.show(pending.add(request))]);
  assert.equal(attempts, 3);
  assert.equal(delivered, 1);
  now += 100000;
  await notifications.retry();
  await notifications.show(pending.add(request));
  assert.equal(attempts, 3);
  await notifications.show(key, { force: true }); // Explicit /pending still works.
  assert.equal(attempts, 4);
});

test('queued notifications skip resolved requests, disconnected requests and previous questions', async () => {
  for (const expire of [
    (pending, key) => pending.resolved('task-a', 'approval-1'),
    pending => pending.clear(),
    (pending, key) => pending.entries.get(key).questionIndex++,
  ]) {
    const pending = new PendingRequests();
    const key = pending.add(request);
    const calls = [];
    let release;
    const telegram = new Telegram('local-test', async (url, options) => {
      calls.push(JSON.parse(options.body).text);
      if (calls.length === 1) await new Promise(resolve => { release = resolve; });
      return { json: async () => ({ ok: true, result: { message_id: calls.length } }) };
    });
    const blocker = telegram.send(1, 'earlier message');
    const notifications = new RequestNotifications(pending, {
      render: (key, current) => telegram.send(1, `question ${pending.entries.get(key).questionIndex}`, {}, current),
    });
    const card = notifications.show(key);
    await Promise.resolve(); // Both messages have entered the outgoing queue.
    expire(pending, key);
    release();
    await Promise.all([blocker, card, notifications.retry()]);
    // A changed question is a new notification, delivered below instead.
    assert.deepEqual(calls, pending.entries.size ? ['earlier message', 'question 1'] : ['earlier message']);
  }
});

test('advancing a question while the old send is in flight does not mark the next question delivered', async () => {
  const pending = new PendingRequests();
  const key = pending.add(request);
  const releases = [];
  const notifications = new RequestNotifications(pending, {
    render: () => new Promise(resolve => releases.push(resolve)),
  });
  const first = notifications.show(key);
  await Promise.resolve();
  pending.entries.get(key).questionIndex++;
  const second = notifications.show(key);
  await Promise.resolve();
  releases[0]({ message_id: 1 });
  await first;
  assert.equal(pending.entries.get(key).notification.delivered, false);
  assert.equal(notifications.show(key), second);
  releases[1]({ message_id: 2 });
  await second;
  assert.equal(pending.entries.get(key).notification.delivered, true);
});

test('a resolved card stops before a rate-limit retry or the next text chunk', async () => {
  for (const rateLimit of [false, true]) {
    let current = true;
    let calls = 0;
    const telegram = new Telegram('local-test', async () => {
      calls++;
      current = false;
      return { json: async () => rateLimit
        ? { ok: false, error_code: 429, parameters: { retry_after: 0.001 } }
        : { ok: true, result: { message_id: 1 } } };
    });
    assert.equal(await telegram.send(1, 'x'.repeat(4000), {}, () => current), undefined);
    assert.equal(calls, 1);
  }
});
