import { CodexRPC } from '../src/rpc.mjs';
const rpc = new CodexRPC();
rpc.on('disconnect', () => {});
const requests = [];
rpc.on('request', request => { requests.push(request.method); });
try {
  await rpc.connect();
  const page = await rpc.call('thread/loaded/list', { limit: 100 });
  const totals = { rootTasks: 0, historyReadable: 0, subscribed: 0, replayedRequests: [] };
  for (const id of page.data) {
    const { thread } = await rpc.call('thread/read', { threadId: id, includeTurns: false });
    if (thread.parentThreadId) continue;
    totals.rootTasks++;
    await rpc.call('thread/turns/list', { threadId: id, limit: 1, itemsView: 'full', sortDirection: 'desc' });
    totals.historyReadable++;
    if (process.argv.includes('--subscribe')) {
      // Join the existing executor with no policy/config overrides. Never answer requests.
      await rpc.call('thread/resume', { threadId: id, excludeTurns: true });
      totals.subscribed++;
    }
  }
  totals.replayedRequests = requests;
  console.log(JSON.stringify(totals));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { rpc.close(); }
