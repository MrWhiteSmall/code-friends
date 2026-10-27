import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function terminalPids(output) {
  const pids = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!match || ['??', '?', '-'].includes(match[2])) continue;
    if (match[3].split('/').at(-1) === 'codex') pids.push(Number(match[1]));
  }
  return pids;
}

export function listenerPorts(output, allowedPids) {
  const allowed = new Set(allowedPids);
  const ports = new Set();
  let pid;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (!allowed.has(pid)) continue;
    const match = line.match(/^n(?:127\.0\.0\.1|\[::1\]):(\d+)$/);
    if (match) ports.add(Number(match[1]));
  }
  return ports;
}

// Read process identity and listener metadata only, never argv, env or terminal
// contents. A daemon without a controlling TTY is deliberately excluded.
export async function terminalListeners(run = exec) {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,tty=,comm='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  const pids = terminalPids(stdout);
  if (!pids.length) return { ports: new Set(), processes: 0 };
  let output;
  try {
    output = (await run('/usr/sbin/lsof', ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-Fpn'],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch (error) {
    // lsof may return 1 with valid partial output when one PID has no listener.
    if (error.code !== 1) throw new Error('无法确认终端连接状态，请稍后重试 /tasks。');
    output = error.stdout || '';
    if (!output && error.stderr?.trim()) throw new Error('无法读取终端连接状态，请检查本机进程访问权限。');
  }
  // Recheck PIDs after lsof so an exited terminal does not remain visible.
  const latest = await run('/bin/ps', ['-axo', 'pid=,tty=,comm='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  const alive = terminalPids(latest.stdout).filter(pid => pids.includes(pid));
  return { ports: listenerPorts(output, alive), processes: alive.length };
}

export async function terminalThreads(rpc, threads, listeners = terminalListeners) {
  const { ports, processes } = await listeners();
  const visible = [];
  let unconfirmed = 0;
  if (!ports.size) return { threads: visible, processes, unconfirmed };
  for (const thread of threads) {
    let cursor, match = false;
    try {
      do {
        const page = await rpc.call('mcpServerStatus/list', {
          threadId: thread.id, serverName: 'codex_tui', detail: 'toolsAndAuthOnly', limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const server of page.data || []) {
          if (server.name !== 'codex_tui' || !server.httpOrigin) continue;
          const url = new URL(server.httpOrigin);
          if (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && ports.has(Number(url.port))) match = true;
        }
        cursor = page.nextCursor;
      } while (cursor && !match);
    } catch (error) {
      if (!rpc.connected) throw error;
      unconfirmed++;
    }
    if (match) visible.push(thread);
  }
  return { threads: visible, processes, unconfirmed };
}
