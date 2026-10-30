import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, cp, symlink, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

for (const outage of [false, true, 'fallback', 'restored']) test(`real bridge ${outage === 'restored' ? 'restores per-session auto allow on startup' : outage === 'fallback' ? 'switches to an independent transport after repeated polling failures' : outage ? 'recovers a failed approval notification after a Telegram outage' : 'forwards an MCP card'} and submits each decision only once`, { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cf-flow-'));
  const socketPath = join(root, 'rpc.sock');
  const server = createServer();
  const websocket = new WebSocketServer({ server });
  const activity = new EventEmitter();
  const calls = [];
  const polls = [];
  const responses = [];
  let codexSocket;
  let child;
  let exited = false;
  let stderr = '';
  let stdout = '';
  let failedCard = false;
  let failedList = false;
  let childWaiting = false;
  let pollCount = 0;
  t.after(async () => {
    if (t.signal.aborted) t.diagnostic(JSON.stringify({ calls: calls.map(x => [x.method, x.transport]), stdout, stderr }));
    if (child && !exited) {
      const stopped = once(child, 'exit');
      child.kill('SIGTERM');
      await stopped;
    }
    for (const socket of websocket.clients) socket.terminate();
    await new Promise(resolve => websocket.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  async function until(predicate) {
    while (!predicate()) {
      assert.equal(exited, false, `bridge exited: ${stderr}`);
      await once(activity, 'change', { signal: t.signal });
    }
  }
  await cp(new URL('../src/', import.meta.url), join(root, 'src'), { recursive: true });
  await cp(join(root, 'src', 'terminal-sessions.mjs'), join(root, 'src', 'terminal-sessions-original.mjs'));
  await writeFile(join(root, 'src', 'terminal-sessions.mjs'), `import { terminalThreads as real } from './terminal-sessions-original.mjs';
    export const terminalThreads = (rpc, threads) => real(rpc, threads, async () => ({ ports: new Set([5555]), processes: 1 }));`);
  await writeFile(join(root, 'src', 'telegram-curl.mjs'), `export const curlFetch = (url, options) => fetch(url, { ...options, headers: { ...options.headers, 'x-test-transport': 'curl' } });`);
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'dir');
  await mkdir(join(root, '.local'));
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, '.local', 'state.json'), JSON.stringify({ owner: { userId: 34, chatId: 12 },
    addresses: { 'task-a': { code: 'c1' } }, replies: {}, offset: 0,
    autoAllowThreads: outage === 'restored' ? { 'task-a': true } : {} }));
  await writeFile(join(root, 'bin', 'codex'), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ status: 'running', socketPath }))});\n`, { mode: 0o700 });
  await writeFile(join(root, 'fake-telegram.mjs'), `
    let next = 0;
    const pending = new Map();
    process.on('message', message => {
      const resolve = pending.get(message.id);
      if (!resolve) return;
      pending.delete(message.id);
      resolve({ json: async () => message.payload });
    });
    globalThis.fetch = async (url, options) => new Promise(resolve => {
      const id = ++next;
      pending.set(id, resolve);
      process.send({ id, method: new URL(url).pathname.split('/').at(-1), data: JSON.parse(options.body), transport: options.headers['x-test-transport'] || 'fetch' });
    });
  `);
  websocket.on('connection', socket => {
    codexSocket = socket;
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      const reply = result => socket.send(JSON.stringify({ id: message.id, result }));
      if (message.method === 'initialize') reply({});
      if (message.method === 'thread/loaded/list') reply({ data: ['child-a', 'grandchild-a', 'other-child', 'task-a', 'closed-task'] });
      if (message.method === 'thread/read') {
        const id = message.params.threadId;
        const parents = { 'child-a': 'task-a', 'grandchild-a': 'child-a', 'other-child': 'closed-task' };
        reply({ thread: { id, ...(parents[id] ? { parentThreadId: parents[id], agentNickname: id } : {}),
          name: id === 'task-a' ? 'MCP fixture' : 'Closed fixture', status: childWaiting && id === 'child-a'
            ? { type: 'active', activeFlags: ['waitingOnApproval'] } : { type: 'idle' } } });
      }
      if (message.method === 'mcpServerStatus/list') reply({ data: message.params.threadId === 'task-a'
        ? [{ name: 'codex_tui', httpOrigin: 'http://127.0.0.1:5555' }] : [] });
      if (message.method === 'thread/turns/list') reply({ data: [] });
      if (message.method === 'thread/resume') {
        if (outage === 'restored' && ['child-a', 'grandchild-a'].includes(message.params.threadId)) {
          socket.send(JSON.stringify({ id: 'child-replayed-' + message.params.threadId, method: 'mcpServer/elicitation/request', params: {
            threadId: message.params.threadId, serverName: 'cua_repl', mode: 'form',
            message: 'Allow Computer Use to use "Microsoft Edge"?', requestedSchema: { type: 'object', properties: {} },
            _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'get_app_state', tool_params: { app: 'com.microsoft.edgemac' } },
          } }));
        }
        if (message.params.threadId !== 'task-a') return reply({});
        socket.send(JSON.stringify({ id: 'approval-1', method: 'mcpServer/elicitation/request', params: {
          threadId: 'task-a', turnId: 'turn-a', serverName: 'cua_repl', mode: 'form',
          message: 'Allow the cua_repl MCP server to run tool "js"?',
          requestedSchema: { type: 'object', properties: {} },
          _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'],
            tool_params: { code: 'read current state' } },
        } }));
        reply({});
      }
      if (!message.method && message.id !== undefined) {
        responses.push(message);
        activity.emit('change');
      }
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  child = fork(join(root, 'src', 'main.mjs'), [], {
    execArgv: ['--import', join(root, 'fake-telegram.mjs')],
    env: { ...process.env, TELEGRAM_TOKEN: 'local-test', PATH: join(root, 'bin') + delimiter + process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('exit', () => { exited = true; activity.emit('change'); });
  child.stdout.on('data', bytes => { stdout += bytes; activity.emit('change'); });
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('message', request => {
    calls.push(request);
    let result = true;
    if (request.method === 'getMe') result = { username: 'TestBot' };
    if (request.method === 'sendMessage' && outage && !failedCard && request.data.text.includes('等待 MCP 工具授权')) {
      failedCard = true;
      child.send({ id: request.id, payload: { ok: false, error_code: 502, description: 'Bad Gateway' } });
      activity.emit('change');
      return;
    }
    if (request.method === 'sendMessage' && outage && !failedList && request.data.text.startsWith('终端中打开的会话：')) {
      failedList = true;
      child.send({ id: request.id, payload: { ok: false, error_code: 502, description: 'Bad Gateway' } });
      activity.emit('change');
      return;
    }
    if (request.method === 'getUpdates') {
      pollCount++;
      if (outage && pollCount <= 2) {
        child.send({ id: request.id, payload: pollCount === 1 || outage === 'fallback'
          ? { ok: false, error_code: 502, description: 'Bad Gateway' }
          : { ok: true, result: [] } });
        activity.emit('change');
        return;
      }
      if (outage === 'fallback' && pollCount === 3) {
        child.send({ id: request.id, payload: { ok: true, result: [] } });
        activity.emit('change');
        return;
      }
      polls.push(request);
      activity.emit('change');
      return;
    }
    if (request.method === 'answerCallbackQuery' && outage === 'fallback') return; // A hung acknowledgement must not block a live approval.
    if (request.method === 'sendMessage') result = { ...request.data, message_id: calls.length };
    const payload = request.method === 'answerCallbackQuery'
      ? { ok: false, error_code: 400, description: 'query is too old and response timeout expired' }
      : { ok: true, result };
    child.send({ id: request.id, payload });
    activity.emit('change');
  });
  if (outage === 'restored') {
    await until(() => polls.length && responses.length === 3);
    assert.deepEqual(responses.map(r => r.id), ['approval-1', 'child-replayed-child-a', 'child-replayed-grandchild-a']);
    assert.ok(responses.every(r => JSON.stringify(r.result) === JSON.stringify({ action: 'accept', content: {}, _meta: null })));
    assert.equal(calls.some(x => x.method === 'sendMessage' && x.data.text.includes('等待 MCP 工具授权')), false);
    const runtime = JSON.parse(await readFile(join(root, '.local', 'runtime.json'), 'utf8'));
    assert.deepEqual(runtime.autoAllowTasks, ['@c1']);
    assert.equal(runtime.autoApprovals, 3);
    assert.equal(runtime.loadedSubtasks, 3);
    assert.equal(runtime.lastAutoApproval.rootThreadId, 'task-a');
    return;
  }
  await until(() => polls.length && stdout.includes('Telegram 已接收交互请求卡片'));
  const cards = calls.filter(x => x.method === 'sendMessage' && x.data.text.includes('等待 MCP 工具授权'));
  assert.equal(cards.length, outage ? 2 : 1);
  if (outage) assert.deepEqual(cards[0].data.reply_markup, cards[1].data.reply_markup, 'retry keeps the same single-use request key');
  const card = cards.at(-1);
  assert.ok(card);
  assert.match(card.data.text, /read current state/);
  const buttons = card.data.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.length, 4);
  assert.ok(buttons.every(x => Buffer.byteLength(x.callback_data) <= 64));
  const session = buttons.find(x => x.callback_data.endsWith(':session'));
  assert.ok(session);
  assert.equal(responses.length, 0, 'sending a card must not approve it');
  const runtime = JSON.parse(await readFile(join(root, '.local', 'runtime.json'), 'utf8'));
  assert.equal(runtime.lastRequestDeliveredToTelegram.interactive, true);
  if (outage === 'fallback') {
    assert.equal(runtime.telegramTransport, 'curl');
    assert.ok(calls.some(x => x.method === 'getUpdates' && x.transport === 'curl'));
  }
  const click = { update_id: 1, callback_query: { id: 'click-1', from: { id: 34 }, data: session.callback_data,
    message: { message_id: 99, chat: { id: 12, type: 'private' } } } };
  child.send({ id: polls.shift().id, payload: { ok: true, result: [click] } });
  await until(() => responses.length && polls.length);
  assert.deepEqual(responses, [{ id: 'approval-1', result: { action: 'accept', content: {}, _meta: { persist: 'session' } } }]);
  assert.ok(calls.some(x => x.method === 'editMessageReplyMarkup' && x.data.reply_markup.inline_keyboard.length === 0));
  child.send({ id: polls.shift().id, payload: { ok: true, result: [{ ...click, update_id: 2 }] } });
  await until(() => calls.some(x => x.method === 'sendMessage' && x.data.text.includes('此请求已经处理或过期')));
  assert.equal(responses.length, 1, 'a duplicate click must not submit the decision again');
  await until(() => polls.length);
  child.send({ id: polls.shift().id, payload: { ok: true, result: [{ update_id: 3,
    message: { from: { id: 34 }, chat: { id: 12, type: 'private' }, text: '/tasks' } }] } });
  await until(() => calls.some(x => x.method === 'sendMessage' && x.data.text.startsWith('终端中打开的会话：')));
  const list = calls.find(x => x.method === 'sendMessage' && x.data.text.startsWith('终端中打开的会话：'));
  assert.match(list.data.text, /MCP fixture/);
  assert.match(list.data.text, /等待新指令/);
  assert.ok(!list.data.text.includes('Closed fixture'));
  assert.equal(list.data.reply_markup.inline_keyboard.flat().length, 1);
  if (outage) {
    await until(() => polls.length);
    await new Promise(resolve => setTimeout(resolve, 2100));
    child.send({ id: polls.shift().id, payload: { ok: true, result: [] } });
  }
  await until(() => stdout.includes('Telegram 已接收会话列表'));
  assert.equal(calls.filter(x => x.method === 'sendMessage' && x.data.text.startsWith('终端中打开的会话：')).length, outage ? 2 : 1);
  const deliveredRuntime = JSON.parse(await readFile(join(root, '.local', 'runtime.json'), 'utf8'));
  assert.ok(deliveredRuntime.lastTaskListDelivered.messageId);
  const saved = JSON.parse(await readFile(join(root, '.local', 'state.json'), 'utf8'));
  assert.equal(saved.tasksReplyPending, false);
  if (!outage) {
    let updateId = 3;
    const textUpdate = text => ({ update_id: ++updateId,
      message: { from: { id: 34 }, chat: { id: 12, type: 'private' }, text } });
    async function sendUpdate(update) {
      await until(() => polls.length);
      child.send({ id: polls.shift().id, payload: { ok: true, result: [update] } });
      await until(() => polls.length);
    }
    // An unrelated Telegram user cannot turn automation on.
    const unauthorized = textUpdate('/autoallow c1 on');
    unauthorized.message.from.id = 99;
    await sendUpdate(unauthorized);
    assert.equal(JSON.parse(await readFile(join(root, '.local', 'state.json'), 'utf8')).autoAllowThreads['task-a'], undefined);
    // Queue a current approval, then enable from the session detail button.
    const approval = { id: 'auto-command', method: 'item/commandExecution/requestApproval',
      params: { threadId: 'task-a', command: 'pwd', availableDecisions: ['accept', 'decline'] } };
    codexSocket.send(JSON.stringify(approval));
    await until(() => calls.some(x => x.method === 'sendMessage' && x.data.text.includes('等待你的批准')));
    await sendUpdate({ update_id: ++updateId, callback_query: { id: 'open-task', from: { id: 34 },
      data: 'open:task-a', message: { message_id: 100, chat: { id: 12, type: 'private' } } } });
    const detail = calls.find(x => x.method === 'sendMessage' && x.data.text.includes('自动允许：已关闭'));
    assert.ok(detail);
    const enableButton = detail.data.reply_markup.inline_keyboard.flat()[0];
    const childApproval = { id: 'child-current', method: 'mcpServer/elicitation/request', params: {
      threadId: 'child-a', serverName: 'cua_repl', mode: 'form', message: 'Allow Computer Use to use "Microsoft Edge"?',
      requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call' },
    } };
    codexSocket.send(JSON.stringify(childApproval));
    await until(() => calls.some(x => x.method === 'sendMessage' && x.data.text.includes('Microsoft Edge')));
    const childCard = calls.find(x => x.method === 'sendMessage' && x.data.text.includes('Microsoft Edge'));
    assert.match(childCard.data.text, /@c1 \/ 子任务 child-a/);
    childWaiting = true;
    await sendUpdate(textUpdate('/tasks'));
    const waitingList = calls.filter(x => x.method === 'sendMessage' && x.data.text.startsWith('终端中打开的会话：')).at(-1);
    assert.match(waitingList.data.text, /@c1 · ⏳ 等待批准/);
    assert.equal(waitingList.data.reply_markup.inline_keyboard.flat().length, 1, 'children stay grouped under the root');
    childWaiting = false;
    await sendUpdate({ update_id: ++updateId, callback_query: { id: 'enable-auto', from: { id: 34 },
      data: enableButton.callback_data, message: { message_id: 101, chat: { id: 12, type: 'private' } } } });
    assert.deepEqual(responses.find(x => x.id === 'auto-command').result, { decision: 'accept' });
    assert.deepEqual(responses.find(x => x.id === 'child-current').result, { action: 'accept', content: {}, _meta: null });
    // New approvals proceed without sending a card, even when Telegram is not polled.
    const sendCount = calls.filter(x => x.method === 'sendMessage').length;
    const next = { ...approval, id: 'auto-next' };
    codexSocket.send(JSON.stringify(next));
    await until(() => responses.some(x => x.id === 'auto-next'));
    codexSocket.send(JSON.stringify(next));
    // A separate session remains manual; waiting for its card flushes the replay.
    codexSocket.send(JSON.stringify({ ...approval, id: 'other-thread', params: { ...approval.params, threadId: 'other-child' } }));
    await until(() => calls.filter(x => x.method === 'sendMessage').length > sendCount);
    assert.equal(responses.filter(x => x.id === 'auto-next').length, 1);
    assert.equal(responses.some(x => x.id === 'other-thread'), false);
    codexSocket.send(JSON.stringify({ ...approval, id: 'grandchild-next', params: { ...approval.params, threadId: 'grandchild-a' } }));
    await until(() => responses.some(x => x.id === 'grandchild-next'));
    const toolApproval = { id: 'auto-mcp', method: 'mcpServer/elicitation/request', params: {
      threadId: 'task-a', serverName: 'cua_repl', mode: 'form', requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
    } };
    codexSocket.send(JSON.stringify(toolApproval));
    await until(() => responses.some(x => x.id === 'auto-mcp'));
    assert.deepEqual(responses.find(x => x.id === 'auto-mcp').result, { action: 'accept', content: {}, _meta: null });
    codexSocket.send(JSON.stringify({ id: 'human-question', method: 'item/tool/requestUserInput', params: {
      threadId: 'child-a', questions: [{ id: 'q1', question: 'Human choice required', options: [] }],
    } }));
    await until(() => calls.some(x => x.method === 'sendMessage' && x.data.text.includes('Human choice required')));
    assert.equal(responses.some(x => x.id === 'human-question'), false);
    await sendUpdate(textUpdate('/autoallow'));
    assert.ok(calls.some(x => x.method === 'sendMessage' && x.data.text.startsWith('已开启自动允许的会话：\n@c1')));
    await sendUpdate(textUpdate('/autoallow c1 off'));
    codexSocket.send(JSON.stringify({ ...approval, id: 'manual-after-off', params: { ...approval.params, threadId: 'child-a', command: 'echo manual-after-off' } }));
    await until(() => calls.some(x => x.method === 'sendMessage' && x.data.text.includes('echo manual-after-off')));
    assert.equal(responses.some(x => x.id === 'manual-after-off'), false);
    assert.equal(JSON.parse(await readFile(join(root, '.local', 'state.json'), 'utf8')).autoAllowThreads['task-a'], undefined);
  }
});
