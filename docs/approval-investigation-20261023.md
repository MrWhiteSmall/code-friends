# Codex 命令确认与 REA 工具授权的差异

检查日期：2026-10-23。项目目录：`/Users/lsj/codex-friends`，位于本次会话的当前目录 `/Users/lsj` 下。

## 结论

这是 Codex 中两类不同操作的确认界面，可以在同一版本、同一会话中同时出现。不能根据按钮文字判断窗口是否仍在运行旧版本，也不能把所有 Allow 界面都归为文件或网络权限申请。

| 操作 | 实机显示 | 后台请求 | 回复格式 |
| --- | --- | --- | --- |
| 执行需要确认的 shell 命令 | `Yes, proceed` 等 | `item/commandExecution/requestApproval` | `{decision:"accept"}` 等 |
| 调用需要授权的 REA MCP 工具 | `Allow`、`Allow for this session`、`Always allow`、`Cancel` | 当前配置下为 `mcpServer/elicitation/request` | `{action:"accept",content:…, _meta:…}`；会话记忆由 MCP 审批元数据表达 |
| 显式申请文件或网络访问权限 | 另一类权限确认 | `item/permissions/requestApproval` | `{permissions:…,scope:"turn"或"session"}` |

`Allow` 允许当前工具调用；`Allow for this session` 记住该工具在当前会话中的授权；`Always allow` 会持久保存工具授权。不是给整个 Codex 的所有命令永久放行。实际范围还受工具、服务器、连接和审批模式约束。

## 实机证据

1. PATH 中的 CLI 是 **0.163.0**；共享 app-server 已是 **0.164.0**。运行中的后台路径位于 `~/.codex/packages/app-server-daemon/releases/0.164.0-aarch64-apple-darwin/`。
2. 从本机 **0.162.1** 和 **0.164.0** 可执行文件分别导出实验版 TypeScript 协议。`ServerRequest`、命令审批 decision、权限审批参数/响应和 scope 类型一致。两版 `tool_call_mcp_elicitation` 均为 stable、默认 true。对比范围是审批相关声明，不代表全部协议或实现没有变化。
3. 两版官方对应 tag 的 `core/src/mcp_tool_call.rs` 均已定义 `Allow`、`Allow for this session`。二进制中 0.158.0 也能找到这两组文案；字符串存在本身不能证明当时的运行路径。
4. @c2 和 REA 的 @c26 当前记录均为 `on-request`、`workspace-write`、受限网络。会话创建时的元数据分别记录 CLI 0.158.0、0.162.1；这是历史创建信息，不是当前后台版本。
5. 在独立 **0.164.0** Codex 测试会话中复现两套界面，测试会话 ID：`01a167e5-d321-7803-878d-278896a697fa`。命令探针是 `/usr/bin/printf CODEX_APPROVAL_PROBE`；MCP 探针是 REA `capture_process_scenario` 包装 `/usr/bin/printf REA_APPROVAL_PROBE`。终端摘录保存在 `.local/approval-investigation/terminal-probe.txt`。
6. 初次 MCP 打印探针因已有持久工具授权直接运行并退出 0；第二次只在测试进程内覆盖 `mcp_servers.rea.tools.capture_process_scenario.approval_mode="auto"`，成功显示 `Allow / Allow for this session / Always allow / Cancel`，随后取消。没有选择会话授权或永久授权，没有调整全局配置。恢复后的首次调用因工具暂不可用而失败，重新发现工具后完成复现。

REA 工具是否要求确认取决于其 read-only/destructive/open-world 注解和配置的 `approval_mode`。因此一个会话主要执行 shell，另一个会话调用 REA，所见按钮会不同；此前记住的工具授权也会使部分弹窗消失。

## 对 Telegram 桥接的影响

检查时，桥接已支持命令审批、文件审批、权限审批和 `item/tool/requestUserInput`，但尚未实现 `mcpServer/elicitation/request` 的表单/审批响应。其兜底分支只发送“需要在电脑上处理：mcpServer/elicitation/request”，没有授权按钮。

日志中的直接证据（均为北京时间）：

- **14:50:19.660** 收到 @c26 的 `mcpServer/elicitation/request`；14:50:20.432 Telegram 接收消息 **4736**。
- **15:07:14.892** 再次收到 @c26 的相同请求类型；15:07:15.664 Telegram 接收消息 **4754**。

这里“Telegram 已接收请求卡片”的日志只证明 `sendMessage` 成功，包含了没有按钮的兜底通知，不能据此认定手机端已经可以完成该审批。

### 修复补记

随后已在 `src/mcp-approval.mjs` 实现带 `_meta.codex_approval_kind="mcp_tool_call"` 的空表单授权：显示服务、工具和原始参数，支持允许本次、服务器明确提供的会话授权、拒绝和取消。响应使用 `action/content/_meta`；会话授权只发送 `{persist:"session"}`，不回传请求中提供的永久授权元数据。通用表单、URL 登录和用户验证仍在电脑端处理。

日志现在区分带按钮的交互请求卡片与无按钮的请求通知。Telegram 按钮回调的界面确认超时，不再阻止仍然有效的审批提交。新增完整进程测试验证：卡片发送前不自动批准，点击后返回正确协议，重复点击不会重复提交。

## 文件和复查

- `scripts/inspect-approvals.mjs`：重订阅已存在的会话，读取等待请求的类型与参数结构，不回答审批、不发起任务。
- `scripts/compare-approval-schemas.mjs`：从已安装的确切本机版本导出并筛选审批相关协议，不安装或更新 Codex。
- `.local/approval-investigation/live.json`：现场会话快照；会话可能继续变化，不代表以后仍在等待。
- `.local/approval-investigation/schema-0.162.1.json`、`schema-0.164.0.json`：协议导出结果。
- `.local/approval-investigation/mcp_tool_call-0.162.1.rs`、`mcp_tool_call-0.164.0.rs`：对应 tag 的官方源文件副本。
- REA 受控进程捕获 Evidence：`ev_b285355753c3efae380b14a245ef2da61d32ae7601a908a11538496c5eb43b19`，执行本项目协议比较脚本；该记录未观察文件系统变更，只用于证明脚本执行，导出文件另行读取核对。

## 官方来源

- [OpenAI app-server 文档：审批与 MCP elicitation](https://developers.openai.com/codex/app-server/)
- [0.164.0 MCP 工具审批实现](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/mcp_tool_call.rs)
- [0.162.1 MCP 工具审批实现](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/mcp_tool_call.rs)
