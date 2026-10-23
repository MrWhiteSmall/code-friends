const normalize = value => String(value).replace(/^@/, '').normalize('NFC').toLowerCase();
const validName = /^[\p{L}\p{N}_-]{1,20}$/u;

export class Addresses {
  constructor(records = {}) {
    this.records = records;
    this.next = Math.max(0, ...Object.values(records).map(x => Number(x.code?.match(/^c(\d+)$/)?.[1]) || 0)) + 1;
  }
  ensure(threadId) {
    if (Object.hasOwn(this.records, threadId)) return false;
    this.records[threadId] = { code: `c${this.next++}`, alias: null };
    return true;
  }
  find(name) {
    const value = normalize(name);
    return Object.entries(this.records).find(([, record]) =>
      record.code === value || (record.alias && normalize(record.alias) === value))?.[0];
  }
  display(threadId) {
    const record = this.records[threadId];
    return record ? (record.alias ? `@${record.alias}（@${record.code}）` : `@${record.code}`) : '';
  }
  rename(name, alias) {
    const id = this.find(name);
    if (!id) throw new Error(`找不到会话 @${normalize(name)}，请 /tasks 查看名字。`);
    const value = normalize(alias);
    if (!validName.test(value) || /^c\d+$/.test(value) || ['all', 'everyone', 'here'].includes(value)) {
      throw new Error('名字须为 1–20 个中文、字母、数字、下划线或短横线；c 加数字和 all 等名称保留。');
    }
    const existing = this.find(value);
    if (existing && existing !== id) throw new Error(`@${value} 已属于另一个会话，请换一个名字。`);
    this.records[id].alias = value;
    return id;
  }
  route(text, liveIds) {
    let remaining = text.trimStart();
    if (!remaining.startsWith('@')) return null;
    const targets = [];
    while (remaining.startsWith('@')) {
      const match = remaining.match(/^@([\p{L}\p{N}_-]+)(?=\s|$)/u);
      if (!match) throw new Error('请用“@会话名 空格 消息”的格式；名字可通过 /tasks 查看。');
      const id = this.find(match[1]);
      if (!id) throw new Error(`找不到会话 @${match[1]}，请 /tasks 查看名字。`);
      if (!liveIds.has(id)) throw new Error(`会话 @${match[1]} 当前未连接，请 /tasks 查看在线会话。`);
      if (!targets.includes(id)) targets.push(id);
      remaining = remaining.slice(match[0].length).trimStart();
    }
    if (!remaining.trim()) throw new Error('请在 @会话名 后面加上要发送的消息。');
    return { targets, text: remaining };
  }
}
