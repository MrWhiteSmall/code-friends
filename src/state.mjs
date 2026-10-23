import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export class State {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.path = join(directory, 'state.json');
    try { this.data = JSON.parse(readFileSync(this.path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('本地配对状态损坏；请检查 .local/state.json。');
      this.data = { owner: null, selected: null, replies: {}, offset: 0 };
    }
    this.data.addresses ||= {};
  }
  save() {
    writeFileSync(this.path + '.tmp', JSON.stringify(this.data, null, 2), { mode: 0o600 });
    chmodSync(this.path + '.tmp', 0o600);
    renameSync(this.path + '.tmp', this.path);
  }
  reply(messageId, target) {
    this.data.replies[messageId] = target;
    const keys = Object.keys(this.data.replies);
    for (const key of keys.slice(0, Math.max(0, keys.length - 500))) delete this.data.replies[key];
    this.save();
  }
}
