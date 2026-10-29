export const BOT_COMMANDS = [
  { command: 'tasks', description: '查看终端中打开的会话，选择好友' },
  { command: 'view', description: '查看当前会话的最近对话' },
  { command: 'pending', description: '查看等待批准或回答的请求' },
  { command: 'autoallow', description: '会话自动允许：/autoallow c1 on 或 off' },
  { command: 'alias', description: '给会话取名，例如 /alias c1 登录' },
  { command: 'help', description: '查看指令与对话用法' },
  { command: 'start', description: '显示机器人使用说明' },
];

export async function registerCommands(telegram, chatId) {
  if (!Number.isSafeInteger(chatId)) throw new Error('未取得已配对的私聊，无法注册指令菜单。');
  await telegram.call('setMyCommands', {
    commands: BOT_COMMANDS,
    scope: { type: 'chat', chat_id: chatId },
    language_code: '',
  });
  await telegram.call('setChatMenuButton', { chat_id: chatId, menu_button: { type: 'commands' } });
}
