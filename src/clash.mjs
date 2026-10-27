import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const clashConfig = join(homedir(), 'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml');
// --use-env-proxy also changes Node's global HTTP agent. Explicitly bypass it
// for the controller so recovery still works when the proxy itself is broken.
const directAgent = new Agent({ proxyEnv: {}, keepAlive: false });

// Read only the two scalar settings we need; reject unsupported YAML rather
// than parse or expose the subscription, proxy credentials or full config.
function scalar(text, name) {
  const value = text.match(new RegExp(`^${name}:\\s*([^\\r\\n]*)`, 'm'))?.[1]?.trim();
  if (!value) return '';
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error('Clash 控制配置格式不支持');
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/[#\[\]{}>|]/.test(value)) throw new Error('Clash 控制配置格式不支持');
  return value;
}

export class Clash {
  constructor(path = clashConfig) { this.path = path; }
  call(path, method = 'GET', body) {
    const config = readFileSync(this.path, 'utf8');
    const endpoint = new URL('http://' + scalar(config, 'external-controller'));
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password) {
      throw new Error('Clash 控制接口必须绑定本机回环地址');
    }
    const secret = scalar(config, 'secret');
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = request(new URL(path, endpoint), {
        method, agent: directAgent, signal: AbortSignal.timeout(9000),
        headers: { Authorization: `Bearer ${secret}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
      }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; if (text.length > 8 * 1024 * 1024) req.destroy(); });
        res.on('error', () => reject(new Error('Clash 控制响应中断')));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Clash 控制接口 HTTP ${res.statusCode}`));
          try { resolve(text ? JSON.parse(text) : null); }
          catch { reject(new Error('Clash 控制响应不是 JSON')); }
        });
      });
      req.on('error', () => reject(new Error('Clash 本机控制接口不可用或超时')));
      req.end(data);
    });
  }
  async proxies() { return (await this.call('/proxies')).proxies; }
  async mode() { return (await this.call('/configs')).mode; }
  async reachable(name) {
    try {
      const result = await this.call(`/proxies/${encodeURIComponent(name)}/delay?` + new URLSearchParams({ url: 'https://api.telegram.org', timeout: '5000' }));
      return Number.isFinite(result.delay) && result.delay > 0 ? result.delay : null;
    } catch { return null; }
  }
  select(group, name) { return this.call(`/proxies/${encodeURIComponent(group)}`, 'PUT', { name }); }
  async closeTelegramConnections(group) {
    const snapshot = await this.call('/connections');
    let closed = 0;
    for (const connection of snapshot.connections || []) {
      const host = connection.metadata?.host?.toLowerCase() || '';
      const telegram = host === 'telegram.org' || host.endsWith('.telegram.org') || host === 'cdn-telegram.org' || host.endsWith('.cdn-telegram.org');
      if (telegram && connection.chains?.includes(group)) {
        await this.call(`/connections/${encodeURIComponent(connection.id)}`, 'DELETE');
        closed++;
      }
    }
    return closed;
  }
}

export function resolveNode(proxies, name) {
  const seen = new Set();
  while (proxies[name]?.all) {
    if (seen.has(name)) throw new Error('Clash 节点组存在循环');
    seen.add(name);
    name = proxies[name].now;
  }
  if (!isNode(proxies[name])) throw new Error('当前选择不是代理节点');
  return name;
}

const japanese = name => /日本|🇯🇵/.test(name);
const isNode = proxy => proxy && !proxy.all && !['Direct', 'Reject', 'RejectDrop', 'Pass'].includes(proxy.type);
export class ClashGuard {
  constructor(clash, { group = '🚀节点选择', now = Date.now, report = () => {}, cooldown = 180000, canSwitch = () => true } = {}) {
    Object.assign(this, { clash, group, now, report, cooldown, canSwitch });
    this.failures = 0;
    this.lastSwitch = -Infinity;
    this.checkedSelection = null;
  }
  check() {
    if (!this.checking) this.checking = this.run().finally(() => { this.checking = null; });
    return this.checking;
  }
  async run() {
    if (await this.clash.mode() !== 'rule') {
      this.failures = 0;
      return this.report({ status: 'paused', reason: '当前不是规则模式，保留用户模式选择' });
    }
    const proxies = await this.clash.proxies();
    const group = proxies[this.group];
    if (group?.type !== 'Selector') throw new Error('自动切换要求指定组是 Selector');
    const node = resolveNode(proxies, this.group);
    if (!japanese(node)) {
      this.failures = 0;
      return this.report({ status: 'paused', node, reason: '当前不是日本节点，保留用户选择' });
    }
    // Native URLTest groups may rotate through several broken nodes. Count
    // consecutive failures across those rotations; reset for a manual choice.
    if (group.now !== this.checkedSelection) { this.failures = 0; this.checkedSelection = group.now; }
    const delay = await this.clash.reachable(node);
    if (delay !== null) {
      this.failures = 0;
      return this.report({ status: 'healthy', node, delay });
    }
    this.failures++;
    if (this.failures < 2 || this.now() - this.lastSwitch < this.cooldown) {
      return this.report({ status: 'retrying', node, failures: this.failures });
    }
    // Test concrete Japanese nodes already offered by the controlled Selector.
    const candidates = group.all.filter(name => name !== node && japanese(name) && isNode(proxies[name]));
    let best;
    for (let index = 0; index < candidates.length && !best; index += 3) {
      const batch = await Promise.all(candidates.slice(index, index + 3).map(async name => ({ name, delay: await this.clash.reachable(name) })));
      best = batch.filter(x => x.delay !== null).sort((a, b) => a.delay - b.delay)[0];
    }
    if (!best) return this.report({ status: 'unavailable', node, reason: '没有探测到可用日本节点，保留原选择' });
    const fresh = await this.clash.proxies();
    // Respect manual choices made during probes. If native URLTest recovered
    // meanwhile, keep its now-healthy choice as well.
    if (await this.clash.mode() !== 'rule' || fresh[this.group]?.now !== group.now) {
      this.failures = 0;
      return this.report({ status: 'changed', reason: '检测期间节点已变化，本次不覆盖' });
    }
    const latest = resolveNode(fresh, this.group);
    if (latest !== node) {
      const latestDelay = await this.clash.reachable(latest);
      if (latestDelay !== null) {
        this.failures = 0;
        return this.report({ status: 'healthy', node: latest, delay: latestDelay });
      }
      if ((await this.clash.proxies())[this.group]?.now !== group.now) return this.report({ status: 'changed', reason: '检测期间选择已变化' });
    }
    if (!this.canSwitch()) return this.report({ status: 'disabled', reason: '检测期间已停用自动切换' });
    await this.clash.select(this.group, best.name);
    this.lastSwitch = this.now();
    this.failures = 0;
    const selected = await this.clash.proxies();
    if (selected[this.group]?.now !== best.name) throw new Error('Clash 未确认节点切换');
    let closed = 0, cleanupError;
    try { closed = await this.clash.closeTelegramConnections(this.group); }
    catch { cleanupError = '旧 Telegram 连接清理失败，等待连接自行重建'; }
    return this.report({ status: 'switched', from: node, node: best.name, delay: best.delay, closed, ...(cleanupError ? { cleanupError } : {}) });
  }
}
