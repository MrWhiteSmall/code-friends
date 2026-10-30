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
  const subagents = [];
  const missingIds = [];
  for (const id of ids) {
    try {
      const { thread } = await rpc.call('thread/read', { threadId: id, includeTurns: false });
      if (thread.parentThreadId || (typeof thread.source === 'object' && thread.source?.subAgent)) subagents.push(thread);
      else threads.push(thread);
    } catch (error) {
      if (!missingThread(error)) throw error;
      missingIds.push(id);
    }
  }
  return { threads, subagents, missingIds };
}

// Use app-server thread lineage, never an approval's self-reported _meta.
// Independent threads and forks stay separate; orphans/cycles have no owner.
export function threadOwners(threads, subagents) {
  const owners = new Map(threads.map(thread => [thread.id, thread.id]));
  let changed;
  do {
    changed = false;
    for (const thread of subagents) {
      if (owners.has(thread.id)) continue;
      const sourceParent = thread.source?.subAgent?.thread_spawn?.parent_thread_id;
      if (thread.parentThreadId && sourceParent && thread.parentThreadId !== sourceParent) continue;
      const owner = owners.get(thread.parentThreadId || sourceParent);
      if (owner) { owners.set(thread.id, owner); changed = true; }
    }
  } while (changed);
  return owners;
}
