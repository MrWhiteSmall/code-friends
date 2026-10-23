import { readFileSync } from 'node:fs';
import { CodexRPC } from '../src/rpc.mjs';
import { loadThreadSnapshot } from '../src/threads.mjs';
import { Telegram, redact } from '../src/telegram.mjs';
import { Addresses } from '../src/addresses.mjs';

const state = JSON.parse(readFileSync(new URL('../.local/state.json', import.meta.url), 'utf8'));
const rpc = new CodexRPC();
const requests = new Map();
const addresses = new Addresses(state.addresses);
const label = id => addresses.display(id) || id;
rpc.on('disconnect', () => {});
rpc.on('request', request => {
  requests.set(`${request.params?.threadId}:${request.id}`, {
    task: label(request.params?.threadId), method: request.method,
  });
});
rpc.on('notification', ({ method, params }) => {
  if (method === 'serverRequest/resolved') requests.delete(`${params.threadId}:${params.requestId}`);
});
try {
  await rpc.connect();
  const snapshot = await loadThreadSnapshot(rpc);
  const statuses = [];
  for (const thread of snapshot.threads) {
    statuses.push({ task: label(thread.id), status: thread.status });
    try { await rpc.call('thread/resume', { threadId: thread.id, excludeTurns: true }); }
    catch (error) { console.log(JSON.stringify({ task: label(thread.id), error: redact(error.message) })); }
  }
  // Allow already-waiting server requests to replay; never respond to them.
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log(JSON.stringify({ codex: { tasks: statuses, pending: [...requests.values()], skipped: snapshot.missingIds.length } }));
} catch (error) { console.log(JSON.stringify({ codexError: redact(error.message) })); }
finally { rpc.close(); }
if (process.env.TELEGRAM_TOKEN) {
  const api = new Telegram(process.env.TELEGRAM_TOKEN);
  try {
    const bot = await api.call('getMe');
    console.log(JSON.stringify({ telegram: { connected: true, bot: bot.username } }));
  } catch (error) { console.log(JSON.stringify({ telegram: { connected: false, error: error.message } })); }
}
