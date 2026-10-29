import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectService, startService, stopService } from '../src/lifecycle.mjs';
import { redact } from '../src/telegram.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function display(status) {
  const runtime = status.runtime;
  console.log(`桥接程序：${status.running ? '运行中' : '未运行'}`);
  if (status.running) console.log(`PID：${status.pid}；运行时长：${status.uptime}`);
  if (status.stalePid) console.log('检测到旧进程记录，下一次启动会自动清理。');
  console.log(`手机配对：${status.paired ? '已配对' : '未配对'}`);
  if (status.running && runtime) {
    console.log(`Codex 连接：${runtime.codexConnected ? '已连接' : '未连接'}；当前会话：${runtime.loadedTasks || 0}`);
    console.log(`自动允许会话：${runtime.autoAllowTasks?.join('、') || '无'}`);
    if (runtime.lastAutoApproval) console.log(`最近自动允许：${runtime.lastAutoApproval.task} ${runtime.lastAutoApproval.method}（${runtime.lastAutoApproval.at}）；本次运行共 ${runtime.autoApprovals} 次`);
    if (runtime.lastTerminalScanAt) console.log(`最近 /tasks 检测：${runtime.terminalTasks} 个终端会话（${runtime.lastTerminalScanAt}）`);
    if (runtime.lastTaskListDelivered) console.log(`Telegram 最近已接收会话列表：消息 ${runtime.lastTaskListDelivered.messageId}（${runtime.lastTaskListDelivered.at}）`);
    console.log(`Telegram 连接：${runtime.telegramConnected ? '已连接' : '未连接'}`);
    console.log(`Telegram 通道：${runtime.telegramTransport === 'curl' ? 'curl 独立连接兜底' : 'Node fetch'}`);
    if (runtime.clashGuard) console.log(`Clash 自动巡检：${runtime.clashGuard.status}；节点：${runtime.clashGuard.node || '未知'}（${runtime.clashGuard.at}）`);
    if (runtime.lastTelegramTransportChange) console.log(`最近通道切换：${runtime.lastTelegramTransportChange.reason}（${runtime.lastTelegramTransportChange.at}）`);
    console.log(`最近 Telegram 通信：${runtime.lastTelegramSuccessAt || '尚无'}`);
    console.log(`最近 Codex 刷新：${runtime.lastCodexSuccessAt || '尚无'}`);
    if (runtime.lastCodexRequestReceived) {
      const request = runtime.lastCodexRequestReceived;
      console.log(`最近 Codex 请求：${request.task} ${request.method}（${request.at}）`);
    }
    if (runtime.lastRequestDeliveredToTelegram) {
      const delivery = runtime.lastRequestDeliveredToTelegram;
      console.log(`Telegram 最近已接收${delivery.interactive === false ? '请求通知（无按钮）' : '请求卡片'}：${delivery.task}，消息 ${delivery.messageId}（${delivery.at}）`);
    }
    if (runtime.lastRequestDeliveryError) {
      const failure = runtime.lastRequestDeliveryError;
      console.log(`最近请求卡片发送错误：${failure.task} ${redact(failure.message)}（${failure.at}）`);
    }
    if (runtime.lastError) console.log(`最近错误：${redact(runtime.lastError.message)}（${runtime.lastError.at}）`);
  } else if (status.running) console.log('健康记录：当前进程尚未生成，更新程序后可查看连接状态。');
  console.log(`日志：${status.logPath}`);
}

try {
  const command = process.argv[2] || 'status';
  if (command === 'status') display(inspectService(root));
  else if (command === 'start') {
    console.log('正在检查并启动桥接程序……');
    const status = await startService(root);
    console.log(status.alreadyRunning ? '已经运行，无需重复启动。' : '已在后台启动，可关闭终端。');
    display(status);
  } else if (command === 'stop') {
    const result = await stopService(root);
    console.log(result.alreadyStopped ? '桥接程序未运行。' : '已停止桥接程序；Codex 任务继续运行。');
  } else if (command === 'restart') {
    await stopService(root);
    console.log('正在重新启动桥接程序……');
    display(await startService(root));
  } else throw new Error('用法：node scripts/service.mjs start|stop|status|restart');
} catch (error) { console.error(redact(error.message, process.env.TELEGRAM_TOKEN)); process.exitCode = 1; }
