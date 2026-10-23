export function missingThread(error) {
  return /^no rollout found for thread id /.test(error?.message || '');
}

// A stale loaded ID must not prevent later, healthy sessions from refreshing.
export async function loadThreadSnapshot(rpc) {
  const ids = [];
  let cursor;
  do {
    const page = await rpc.call('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
    ids.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  const threads = [];
  const missingIds = [];
  for (const id of ids) {
    try {
      const { thread } = await rpc.call('thread/read', { threadId: id, includeTurns: false });
      if (thread.parentThreadId || (typeof thread.source === 'object' && thread.source?.subAgent)) continue;
      threads.push(thread);
    } catch (error) {
      if (!missingThread(error)) throw error;
      missingIds.push(id);
    }
  }
  return { threads, missingIds };
}
