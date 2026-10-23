import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

async function resolveSocketPath() {
  const env = { ...process.env };
  delete env.TELEGRAM_TOKEN;
  const { stdout } = await promisify(execFile)('codex', ['app-server', 'daemon', 'version'], { env, timeout: 15000 });
  const daemon = JSON.parse(stdout);
  if (daemon.status !== 'running' || !daemon.socketPath) throw new Error('Codex 共享后台未运行，正在等待后台恢复。');
  return daemon.socketPath;
}

// Use the official daemon's control socket; ws supplies WebSocket framing.
export class CodexRPC extends EventEmitter {
  constructor(options = {}) {
    super();
    this.calls = new Map();
    this.sequence = 0;
    this.closing = false;
    this.connected = false;
    this.connecting = null;
    this.resolveSocketPath = options.resolveSocketPath || resolveSocketPath;
    this.requestTimeoutMs = options.requestTimeoutMs || 20000;
  }

  connect() {
    if (this.closing) return Promise.reject(new Error('桥接连接已关闭。'));
    if (this.connected) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.open().finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  async open() {
    const path = await this.resolveSocketPath();
    if (this.closing) throw new Error('桥接连接已关闭。');
    const socket = new WebSocket(`ws+unix://${path}:/`, { handshakeTimeout: 10000 });
    this.socket = socket;
    socket.on('message', data => {
      if (this.socket !== socket) return;
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      this.receive(message);
    });
    socket.on('error', error => {
      if (this.socket === socket) this.fail(new Error(`无法连接 Codex 本地 socket：${error.code || '握手失败'}`));
    });
    socket.on('close', () => {
      if (this.socket === socket) this.fail(new Error('Codex 后台连接已断开，正在等待自动重连。'));
    });
    try {
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('Codex 连接在握手时断开。')));
      });
      await this.call('initialize', {
        clientInfo: { name: 'codex_friends', title: 'Codex Friends', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      this.write({ method: 'initialized' });
      this.connected = true;
    } catch (error) {
      if (this.socket === socket) this.fail(error);
      throw error;
    }
  }

  receive(message) {
    if (message.method) {
      this.emit(message.id === undefined ? 'notification' : 'request', message);
      return;
    }
    const pending = this.calls.get(message.id);
    if (!pending) return;
    this.calls.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || 'Codex 请求失败'));
    else pending.resolve(message.result);
  }

  write(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex 后台连接不可用。');
    }
    this.socket.send(JSON.stringify(message));
  }

  call(method, params = {}) {
    const id = `friends-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        const error = new Error(`Codex 请求超时：${method}；等待重新连接，不自动重发指令。`);
        reject(error);
        this.fail(error);
      }, this.requestTimeoutMs);
      this.calls.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.calls.delete(id); reject(error); }
    });
  }

  respond(id, result) { this.write({ id, result }); }

  fail(error) {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    for (const { reject, timer } of this.calls.values()) { clearTimeout(timer); reject(error); }
    this.calls.clear();
    socket?.terminate();
    if (!this.closing) this.emit('disconnect', error);
  }

  close() { this.closing = true; this.fail(new Error('桥接连接已关闭。')); }
}
