import { randomBytes, timingSafeEqual } from 'node:crypto';

export function authorized(owner, chat, user) {
  return Boolean(owner && chat?.type === 'private' && chat.id === owner.chatId && user?.id === owner.userId);
}

export function matchingCode(expected, supplied) {
  const a = Buffer.from(expected || '');
  const b = Buffer.from(supplied || '');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function parsePairCommand(text) {
  return String(text || '').trim().match(/^\/pair(?:@\w+)?\s+([a-fA-F0-9]{24})\s*$/)?.[1]?.toLowerCase();
}

export function statusText(status) {
  const flags = status?.activeFlags || [];
  if (flags.includes('waitingOnApproval')) return '⏳ 等待批准';
  if (flags.includes('waitingOnUserInput')) return '💬 等待回答';
  return { active: '🟢 执行中', idle: '⚪ 等待新指令', systemError: '🔴 出错', notLoaded: '⚫ 未连接' }[status?.type] || '状态未知';
}

export function title(thread) { return (thread.name || thread.preview || thread.id).replace(/\s+/g, ' ').slice(0, 60); }

// Callback identifiers are random, scoped to this process/connection, and single-use.
export class PendingRequests {
  constructor() { this.entries = new Map(); }
  add(request) {
    for (const [key, entry] of this.entries) {
      if (entry.request.id === request.id && entry.request.params.threadId === request.params.threadId) return key;
    }
    const key = randomBytes(8).toString('hex');
    this.entries.set(key, { request, answers: {}, questionIndex: 0 });
    return key;
  }
  resolved(threadId, requestId) {
    for (const [key, entry] of this.entries) {
      if (entry.request.params.threadId === threadId && entry.request.id === requestId) this.entries.delete(key);
    }
  }
  removeThread(threadId) {
    for (const [key, entry] of this.entries) {
      if (entry.request.params.threadId === threadId) this.entries.delete(key);
    }
  }
  take(key) { const entry = this.entries.get(key); this.entries.delete(key); return entry; }
  clear() { this.entries.clear(); }
}

export function approvalResult(request, choice) {
  if (!['accept', 'decline', 'cancel'].includes(choice)) throw new Error('无效的审批选项。');
  const method = request.method;
  if (method === 'item/permissions/requestApproval') {
    return { permissions: choice === 'accept' ? request.params.permissions : {}, scope: 'turn' };
  }
  if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
    throw new Error('此请求不能通过审批按钮回答。');
  }
  const allowed = request.params.availableDecisions;
  if (allowed && !allowed.includes(choice)) throw new Error('Codex 没有提供这个审批选项。');
  return { decision: choice };
}
