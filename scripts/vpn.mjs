import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Clash, ClashGuard, clashConfig, resolveNode } from '../src/clash.mjs';
import { readClashSettings, writeLocal } from '../src/clash-watch.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const command = process.argv[2] || 'status';
try {
  const settings = readClashSettings(root);
  const clash = new Clash(settings.configPath || clashConfig);
  const group = settings.group || '🚀节点选择';
  if (command === 'disable') {
    writeLocal(root, 'clash-guard.json', { ...settings, enabled: false });
    console.log('已停用自动切换，保留当前节点。');
  } else if (command === 'status') {
    const proxies = await clash.proxies();
    console.log(JSON.stringify({ enabled: Boolean(settings.enabled), group, selected: proxies[group]?.now,
      node: resolveNode(proxies, group), originalSelection: settings.originalSelection }, null, 2));
    try { console.log(readFileSync(new URL('../.local/clash-status.json', import.meta.url), 'utf8')); } catch {}
  } else if (command === 'enable') {
    const proxies = await clash.proxies();
    if (proxies[group]?.type !== 'Selector') throw new Error('目标组不是可手动选择的 Selector');
    const node = resolveNode(proxies, group);
    if (!/日本|🇯🇵/.test(node)) throw new Error('当前不是日本节点，请先在 Clash 选择日本节点再启用');
    const config = { ...settings, enabled: true, configPath: settings.configPath || clashConfig, group,
      originalSelection: settings.originalSelection || proxies[group].now };
    writeLocal(root, 'clash-guard.json', config);
    console.log(`已启用：每 45 秒检测 ${group} 的日本节点，连续失败两次后自动切换，切换冷却三分钟。`);
    console.log('该组的其他流量也会随节点切换。桥接运行期间自动巡检，无需另开 CLI。');
    await new ClashGuard(clash, { group, report: status => {
      writeLocal(root, 'clash-status.json', { enabled: true, group, ...status, at: new Date().toISOString() });
      console.log(JSON.stringify(status)); return status;
    } }).check();
  } else if (command === 'check') {
    const proxies = await clash.proxies();
    const node = resolveNode(proxies, group);
    const delay = await clash.reachable(node);
    console.log(JSON.stringify({ node, reachable: delay !== null, delay, probe: 'https://api.telegram.org', switchesNodes: false }, null, 2));
  } else if (command === 'restore') {
    if (!settings.originalSelection) throw new Error('没有保存的原选择');
    writeLocal(root, 'clash-guard.json', { ...settings, enabled: false });
    const proxies = await clash.proxies();
    if (proxies[group]?.type !== 'Selector' || !proxies[group].all.includes(settings.originalSelection)) throw new Error('原选择已不在该组中，已停用自动切换');
    await clash.select(group, settings.originalSelection);
    if ((await clash.proxies())[group].now !== settings.originalSelection) throw new Error('未确认恢复成功');
    await clash.closeTelegramConnections(group);
    console.log(`已停用并恢复原选择：${settings.originalSelection}`);
  } else throw new Error('用法：node scripts/vpn.mjs status|check|enable|disable|restore');
} catch (error) { console.error(error.message); process.exitCode = 1; }
