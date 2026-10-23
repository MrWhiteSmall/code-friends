import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpToolApproval, mcpApprovalResult } from '../src/mcp-approval.mjs';

function request(overrides = {}) {
  return { method: 'mcpServer/elicitation/request', params: {
    threadId: 'task-a', serverName: 'cua_repl', mode: 'form',
    message: 'Allow the cua_repl MCP server to run tool "js"?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'],
      tool_title: 'Computer control', tool_params: { code: 'read current state' } },
    ...overrides,
  } };
}

test('MCP tool approval exposes the operation and session choice without permanent authorization', () => {
  const card = mcpToolApproval(request());
  assert.match(card.details, /cua_repl/);
  assert.match(card.details, /Computer control/);
  assert.match(card.details, /read current state/);
  assert.deepEqual(card.decisions.map(x => x.value), ['accept', 'session', 'decline', 'cancel']);
});

test('MCP decisions use elicitation responses and never echo offered persistence metadata', () => {
  const r = request();
  assert.deepEqual(mcpApprovalResult(r, 'accept'), { action: 'accept', content: {}, _meta: null });
  assert.deepEqual(mcpApprovalResult(r, 'session'), { action: 'accept', content: {}, _meta: { persist: 'session' } });
  assert.deepEqual(mcpApprovalResult(r, 'decline'), { action: 'decline', content: null, _meta: null });
  assert.deepEqual(mcpApprovalResult(r, 'cancel'), { action: 'cancel', content: null,
    _meta: { codex_approval_cancellation_reason: 'user' } });
  for (const choice of ['always', 'acceptForSession', 'Allow', 'anything']) {
    assert.throws(() => mcpApprovalResult(r, choice));
  }
});

test('session grants are possible only when explicitly offered by this request', () => {
  for (const persist of [undefined, null, 'always', ['always'], [], true]) {
    const r = request({ _meta: { codex_approval_kind: 'mcp_tool_call', persist } });
    assert.deepEqual(mcpToolApproval(r).decisions.map(x => x.value), ['accept', 'decline', 'cancel']);
    assert.throws(() => mcpApprovalResult(r, 'session'));
  }
  const r = request({ _meta: { codex_approval_kind: 'mcp_tool_call', persist: 'session' } });
  assert.equal(mcpApprovalResult(r, 'session')._meta.persist, 'session');
});

test('generic forms, browser authorization and verification cannot be approved through tool buttons', () => {
  const cases = [
    request({ _meta: null }),
    request({ _meta: { codex_approval_kind: 'browser_auth' } }),
    request({ _meta: { codex_approval_kind: 'tool_suggestion' } }),
    request({ mode: 'url' }), request({ mode: 'openai/userVerification' }),
    request({ mode: 'openai/form' }),
    request({ requestedSchema: { type: 'object', properties: { password: { type: 'string' } } } }),
    request({ requestedSchema: { type: 'object', properties: {}, required: ['password'] } }),
    request({ requestedSchema: { type: 'object', properties: {}, required: 'password' } }),
    request({ requestedSchema: { type: 'object', properties: [] } }),
    request({ requestedSchema: null }),
    { method: 'item/tool/call', params: request().params },
    {},
  ];
  for (const r of cases) {
    assert.equal(mcpToolApproval(r), null);
    assert.throws(() => mcpApprovalResult(r, 'accept'));
  }
});
