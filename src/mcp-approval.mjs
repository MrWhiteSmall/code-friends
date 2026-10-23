// Codex's MCP tool approvals use form elicitations with a privileged marker.
// Generic MCP forms, login flows and user verification need separate handling.
export function mcpToolApproval(request) {
  const p = request.params;
  const schema = p?.requestedSchema;
  if (request.method !== 'mcpServer/elicitation/request' || p?.mode !== 'form'
      || p._meta?.codex_approval_kind !== 'mcp_tool_call'
      || schema?.type !== 'object' || !schema.properties
      || Array.isArray(schema.properties) || typeof schema.properties !== 'object'
      || Object.keys(schema.properties).length
      || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length))) return null;

  const decisions = [{ value: 'accept', text: '允许本次 · Allow' }];
  const persistence = p._meta.persist;
  if (persistence === 'session' || (Array.isArray(persistence) && persistence.includes('session'))) {
    decisions.push({ value: 'session', text: '允许本会话 · Allow for session' });
  }
  decisions.push({ value: 'decline', text: '拒绝' }, { value: 'cancel', text: '取消' });
  const details = [`MCP 服务：${p.serverName}`, p.message];
  if (p._meta.tool_title) details.push(`工具：${p._meta.tool_title}`);
  if (p._meta.tool_params !== undefined) details.push(`调用参数：\n${JSON.stringify(p._meta.tool_params, null, 2)}`);
  if (decisions.some(x => x.value === 'session')) details.push('“允许本会话”记住该工具在此 Codex 会话内的授权。');
  return { details: details.filter(Boolean).join('\n\n'), decisions };
}

export function mcpApprovalResult(request, choice) {
  const approval = mcpToolApproval(request);
  if (!approval || !approval.decisions.some(x => x.value === choice)) {
    throw new Error('此 MCP 请求不支持该授权选项，请使用最新卡片或在电脑上处理。');
  }
  return {
    action: choice === 'session' ? 'accept' : choice,
    content: ['accept', 'session'].includes(choice) ? {} : null,
    _meta: choice === 'session' ? { persist: 'session' }
      : choice === 'cancel' ? { codex_approval_cancellation_reason: 'user' } : null,
  };
}
