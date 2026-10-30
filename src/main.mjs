import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSync, writeFileSync, closeSync, readFileSync, unlinkSync, renameSync } from 'node:fs';
import { CodexRPC } from './rpc.mjs';
import { Telegram, redact } from './telegram.mjs';
import { State } from './state.mjs';
import { Addresses } from './addresses.mjs';
import { BOT_COMMANDS, registerCommands } from './commands.mjs';
import { deliverInput, deliveryDescription } from './delivery.mjs';
import { loadThreadSnapshot, missingThread, threadOwners } from './threads.mjs';
import { mcpToolApproval, mcpApprovalResult } from './mcp-approval.mjs';
import { RequestNotifications } from './request-notifications.mjs';
import { createClashWatch } from './clash-watch.mjs';
import { terminalThreads } from './terminal-sessions.mjs';
import { TaskListReply } from './task-list-reply.mjs';
import { AutoAllow } from './auto-allow.mjs';
import { authorized, matchingCode, parsePairCommand, title, statusText, PendingRequests, approvalResult } from './core.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const token = process.env.TELEGRAM_TOKEN;
const checking = process.argv.includes('--check');
let runtime;
function updateRuntime(values) {
  if (checking || !runtime) return;
  Object.assign(runtime, values);
  const path = join(project, '.local', 'runtime.json');
  writeFileSync(path + '.tmp', JSON.stringify(runtime, null, 2), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}
const logError = error => {
  const message = redact(`${error?.method ? `Telegram ${error.method} [${error.transport}]：` : ''}${error?.message || error}`, token);
  console.error(`${new Date().toISOString()} ${message}`);
  try { updateRuntime({ lastError: { message, at: new Date().toISOString() } }); } catch {}
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rpc = new CodexRPC();

if (!token) {
  console.error('缺少 TELEGRAM_TOKEN。请在你的终端 export TELEGRAM_TOKEN 后运行。');
  process.exit(1);
}

const telegram = new Telegram(token, fetch, {
  onTransport(change) {
    const at = new Date().toISOString();
    updateRuntime({ telegramTransport: change.transport, lastTelegramTransportChange: { ...change, at } });
    console.log(`${at} Telegram 连接通道切换 ${JSON.stringify(change)}`);
  },
});
const state = new State(join(project, '.local'));
runtime = {
  pid: process.pid, startedAt: new Date().toISOString(), status: 'starting',
  codexConnected: false, telegramConnected: false, telegramTransport: 'fetch', loadedTasks: 0,
  lastCodexSuccessAt: null, lastTelegramSuccessAt: null, lastError: null,
};
const addresses = new Addresses(state.data.addresses);
const pending = new PendingRequests();
let owners = new Map();
const subagents = new Map();
const rootThread = id => owners.get(id) || id;
const autoAllow = new AutoAllow(state, pending, {
  owner: rootThread,
  respond: (id, result) => rpc.respond(id, result),
  approved(request) {
    const record = { task: taskAddress(request.params.threadId), requestId: request.id, threadId: request.params.threadId,
      rootThreadId: rootThread(request.params.threadId), method: request.method, at: new Date().toISOString() };
    updateRuntime({ lastAutoApproval: record, autoApprovals: (runtime.autoApprovals || 0) + 1 });
    console.log(`${record.at} 已自动允许 ${JSON.stringify(record)}`);
  },
});
const threads = new Map();
const watching = new Set();
const attempts = new Map();
let pairCode = randomBytes(12).toString('hex');
const pairExpiry = Date.now() + 30 * 60 * 1000;
let running = true;
let refreshing;

async function tell(text, extra, target, current) {
  if (!state.data.owner) return;
  const message = await telegram.send(state.data.owner.chatId, text, extra, current);
  if (target && message) state.reply(message.message_id, { ...target, threadId: rootThread(target.threadId) });
  return message;
}

function friend(id) {
  const thread = threads.get(rootThread(id));
  return thread ? `${taskAddress(id)} · ${title(thread)}` : taskAddress(id);
}

function taskAddress(id) {
  const address = addresses.display(rootThread(id)) || id;
  const child = subagents.get(id);
  return child ? `${address} / 子任务 ${child.agentNickname || child.source?.subAgent?.thread_spawn?.agent_nickname || id}` : address;
}

function friendStatus(thread) {
  if (!thread) return statusText();
  const activeFlags = new Set(thread.status?.activeFlags || []);
  for (const child of subagents.values()) {
    if (rootThread(child.id) === thread.id) {
      for (const flag of child.status?.activeFlags || []) activeFlags.add(flag);
    }
  }
  return statusText({ ...thread.status, activeFlags: [...activeFlags] });
}

function refresh() {
  if (!refreshing) refreshing = refreshThreads().finally(() => { refreshing = null; });
  return refreshing;
}

async function refreshThreads() {
  try {
    await rpc.connect();
    const snapshot = await loadThreadSnapshot(rpc);
    owners = threadOwners(snapshot.threads, snapshot.subagents);
    subagents.clear();
    for (const thread of snapshot.subagents) if (owners.has(thread.id)) subagents.set(thread.id, thread);
    const ids = new Set();
    let skippedTasks = snapshot.missingIds.length;
    for (const thread of snapshot.threads) {
      const id = thread.id;
      ids.add(id);
      threads.set(id, thread);
      if (addresses.ensure(id)) state.save();
    }
    for (const id of threads.keys()) if (!ids.has(id)) threads.delete(id);
    for (const thread of [...snapshot.threads, ...subagents.values()]) {
      const id = thread.id;
      if (!threads.has(rootThread(id))) continue;
      ids.add(id);
      if (!checking && state.data.owner && !watching.has(id)) {
        watching.add(id); // Pending requests may replay before resume's response.
        try { await rpc.call('thread/resume', { threadId: id, excludeTurns: true }); }
        catch (error) {
          watching.delete(id);
          if (missingThread(error)) { ids.delete(id); threads.delete(id); skippedTasks++; }
          else { logError(error); if (!rpc.connected) throw error; }
        }
      }
    }
    for (const id of watching) {
      if (!ids.has(id) || !threads.has(rootThread(id))) { watching.delete(id); pending.removeThread(id); }
    }
    for (const id of subagents.keys()) {
      if (!ids.has(id) || !threads.has(rootThread(id))) { subagents.delete(id); owners.delete(id); }
    }
    if (!rpc.connected) throw new Error('Codex 后台连接已断开，正在等待自动重连。');
    updateRuntime({ codexConnected: true, loadedTasks: threads.size, loadedSubtasks: subagents.size,
      waitingSubtasks: [...subagents.values()].filter(t => t.status?.activeFlags?.includes('waitingOnApproval')).map(t => taskAddress(t.id)),
      skippedTasks, lastCodexSuccessAt: new Date().toISOString() });
  } catch (error) {
    updateRuntime({ codexConnected: rpc.connected });
    throw error;
  }
}

const taskListReply = new TaskListReply(state, {
  render: renderFriends,
  delivered(message) {
    const delivery = { messageId: message.message_id, at: new Date().toISOString() };
    updateRuntime({ lastTaskListDelivered: delivery });
    console.log(`${delivery.at} Telegram 已接收会话列表 ${JSON.stringify(delivery)}`);
  },
});
const listFriends = () => taskListReply.request();

async function renderFriends() {
  await refresh();
  const snapshot = await terminalThreads(rpc, threads.values());
  updateRuntime({ terminalTasks: snapshot.threads.length, terminalProcesses: snapshot.processes,
    lastTerminalScanAt: new Date().toISOString() });
  const all = snapshot.threads.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!all.length) return tell('没有检测到终端中打开的 Codex 会话。请在 VS Code Terminal 或 iTerm2 中打开会话后重新 /tasks。' +
    (snapshot.unconfirmed ? '\n部分会话的终端状态暂时无法确认，请稍后重试。' : ''));
  let message;
  for (let i = 0; i < all.length; i += 12) {
    const page = all.slice(i, i + 12);
    message = await tell('终端中打开的会话：\n\n' + page.map(thread => `${addresses.display(thread.id)} · ${friendStatus(thread)}${autoAllow.enabled(thread.id) ? ' · 自动允许（含子任务）' : ''}\n${title(thread)}`).join('\n\n') + '\n\n用 @名字 消息 直接与会话对话，例如 @c1 继续。' +
      (snapshot.unconfirmed ? '\n部分会话的终端状态暂时无法确认，已隐藏，可稍后重试 /tasks。' : ''), {
      reply_markup: { inline_keyboard: page.map(thread => [{
        text: `${addresses.display(thread.id)} ${title(thread).slice(0, 24)}`, callback_data: `open:${thread.id}`,
      }]) },
    });
  }
  return message;
}

async function recent(id) {
  const result = await rpc.call('thread/turns/list', { threadId: id, limit: 1, itemsView: 'full', sortDirection: 'desc' });
  const turn = result.data[0];
  const messages = (turn?.items || []).filter(item => ['agentMessage', 'userMessage'].includes(item.type));
  const content = messages.slice(-4).map(item => item.type === 'agentMessage'
    ? `Codex：${item.text}` : `你：${(item.content || []).map(x => x.text || '').join('')}`).join('\n\n');
  await tell(`好友：${friend(id)}\n${friendStatus(threads.get(id))}\n自动允许：${autoAllow.enabled(id) ? '已开启（含子任务）' : '已关闭'}\n\n${content || '暂无最近对话。'}\n\n直接发送文字与这个任务对话，也可回复它的通知。`, autoAllowControls(id), { threadId: id });
}

function autoAllowControls(id) {
  const enabled = autoAllow.enabled(id);
  return { reply_markup: { inline_keyboard: [[{
    text: enabled ? '关闭此会话及子任务自动允许' : '开启自动允许（含子任务和当前审批）',
    callback_data: `auto:${id}:${enabled ? 'off' : 'on'}`,
  }]] } };
}

async function setAutoAllow(id, enabled) {
  if (enabled) {
    await refresh();
    if (!threads.has(id)) throw new Error('这个会话当前未连接，请 /tasks 选择。');
  }
  autoAllow.set(id, enabled);
  updateRuntime({ autoAllowTasks: autoAllow.enabledIds().map(id => addresses.display(id)) });
  if (enabled) {
    for (const [key, entry] of pending.entries) {
      if (rootThread(entry.request.params.threadId) === id) autoAllow.apply(key);
    }
  }
  return tell(`「${friend(id)}」自动允许已${enabled ? '开启' : '关闭'}。\n` + (enabled
    ? '此会话及其子任务当前和后续的命令、文件、权限和 MCP 工具审批会自动允许。问题、登录和表单仍需你处理。\n设置绑定此主会话，桥接重启后保留；可随时用下方按钮关闭。'
    : '后续新审批恢复手动确认，已提交的批准不会撤销。'), autoAllowControls(id));
}

async function sendInput(id, text, inputId) {
  if (!threads.has(id)) throw new Error('这个任务目前未连接，请重新 /tasks 选择。');
  const result = await deliverInput(rpc, id, text, inputId || randomUUID());
  await tell(`「${friend(id)}」\n${deliveryDescription(result.status)}\n审批请使用对应审批卡片的按钮。`, undefined, { threadId: id });
}

const notifications = new RequestNotifications(pending, {
  render: renderRequest,
  logError,
  delivered(request, message) {
    const task = taskAddress(request.params.threadId);
    const interactive = Boolean(message.reply_markup?.inline_keyboard?.some(row => row.some(button => button.callback_data)));
    const delivery = { task, method: request.method, messageId: message.message_id, interactive, at: new Date().toISOString() };
    updateRuntime({ lastRequestDeliveredToTelegram: delivery });
    console.log(`${delivery.at} Telegram 已接收${interactive ? '交互请求卡片' : '请求通知'} ${JSON.stringify(delivery)}`);
  },
  failed(request, error) {
    const task = taskAddress(request.params.threadId);
    updateRuntime({ lastRequestDeliveryError: { task, method: request.method, message: redact(error.message, token), at: new Date().toISOString() } });
  },
});
async function showRequest(key, options) {
  if (!autoAllow.apply(key)) return notifications.show(key, options);
}

async function renderRequest(key, current) {
  const entry = pending.entries.get(key);
  if (!entry) return;
  const { method, params: p } = entry.request;
  const heading = `好友：${friend(p.threadId)}`;
  const target = { threadId: p.threadId, requestKey: key };
  const send = (text, extra, target) => tell(text, extra, target, current);
  if (method === 'mcpServer/elicitation/request') {
    const approval = mcpToolApproval(entry.request);
    if (!approval) return send(`${heading}\nMCP 服务 ${p.serverName} 需要填写表单、登录或其他交互，请在电脑上处理。`, undefined, { threadId: p.threadId });
    return send(`${heading}\n⏳ 等待 MCP 工具授权\n\n${approval.details}`, {
      reply_markup: { inline_keyboard: approval.decisions.map(({ value, text }) => [{ text, callback_data: `m:${key}:${value}` }]) },
    }, target);
  }
  if (method === 'item/tool/requestUserInput') {
    const question = p.questions[entry.questionIndex];
    if (!question) return;
    if (question.isSecret) {
      return send(`${heading}\n需要输入私密信息，请在电脑上回答。`, undefined, { threadId: p.threadId });
    }
    const options = question.options || [];
    return send(`${heading}\n问题 ${entry.questionIndex + 1}/${p.questions.length}：${question.question}\n\n${options.map((o, i) => `${i + 1}. ${o.label}\n${o.description}`).join('\n\n')}\n\n也可以使用 Telegram 的“回复”回答这条消息。`, {
      reply_markup: { inline_keyboard: options.map((o, i) => [{ text: o.label, callback_data: `q:${key}:${entry.questionIndex}:${i}` }]) },
    }, { ...target, questionIndex: entry.questionIndex });
  }
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(method)) {
    let detail = p.command ? `操作：\n${p.command}` : '';
    if (p.networkApprovalContext) detail += `\n网络访问：${JSON.stringify(p.networkApprovalContext)}`;
    if (p.additionalPermissions) detail += `\n附加权限：${JSON.stringify(p.additionalPermissions)}`;
    if (p.permissions) detail += `\n请求权限：${JSON.stringify(p.permissions)}`;
    if (method === 'item/fileChange/requestApproval') {
      const page = await rpc.call('thread/items/list', { threadId: p.threadId, turnId: p.turnId, sortDirection: 'desc', limit: 100 });
      const item = page.data.find(x => x.item.id === p.itemId)?.item;
      if (!item) return send(`${heading}\n有文件修改审批，但无法取得修改详情。请在电脑上处理。`, undefined, { threadId: p.threadId });
      detail = (item.changes || []).map(c => `${c.path}\n${c.diff}`).join('\n\n');
    }
    if (!detail && !p.reason) return send(`${heading}\n审批详情不可用，请在电脑上处理。`, undefined, { threadId: p.threadId });
    const allowed = p.availableDecisions || ['accept', 'decline', 'cancel'];
    const buttons = [['accept', method === 'item/permissions/requestApproval' ? '授权当前轮次' : '批准一次'], ['decline', '拒绝']]
      .filter(([value]) => allowed.includes(value))
      .map(([value, text]) => ({ text, callback_data: `a:${key}:${value}` }));
    return send(`${heading}\n⏳ 等待你的批准\n${p.reason || ''}\n${p.cwd ? `目录：${p.cwd}\n` : ''}${detail}`, {
      reply_markup: { inline_keyboard: [buttons] },
    }, target);
  }
  return send(`${heading}\n需要在电脑上处理：${method}`, undefined, { threadId: p.threadId });
}

async function answerQuestion(key, answer, questionIndex) {
  const entry = pending.entries.get(key);
  if (!entry) throw new Error('这个问题已经回答或过期。');
  if (questionIndex !== undefined && entry.questionIndex !== questionIndex) throw new Error('这道问题已经回答，请使用最新的问题卡片。');
  const question = entry.request.params.questions[entry.questionIndex];
  if (question.isSecret) throw new Error('私密信息请在电脑上回答。');
  entry.answers[question.id] = { answers: [answer] };
  entry.questionIndex++;
  if (entry.questionIndex < entry.request.params.questions.length) return showRequest(key);
  pending.take(key);
  rpc.respond(entry.request.id, { answers: entry.answers });
  await tell(`已回答「${friend(entry.request.params.threadId)}」的问题。`);
}

rpc.on('request', request => {
  if (!watching.has(request.params?.threadId)) return;
  const key = pending.add(request);
  const received = { task: taskAddress(request.params.threadId), requestId: request.id, threadId: request.params.threadId,
    rootThreadId: rootThread(request.params.threadId), method: request.method, at: new Date().toISOString() };
  updateRuntime({ lastCodexRequestReceived: received });
  console.log(`${received.at} 收到 Codex 请求 ${JSON.stringify(received)}`);
  showRequest(key).catch(logError);
});
rpc.on('notification', notification => {
  const { method, params: p } = notification;
  if (method === 'serverRequest/resolved') pending.resolved(p.threadId, p.requestId);
  if (!watching.has(p?.threadId)) return;
  if (method === 'thread/status/changed' && threads.has(p.threadId)) threads.get(p.threadId).status = p.status;
  if (method === 'thread/status/changed' && subagents.has(p.threadId)) subagents.get(p.threadId).status = p.status;
  if (subagents.has(p.threadId)) return; // Only approvals/questions are forwarded for child tasks.
  if (method === 'turn/completed') {
    const answer = (p.turn.items || []).filter(x => x.type === 'agentMessage').at(-1)?.text;
    tell(`好友：${friend(p.threadId)}\n本轮${p.turn.status === 'completed' ? '已完成' : p.turn.status}。\n\n${answer || p.turn.error?.message || '可打开任务查看最近对话。'}`, undefined, { threadId: p.threadId }).catch(logError);
  }
  if (method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.questions?.length) {
    tell(`好友：${friend(p.threadId)}\n💬 ${p.item.text}`, undefined, { threadId: p.threadId }).catch(logError);
  }
});

async function handle(update) {
  const message = update.message;
  const callback = update.callback_query;
  const chat = message?.chat || callback?.message?.chat;
  const user = message?.from || callback?.from;
  const text = message?.text || '';
  if (!state.data.owner) {
    if (chat?.type !== 'private' || !user) return;
    const localText = text.trim();
    const record = status => {
      state.data.lastPairingAttempt = { status, at: new Date().toISOString() };
      state.save();
    };
    if (/^\/start(?:@\w+)?(?:\s|$)/.test(localText)) {
      record('startedWithoutPairing');
      await telegram.send(chat.id, '机器人在线。请复制电脑提供的完整 /pair 配对指令发送到这里，绑定后才能查看 Codex 任务。');
      return;
    }
    if (!/^\/pair(?:@\w+)?(?:\s|$)/.test(localText)) { record('notPairCommand'); return; }
    if (Date.now() > pairExpiry) {
      record('expired');
      await telegram.send(chat.id, '配对码已过期，请在电脑上重新启动桥接程序获取新的配对码。');
      return;
    }
    const attempt = attempts.get(user.id) || { count: 0, since: Date.now() };
    if (Date.now() - attempt.since > 60000) { attempt.count = 0; attempt.since = Date.now(); }
    if (++attempt.count > 5) { attempts.set(user.id, attempt); return; }
    attempts.set(user.id, attempt);
    if (!matchingCode(pairCode, parsePairCommand(localText))) {
      record('incorrectCode');
      await telegram.send(chat.id, '配对指令未匹配。请复制电脑显示的最新完整指令，格式为 /pair 加空格和配对码。');
      return;
    }
    state.data.owner = { chatId: chat.id, userId: user.id };
    pairCode = '';
    record('paired');
    state.save();
    await registerCommands(telegram, chat.id).catch(logError);
    await tell('配对成功。只有你的账号能控制任务。\n/tasks 查看好友列表\n/pending 查看等待中的请求\n/help 查看用法');
    await listFriends();
    return;
  }
  if (!authorized(state.data.owner, chat, user)) return;
  const timestamp = message?.date;
  if (timestamp && Date.now() / 1000 - timestamp > 300) {
    return tell('有一条超过五分钟的消息，未执行。请重新发送，以免把旧指令送进当前任务。');
  }
  if (callback) {
    // A delayed Telegram UI acknowledgement must not discard a still-live approval.
    telegram.call('answerCallbackQuery', { callback_query_id: callback.id }).catch(logError);
    const [kind, key, value, option] = (callback.data || '').split(':');
    if (kind === 'auto') {
      if (!Object.hasOwn(state.data.addresses, key) || !['on', 'off'].includes(value)) throw new Error('无效的自动允许开关。');
      return setAutoAllow(key, value === 'on');
    }
    await refresh();
    if (kind === 'open') {
      if (!threads.has(key)) throw new Error('任务已断开，请重新 /tasks。');
      state.data.selected = key; state.save();
      return recent(key);
    }
    const entry = pending.entries.get(key);
    if (!entry) throw new Error('此请求已经处理或过期，请 /pending 查看当前请求。');
    if (kind === 'm') {
      const result = mcpApprovalResult(entry.request, value);
      rpc.respond(entry.request.id, result);
      pending.take(key);
      await telegram.call('editMessageReplyMarkup', { chat_id: chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(logError);
      const decision = { accept: '允许本次', session: '允许该工具用于本会话', decline: '拒绝', cancel: '取消' }[value];
      return tell(`已向「${friend(entry.request.params.threadId)}」提交：${decision}。`);
    }
    if (kind === 'a') {
      const result = approvalResult(entry.request, value);
      pending.take(key);
      rpc.respond(entry.request.id, result);
      await telegram.call('editMessageReplyMarkup', { chat_id: chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return tell(`已向「${friend(entry.request.params.threadId)}」提交${value === 'accept' ? '批准' : '拒绝'}。`);
    }
    if (kind === 'q') {
      const question = entry.request.params.questions?.[Number(value)];
      const answer = question?.options?.[Number(option)]?.label;
      if (!answer) throw new Error('无效的问题选项。');
      return answerQuestion(key, answer, Number(value));
    }
    return;
  }
  if (!text) return;
  const command = text.match(/^\/([a-z]+)(?:@\w+)?(?:\s|$)/)?.[1];
  if (command === 'tasks') return listFriends();
  if (command === 'autoallow') {
    const parts = text.trim().split(/\s+/).slice(1);
    if (!parts.length) {
      const ids = autoAllow.enabledIds();
      return tell('已开启自动允许的会话：\n' + (ids.map(id => friend(id)).join('\n') || '（无）') +
        '\n\n/autoallow c1 on — 开启，含子任务和当前等待的审批\n/autoallow c1 off — 关闭\n/autoallow c1 — 查看状态\n绑定指定主会话及其子任务，桥接重启后保留。');
    }
    if (parts.length > 2 || (parts[1] && !['on', 'off'].includes(parts[1]))) throw new Error('用法：/autoallow c1 on 或 /autoallow c1 off');
    const id = addresses.find(parts[0]);
    if (!id) throw new Error('找不到这个会话，请 /tasks 查看名字。');
    if (!parts[1]) return tell(`「${friend(id)}」自动允许：${autoAllow.enabled(id) ? '已开启' : '已关闭'}。`, autoAllowControls(id));
    return setAutoAllow(id, parts[1] === 'on');
  }
  if (command === 'pending') {
    await refresh();
    if (!pending.entries.size) return tell('当前连接没有等待中的请求。');
    for (const key of pending.entries.keys()) await showRequest(key, { force: true });
    return;
  }
  if (command === 'start' || command === 'help') {
    return tell(BOT_COMMANDS.map(item => `/${item.command} — ${item.description}`).join('\n') + '\n\n@c1 继续：给指定会话发送消息。\n@c1 @c2 各自汇报进度：发给多个指定会话。\n/alias c1 登录：取名后可用 @登录 发消息。\n\n直接发文字给选中的会话，或回复该会话的通知。批准使用审批按钮；问题可点击选项或回复问题卡片。');
  }
  if (command === 'alias') {
    const match = text.trim().match(/^\/alias(?:@\w+)?\s+(\S+)\s+(\S+)$/);
    if (!match) return tell('用法：/alias c1 登录\n之后发送：@登录 继续');
    const id = addresses.rename(match[1], match[2]);
    state.save();
    return tell(`已取名：${friend(id)}\n可以发送：@${state.data.addresses[id].alias} 继续`, undefined, { threadId: id });
  }
  if (command === 'view') {
    await refresh();
    if (!state.data.selected) return tell('先用 /tasks 选择一个好友。');
    return recent(state.data.selected);
  }
  if (command) return tell('未知命令，请 /help 查看用法。');
  await refresh();
  const mention = addresses.route(text, new Set(threads.keys()));
  if (mention) {
    for (const id of mention.targets) {
      await sendInput(id, mention.text, `telegram-${chat.id}-${message.message_id}-${id}`);
    }
    return;
  }
  const target = state.data.replies[message.reply_to_message?.message_id];
  if (message.reply_to_message && !target) return tell('这条消息没有对应的任务，请 /tasks 选择好友，或回复该任务最近的对话消息。');
  if (target?.requestKey) {
    const entry = pending.entries.get(target.requestKey);
    if (!entry) throw new Error('这条请求已经过期，请使用 /pending 查看当前请求。');
    if (entry.request.method === 'item/tool/requestUserInput') return answerQuestion(target.requestKey, text, target.questionIndex);
    return tell('这是审批请求，请使用该消息的批准／拒绝按钮。');
  }
  const id = target?.threadId || state.data.selected;
  if (!id) return tell('先用 /tasks 选择好友，再发送消息。');
  await sendInput(id, text, `telegram-${chat.id}-${message.message_id}`);
}

async function main() {
  let bot;
  let startupFailures = 0;
  while (!bot) {
    try { bot = await telegram.call('getMe'); }
    catch (error) {
      if (checking || [401, 409].includes(error.code)) throw error;
      logError(error);
      await delay(Math.min(30000, 1000 * 2 ** Math.min(++startupFailures, 5)));
    }
  }
  updateRuntime({ telegramConnected: true, lastTelegramSuccessAt: new Date().toISOString() });
  if (checking) await refresh();
  else await refresh().catch(logError);
  if (checking) {
    console.log(JSON.stringify({ bot: bot.username, codexConnected: true, tasks: threads.size, paired: Boolean(state.data.owner) }));
    rpc.close();
    return;
  }
  if (state.data.owner) await registerCommands(telegram, state.data.owner.chatId).catch(logError);
  console.log(`机器人：@${bot.username}；已连接 ${threads.size} 个任务。`);
  if (!state.data.owner) console.log(`请在三十分钟内，向机器人私聊发送：/pair ${pairCode}`);
  else await tell('Codex Friends 已上线。/tasks 查看会话名字；现在支持 @c1 继续 和 /alias c1 登录。').catch(logError);
  updateRuntime({ status: 'running' });
  const timer = setInterval(() => {
    refresh().catch(logError);
    notifications.retry().catch(logError);
    taskListReply.retry().catch(logError);
  }, 15000);
  let failures = 0;
  try {
    while (running) {
      try {
        const updates = await telegram.call('getUpdates', { offset: state.data.offset, timeout: 10, allowed_updates: ['message', 'callback_query'] });
        updateRuntime({ telegramConnected: true, lastTelegramSuccessAt: new Date().toISOString() });
        failures = 0;
        for (const update of updates) {
          // Commit before side effects: a crash must not re-run a remote instruction.
          state.data.offset = update.update_id + 1;
          state.save();
          try { await handle(update); }
          catch (error) { logError(error); await tell(redact(error.message, token)).catch(logError); }
        }
        notifications.retry().catch(logError);
        taskListReply.retry().catch(logError);
      } catch (error) {
        updateRuntime({ telegramConnected: false });
        logError(error);
        if ([401, 409].includes(error.code)) throw error;
        await delay(Math.min(30000, 1000 * 2 ** Math.min(++failures, 5)));
      }
    }
  } finally { clearInterval(timer); }
}

const lockPath = join(project, '.local', 'bridge.pid');
let locked = false;
if (!checking) {
  try {
    try {
      const old = Number(readFileSync(lockPath, 'utf8'));
      if (Number.isSafeInteger(old) && old > 0) {
        try { process.kill(old, 0); console.error('桥接程序已运行。'); process.exit(1); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      unlinkSync(lockPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, String(process.pid)); closeSync(fd); locked = true;
  } catch { console.error('无法取得程序锁，请检查 .local/bridge.pid。'); process.exit(1); }
}
process.on('exit', () => { if (locked) { try { unlinkSync(lockPath); } catch {} } });
if (!checking) updateRuntime({ status: 'starting' });
updateRuntime({ autoAllowTasks: autoAllow.enabledIds().map(id => addresses.display(id)) });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  updateRuntime({ status: 'stopped', codexConnected: false, telegramConnected: false });
  pending.clear(); rpc.close(); process.exit(0);
});
rpc.on('disconnect', error => {
  pending.clear();
  autoAllow.disconnected();
  owners.clear();
  subagents.clear();
  watching.clear();
  threads.clear();
  updateRuntime({ codexConnected: false, loadedTasks: 0 });
  logError(error);
});
let lastClashStatus;
const clashWatch = createClashWatch(project, status => {
  updateRuntime({ clashGuard: status });
  if (status.status !== lastClashStatus || status.status === 'switched') {
    console.log(`${status.at} Clash 自动巡检 ${JSON.stringify(status)}`);
    lastClashStatus = status.status;
  }
});
let clashTimer;
if (!checking) {
  // Start before Telegram getMe: VPN recovery must also work during startup.
  clashTimer = setInterval(() => clashWatch.tick().catch(logError), 15000);
  process.on('exit', () => clearInterval(clashTimer));
  clashWatch.tick().catch(logError);
}
main().catch(error => {
  clearInterval(clashTimer);
  logError(error); updateRuntime({ status: 'failed' }); rpc.close(); process.exitCode = 1;
});
