import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Telegram, redact } from '../src/telegram.mjs';
import { BOT_COMMANDS, registerCommands } from '../src/commands.mjs';

const token = process.env.TELEGRAM_TOKEN;
try {
  if (!token) throw new Error('缺少 TELEGRAM_TOKEN。');
  const state = JSON.parse(readFileSync(fileURLToPath(new URL('../.local/state.json', import.meta.url)), 'utf8'));
  const chatId = state.owner?.chatId;
  if (!Number.isSafeInteger(chatId)) throw new Error('请先完成手机配对。');
  const telegram = new Telegram(token);
  if (!process.argv.includes('--check')) await registerCommands(telegram, chatId);
  const commands = await telegram.call('getMyCommands', { scope: { type: 'chat', chat_id: chatId }, language_code: '' });
  const button = await telegram.call('getChatMenuButton', { chat_id: chatId });
  assert.deepEqual(commands, BOT_COMMANDS, 'Telegram 指令列表与程序不一致。');
  assert.equal(button.type, 'commands', 'Telegram 菜单按钮未设为指令菜单。');
  console.log(JSON.stringify({ commands: commands.map(item => item.command), menuButton: button.type, scope: 'pairedPrivateChat', verified: true }));
} catch (error) {
  console.error(redact(error.message, token));
  process.exitCode = 1;
}
