import { readFileSync, existsSync, mkdirSync, chmodSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`无法读取 ${path}`); }
}

export function inspectService(root) {
  const directory = join(root, '.local');
  const pidPath = join(directory, 'bridge.pid');
  const state = readJSON(join(directory, 'state.json'));
  const runtime = readJSON(join(directory, 'runtime.json'));
  const result = {
    running: false, pid: null, uptime: null, stalePid: existsSync(pidPath),
    paired: Boolean(state?.owner), recordedTasks: Object.keys(state?.addresses || {}).length,
    runtime, logPath: join(directory, 'bridge.log'),
  };
  if (!existsSync(pidPath)) return result;
  let pid;
  try { pid = Number(readFileSync(pidPath, 'utf8').trim()); }
  catch (error) { if (error.code === 'ENOENT') return { ...result, stalePid: false }; throw error; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return result;
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return result;
    throw new Error('没有权限检查桥接进程，请在自己的电脑终端运行此命令。');
  }
  let output;
  try { output = execFileSync('ps', ['-p', String(pid), '-o', 'etime=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    if (error.status === 1) return result;
    throw new Error('无法查询进程身份，请在自己的电脑终端运行此命令。');
  }
  const match = output.trim().match(/^(\S+)\s+([\s\S]+)$/);
  const command = match?.[2] || '';
  if (!/(?:^|\s)(?:\S*\/)?node(?:\s|$)/.test(command) || !command.includes(join(root, 'src', 'main.mjs'))) return result;
  return { ...result, running: true, pid, uptime: match[1], stalePid: false, runtime: runtime?.pid === pid ? runtime : null };
}

function clearStalePid(root, status) {
  if (status.stalePid && !status.running) {
    try { unlinkSync(join(root, '.local', 'bridge.pid')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function startService(root, timeout = 90000) {
  const previous = inspectService(root);
  if (previous.running) return { ...previous, alreadyRunning: true };
  clearStalePid(root, previous);
  const directory = join(root, '.local');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const fd = openSync(join(directory, 'bridge.log'), 'a', 0o600);
  const child = spawn('/bin/zsh', [join(root, 'scripts', 'run.zsh')], { detached: true, stdio: ['ignore', fd, fd] });
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { closeSync(fd); }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = inspectService(root);
    if (status.running && status.runtime?.status === 'running') return status;
    if (child.exitCode !== null || child.signalCode !== null || (!status.running && status.runtime?.pid === child.pid && status.runtime.status === 'failed')) {
      throw new Error(`桥接启动失败，请查看日志：${join(directory, 'bridge.log')}`);
    }
    await pause(250);
  }
  throw new Error(`启动尚未完成，请运行状态命令并查看日志：${join(directory, 'bridge.log')}`);
}

export async function stopService(root, timeout = 10000) {
  const status = inspectService(root);
  if (!status.running) { clearStalePid(root, status); return { alreadyStopped: true }; }
  try { process.kill(status.pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = inspectService(root);
    if (!current.running || current.pid !== status.pid) return { alreadyStopped: false };
    await pause(100);
  }
  throw new Error('桥接进程尚未退出，请查看状态；没有强制终止任何其他进程。');
}
