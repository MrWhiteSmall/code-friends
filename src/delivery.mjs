async function queuedSubmissionExists(rpc, threadId, submissionId) {
  let cursor;
  do {
    const page = await rpc.call('thread/queue/list', { threadId, limit: 100, ...(cursor ? { cursor } : {}) });
    if (page.data.some(entry => entry.id === submissionId)) return true;
    cursor = page.nextCursor;
  } while (cursor);
  return false;
}

async function consumptionStatus(rpc, threadId, clientId) {
  // Compare the exact client message ID, never the text (which may repeat).
  let cursor;
  for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
    const page = await rpc.call('thread/items/list', {
      threadId, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}),
    });
    if (page.data.some(entry => entry.item.type === 'userMessage' && entry.item.clientId === clientId)) {
      return { status: 'consumed' };
    }
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  // A second client could have removed it instead of consuming it. Do not
  // claim execution or retry: the add operation has already succeeded.
  return { status: 'acceptedUnconfirmed' };
}

export async function deliverInput(rpc, threadId, text, clientId) {
  await rpc.call('thread/resume', { threadId, excludeTurns: true });
  const { queuedSubmission } = await rpc.call('thread/queue/add', {
    threadId, clientUserMessageId: clientId,
    input: [{ type: 'text', text, text_elements: [] }],
  });
  const { thread } = await rpc.call('thread/read', { threadId, includeTurns: false });
  if (!await queuedSubmissionExists(rpc, threadId, queuedSubmission.id)) {
    return consumptionStatus(rpc, threadId, clientId);
  }
  if (thread.status.type !== 'idle') return { status: 'queued' };
  try {
    await rpc.call('thread/queue/start', { threadId, queuedSubmissionId: queuedSubmission.id });
    return { status: 'started' };
  } catch (error) {
    // Checking and starting aren't atomic: the terminal may consume the same
    // submission between them. Handle only this exact submission's error.
    if (error.message !== `queued submission not found: ${queuedSubmission.id}`) throw error;
    if (await queuedSubmissionExists(rpc, threadId, queuedSubmission.id)) throw error;
    return consumptionStatus(rpc, threadId, clientId);
  }
}

export function deliveryDescription(status) {
  return {
    consumed: '已确认 Codex 收到这条消息。',
    started: '消息已发送，已启动下一轮处理。',
    queued: '消息已加入队列，等待任务接收。',
    acceptedUnconfirmed: '消息已提交，但尚未确认执行状态；请用 /view 查看后再决定是否重发。',
  }[status];
}
