import { readFileSync } from 'node:fs';
import { CodexRPC } from '../src/rpc.mjs';
const rpc = new CodexRPC();
rpc.on('disconnect', () => {});
try {
  const state = JSON.parse(readFileSync(new URL('../.local/state.json', import.meta.url), 'utf8'));
  const id = Object.entries(state.addresses).find(([, value]) => value.code === 'c2')?.[0];
  if (!id) throw new Error('没有 c2 会话。');
  await rpc.connect();
  const { thread } = await rpc.call('thread/read', { threadId: id, includeTurns: false });
  const queued = await rpc.call('thread/queue/list', { threadId: id, limit: 100 });
  const items = await rpc.call('thread/items/list', { threadId: id, limit: 200, sortDirection: 'desc' });
  const delivered = items.data.filter(entry => entry.item.type === 'userMessage' && entry.item.clientId?.startsWith('telegram-'));
  console.log(JSON.stringify({ status: thread.status, queueCount: queued.data.length,
    progressQuestionDelivered: delivered.some(entry => (entry.item.content || []).some(x => x.text?.includes('现在进度如何'))),
    telegramMessagesInHistory: delivered.length,
    latestClientIdPresent: Boolean(delivered[0]?.item.clientId) }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { rpc.close(); }
