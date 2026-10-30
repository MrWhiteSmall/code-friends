import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutoAllow, automaticApproval } from '../src/auto-allow.mjs';
import { PendingRequests } from '../src/core.mjs';
import { State } from '../src/state.mjs';

const command = (id = 'r1', threadId = 'task-a') => ({ id, method: 'item/commandExecution/requestApproval',
  params: { threadId, command: 'pwd', availableDecisions: ['accept', 'acceptForSession', 'decline'] } });
const mcp = () => ({ id: 'mcp1', method: 'mcpServer/elicitation/request', params: {
  threadId: 'task-a', mode: 'form', requestedSchema: { type: 'object', properties: {} },
  _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
} });

test('auto allow uses individual approval responses and only the requested permissions', () => {
  assert.deepEqual(automaticApproval(command()), { decision: 'accept' });
  assert.deepEqual(automaticApproval({ ...command(), method: 'item/fileChange/requestApproval' }), { decision: 'accept' });
  assert.deepEqual(automaticApproval({ method: 'item/permissions/requestApproval', params: {
    permissions: { network: { enabled: true }, fileSystem: { write: ['/tmp/example'] } },
  } }), { permissions: { network: { enabled: true }, fileSystem: { write: ['/tmp/example'] } }, scope: 'turn' });
  assert.deepEqual(automaticApproval(mcp()), { action: 'accept', content: {}, _meta: null });
});

test('forms, login, questions, unoffered decisions and unknown protocols remain manual', () => {
  const form = mcp();
  form.params.requestedSchema.properties = { password: { type: 'string' } };
  const login = mcp(); login.params.mode = 'url';
  const generic = mcp(); delete generic.params._meta;
  const declineOnly = command(); declineOnly.params.availableDecisions = ['decline'];
  for (const request of [form, login, generic, declineOnly,
    { method: 'item/tool/requestUserInput', params: { questions: [] } },
    { method: 'futureApproval', params: {} },
    { method: 'item/permissions/requestApproval', params: {} }]) {
    assert.equal(automaticApproval(request), null);
  }
});

test('switches default off, persist by exact thread and never propagate to another session', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-auto-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const pending = new PendingRequests();
  const responses = [];
  const options = { respond: (id, result) => responses.push({ id, result }) };
  const original = new AutoAllow(new State(dir), pending, options);
  const key = pending.add(command());
  assert.equal(original.apply(key), false);
  original.set('task-a', true);
  const restarted = new AutoAllow(new State(dir), pending, options);
  assert.deepEqual(restarted.enabledIds(), ['task-a']);
  assert.equal(restarted.apply(key), true);
  assert.equal(restarted.apply(pending.add(command('r2', 'task-b'))), false);
  restarted.set('task-a', false);
  assert.equal(restarted.apply(pending.add(command('r3'))), false);
  assert.deepEqual(new AutoAllow(new State(dir), pending, options).enabledIds(), []);
  assert.deepEqual(responses, [{ id: 'r1', result: { decision: 'accept' } }]);
});

test('resolved requests and duplicate replays do not submit twice; connection resets deduplication', () => {
  const pending = new PendingRequests();
  const responses = [];
  const auto = new AutoAllow({ data: {}, save() {} }, pending, { respond: id => responses.push(id) });
  auto.set('task-a', true);
  const resolved = pending.add(command('resolved'));
  pending.resolved('task-a', 'resolved');
  assert.equal(auto.apply(resolved), false);
  assert.equal(auto.apply(pending.add(command())), true);
  auto.set('task-a', false);
  assert.equal(auto.apply(pending.add(command())), true);
  assert.equal(pending.entries.size, 0);
  assert.deepEqual(responses, ['r1']);
  auto.disconnected();
  assert.equal(auto.apply(pending.add(command())), false);
});

test('failed persistence cannot enable automation and failed submission leaves a manual request', () => {
  const pending = new PendingRequests();
  const state = { data: {}, save() { throw new Error('disk full'); } };
  const auto = new AutoAllow(state, pending, { respond() { throw new Error('socket closed'); } });
  assert.throws(() => auto.set('task-a', true), /disk full/);
  assert.equal(auto.enabled('task-a'), false);
  state.save = () => {};
  auto.set('task-a', true);
  const key = pending.add(command());
  assert.throws(() => auto.apply(key), /socket closed/);
  assert.ok(pending.entries.has(key));
  assert.equal(auto.responded.size, 0);
});

test('child app approvals follow the verified root switch, including after restart and disabling', () => {
  const owners = new Map([['child-a', 'task-a'], ['grandchild-a', 'task-a'], ['child-b', 'task-b']]);
  const state = { data: { autoAllowThreads: { 'task-a': true } }, save() {} };
  const pending = new PendingRequests();
  const responses = [];
  const auto = new AutoAllow(state, pending, { owner: id => owners.get(id) || id,
    respond: (id, result) => responses.push({ id, result }) });
  const edge = mcp();
  edge.params.threadId = 'child-a';
  edge.params.message = 'Allow Computer Use to use "Microsoft Edge"?';
  edge.params._meta.tool_name = 'get_app_state';
  assert.equal(auto.apply(pending.add(edge)), true);
  assert.deepEqual(responses[0].result, { action: 'accept', content: {}, _meta: null });
  assert.equal(auto.apply(pending.add(command('grandchild', 'grandchild-a'))), true);
  // A forged parent in request metadata cannot change the lineage.
  const other = command('other', 'child-b');
  other.params._meta = { parent_thread_id: 'task-a' };
  assert.equal(auto.apply(pending.add(other)), false);
  auto.set('task-a', false);
  assert.equal(auto.enabled('child-a'), false);
  assert.equal(auto.apply(pending.add(command('after-off', 'child-a'))), false);
  auto.set('task-a', true);
  owners.clear();
  assert.equal(auto.apply(pending.add(command('unconfirmed-child', 'child-a'))), false);
});
