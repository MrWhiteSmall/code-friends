import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Clash, ClashGuard } from './clash.mjs';

export function readClashSettings(root) {
  try { return JSON.parse(readFileSync(join(root, '.local/clash-guard.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { enabled: false }; throw new Error('无法读取 Clash 自动切换设置'); }
}
export function writeLocal(root, filename, value) {
  mkdirSync(join(root, '.local'), { recursive: true, mode: 0o700 });
  const path = join(root, '.local', filename);
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}

export function createClashWatch(root, onStatus = () => {}) {
  let guard, identity, next = 0, checking;
  const report = status => {
    const result = { ...status, at: new Date().toISOString() };
    writeLocal(root, 'clash-status.json', result);
    onStatus(result);
    return result;
  };
  async function run() {
    try {
      const config = readClashSettings(root);
      if (!config.enabled) {
        if (guard) report({ enabled: false, status: 'disabled' });
        guard = null; identity = null; return;
      }
      const key = JSON.stringify([config.group, config.configPath]);
      if (key !== identity) {
        identity = key;
        next = 0;
        guard = new ClashGuard(new Clash(config.configPath), {
          group: config.group,
          report: status => report({ enabled: true, group: config.group, ...status }),
          canSwitch: () => {
            const current = readClashSettings(root);
            return current.enabled && current.group === config.group && current.configPath === config.configPath;
          },
        });
      }
      if (Date.now() < next) return;
      next = Date.now() + 45000;
      await guard.check();
    } catch (error) {
      report({ status: 'error', reason: error.message });
    }
  }
  return { tick() {
    if (!checking) checking = run().finally(() => { checking = null; });
    return checking;
  } };
}
