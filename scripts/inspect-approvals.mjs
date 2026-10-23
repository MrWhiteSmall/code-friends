import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { CodexRPC } from '../src/rpc.mjs';
import { loadThreadSnapshot, missingThread } from '../src/threads.mjs';
import { Addresses } from '../src/addresses.mjs';
import { redact } from '../src/telegram.mjs';

// Read/rejoin existing sessions only. Never answer, approve, or submit a turn.
const state = JSON.parse(readFileSync(new URL('../.local/state.json', import.meta.url), 'utf8'));
const addresses = new Addresses(state.addresses);
const rpc = new CodexRPC();
const requests = new Map();
const errors = [];
rpc.on('disconnect', error => errors.push(redact(error.message)));
rpc.on('request', request => {
  const p = request.params || {};
  requests.set(`${p.threadId}:${request.id}`, {
    task: addresses.display(p.threadId), threadId: p.threadId, method: request.method,
    parameterNames: Object.keys(p), availableDecisions: p.availableDecisions,
    permissionKeys: p.permissions ? Object.keys(p.permissions) : undefined,
    serverName: p.serverName, mode: p.mode,
    questions: p.questions?.map(q => ({ id: q.id, isSecret: q.isSecret,
      options: q.options?.map(o => o.label) })),
  });
});
rpc.on('notification', ({ method, params: p }) => {
  if (method === 'serverRequest/resolved') requests.delete(`${p.threadId}:${p.requestId}`);
});
const report = { capturedAt: new Date().toISOString(), tasks: [], pending: [], errors };
try {
  await rpc.connect();
  const snapshot = await loadThreadSnapshot(rpc);
  for (const thread of snapshot.threads) {
    report.tasks.push({ task: addresses.display(thread.id), id: thread.id, name: thread.name,
      cwd: thread.cwd, path: thread.path, source: thread.source, status: thread.status,
      fields: Object.keys(thread) });
    try { await rpc.call('thread/resume', { threadId: thread.id, excludeTurns: true }); }
    catch (error) { if (!missingThread(error)) errors.push(redact(error.message)); }
  }
  await new Promise(resolve => setTimeout(resolve, 500));
  report.pending = [...requests.values()];
} catch (error) { errors.push(redact(error.message)); process.exitCode = 1; }
finally { rpc.close(); }
const output = new URL('../.local/approval-investigation/', import.meta.url);
mkdirSync(output, { recursive: true, mode: 0o700 });
writeFileSync(new URL('live.json', output), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
