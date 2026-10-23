export function redact(value, token = '') {
  let text = String(value);
  if (token) text = text.split(token).join('[TOKEN]');
  return text.replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '[TOKEN]');
}

export class Telegram {
  constructor(token, fetcher = fetch) { this.token = token; this.fetcher = fetcher; this.sending = Promise.resolve(); }

  async call(method, data = {}) {
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data), signal: AbortSignal.timeout(method === 'getUpdates' ? 45000 : 20000),
      });
      const payload = await response.json();
      if (!payload.ok) {
        const error = new Error(`Telegram ${method}：${payload.description || response.status}`);
        error.retryAfter = payload.parameters?.retry_after;
        error.code = payload.error_code || response.status;
        throw error;
      }
      return payload.result;
    } catch (error) {
      // Fetch timeouts can be DOMExceptions whose message is read-only.
      // Build a fresh Error without the original URL-bearing cause.
      const safe = new Error(redact(error?.message || error, this.token));
      if (typeof error?.code === 'number') safe.code = error.code;
      if (typeof error?.retryAfter === 'number') safe.retryAfter = error.retryAfter;
      throw safe;
    }
  }

  send(chatId, text, extra = {}) {
    const run = async () => {
      const chunks = splitText(redact(text, this.token));
      let last;
      for (let i = 0; i < chunks.length; i++) {
        for (let retry = 0; ; retry++) {
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
