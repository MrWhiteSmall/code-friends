import { curlFetch } from './telegram-curl.mjs';

export function redact(value, token = '') {
  let text = String(value);
  if (token) text = text.split(token).join('[TOKEN]');
  return text.replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '[TOKEN]');
}

export class Telegram {
  constructor(token, fetcher = fetch, { fallback = curlFetch, now = Date.now, onTransport = () => {} } = {}) {
    Object.assign(this, { token, fetcher, fallback, now, onTransport });
    this.sending = Promise.resolve();
    this.transport = 'fetch';
    this.failures = { poll: 0, api: 0 };
    this.probeAt = 0;
    this.probing = false;
  }

  useFallback(method) {
    this.probeAt = this.now() + 5 * 60 * 1000;
    if (this.transport === 'curl') return;
    this.transport = 'curl';
    this.onTransport({ transport: 'curl', reason: `${method} 连续网络错误，启用独立连接兜底` });
  }

  async call(method, data = {}) {
    const lane = method === 'getUpdates' ? 'poll' : 'api';
    const probe = this.transport === 'curl' && lane === 'poll' && this.now() >= this.probeAt && !this.probing;
    const transport = this.transport === 'fetch' || probe ? 'fetch' : 'curl';
    if (probe) this.probing = true;
    try {
      const fetcher = transport === 'curl' ? this.fallback : this.fetcher;
      const response = await fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data), signal: AbortSignal.timeout(
          ['answerCallbackQuery', 'editMessageReplyMarkup'].includes(method) ? 3000 : 20000),
      });
      const payload = await response.json();
      if (!payload.ok) {
        const error = new Error(`Telegram ${method}：${payload.description || response.status}`);
        error.retryAfter = payload.parameters?.retry_after;
        error.code = payload.error_code || response.status;
        error.telegramApi = true;
        throw error;
      }
      if (transport === 'fetch') this.failures[lane] = 0;
      if (probe) {
        this.transport = 'fetch';
        this.failures = { poll: 0, api: 0 };
        this.onTransport({ transport: 'fetch', reason: '正常轮询已恢复，退出独立连接兜底' });
      }
      return payload.result;
    } catch (error) {
      // DOMException timeouts also have numeric .code (23); they are not API 4xx.
      const transient = !error?.telegramApi || error.code >= 500;
      if (transient && transport === 'fetch' && (probe || ++this.failures[lane] >= 2)) this.useFallback(method);
      // Fetch timeouts can be DOMExceptions whose message is read-only.
      // Build a fresh Error without the original URL-bearing cause.
      const safe = new Error(redact(error?.message || error, this.token));
      if (error?.telegramApi && typeof error?.code === 'number') safe.code = error.code;
      if (typeof error?.retryAfter === 'number') safe.retryAfter = error.retryAfter;
      safe.method = method;
      safe.transport = transport;
      throw safe;
    } finally { if (probe) this.probing = false; }
  }

  send(chatId, text, extra = {}, current = () => true) {
    const run = async () => {
      const chunks = splitText(redact(text, this.token));
      let last;
      for (let i = 0; i < chunks.length; i++) {
        for (let retry = 0; ; retry++) {
          // A request may resolve while it waits behind another send or a 429.
          if (!current()) return;
          try {
            last = await this.call('sendMessage', {
              chat_id: chatId, text: chunks[i],
              ...(i === chunks.length - 1 ? extra : {}),
            });
            break;
          } catch (error) {
            if (!error.retryAfter || retry >= 2) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.min(error.retryAfter, 50) * 1000));
          }
        }
      }
      return last;
    };
    const pending = this.sending.then(run, run);
    this.sending = pending.catch(() => {});
    return pending;
  }
}

export function splitText(text, size = 3500) {
  const parts = [];
  let part = '';
  for (const character of (text || '（暂无内容）')) {
    if (part.length + character.length > size) { parts.push(part); part = ''; }
    part += character;
  }
  if (part) parts.push(part);
  return parts;
}
