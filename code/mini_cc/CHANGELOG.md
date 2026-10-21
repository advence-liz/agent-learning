# mini_cc CHANGELOG

每章一次增量。章节正文在 `/Users/liz/liz/agent-learn/p4-mini-cc/`。

## 第 1 章 · 命令系统（01-cli.md）

- 新增 `mini_cc/config.py:Settings`：模型、max_tokens、effort、cwd、home、max_iterations。
- 新增 `mini_cc/model.py`：`ModelRequest` / `ModelResponse`、`ModelClient` 协议、`AnthropicClient.create`（messages.create 薄包装，content 转纯 dict）、`FakeClient`（按脚本回放 + 记录请求）、剧本助手 `say()` / `call()`、`FakeClient.from_json`（`--fake` 离线演示）。
- 新增 `mini_cc/tools/`：`Tool` / `ToolResult` / `ToolContext`、`ToolRegistry`（按注册顺序输出 schema）、`Read` / `Write` / `Bash` 三个朴素工具。
- 新增 `mini_cc/loop.py:Agent.run`：阻塞式 agent 循环，`Usage` 累计 token。
- 新增 `mini_cc/cli.py`：`CommandRegistry`（别名 + difflib 纠错）、`App.handle_line` 唯一入口、命令 `/help` `/new`(`/clear`) `/status` `/model` `/exit`(`/quit`)；REPL（prompt_toolkit，管道输入时逐行回显）；参数 `--model` `-p` `--fake`。
- 新增 `mini_cc/ui.py`：`BufferUI`（测试/纯文本）、`ConsoleUI`（rich）。
- 测试：`tests/test_ch01_commands.py`（8 个）。

## 第 2 章 · 逐步输出（02-realtime-output.md）

- `model.py`：协议改为 `ModelClient.stream(req) -> Iterator[TextDelta | ThinkingDelta | MessageDone]`；新增 `complete()`；`AnthropicClient.stream` 用 `messages.stream()`，请求带 `thinking={"type":"adaptive","display":"summarized"}`，工具带 `eager_input_streaming: True`；`FakeClient` 按 4 字符切片流式回放，支持 `fail_after/fail_with`（为第 3 章准备）、`calls()` 并行调用、剧本里的 `thinking`。
- 新增 `events.py`：`ToolStart` / `ToolEnd` / `Notice` / `TurnEnd`。
- `loop.py`：`Agent.run_turn()` 生成器；拆出 `_call_model()` / `_run_tools()` 两个插槽；`run()` 变成收集事件的便捷封装。
- `ui.py`：`BufferUI.render(event)` 状态机（`●` 文本 / `✻` 思考 / `⏺` 调用 / `✔✘` 返回），`ConsoleUI` 复用同一状态机实时打印。
- `cli.py`：`handle_line` 消费事件流；提示符改为 `❯`。
- `tools/bash.py`：输出整理（去尾部空行、只在非 0 时附 exit code、空输出显示 `(no output)`）。
- 测试：`tests/test_ch02_streaming.py`（6 个）、`tests/sdk_stub.py`（假 SDK，测适配层不联网）。

## 第 3 章 · 错误处理与重试（03-error-handling.md）

- `model.py`：新增 `ModelError(retryable, kind, status, retry_after)` 与 `to_model_error()`（SDK 异常 → ModelError；流迭代器里的 `ValueError` 视为可重试的 `invalid_json`）；`AnthropicClient` 关闭 SDK 自带重试（`max_retries=0`），默认开启服务端 refusal fallback（beta `server-side-fallback-2026-07-01` + `fallbacks="default"`，`MINI_CC_FALLBACKS=0` 关闭）；`FakeClient.from_json` 支持 `{"error": kind}`。
- 新增 `retry.py:RetryPolicy`：指数退避 + 抖动，优先 `retry-after`。
- `loop.py`：`_call_model` 带重试并发 `Notice`；`run_turn` 变为安全网外壳（`ModelError` / 任意异常都转成 `Notice + TurnEnd("error")`），真正循环移入 `_loop()`；处理 `refusal` / `max_tokens`+tool_use（不执行）/ `pause_turn`；`repair_history()` 在 `finally` 中补齐悬空 `tool_use`；`self.sleep` 可注入。
- 新增 `tools/validate.py`：JSON Schema 子集校验。`ToolRegistry.execute` 两道防线（校验 + 异常兜底）、`<tool_use_error>` 包装、输出截断（`Settings.max_tool_output`）。
- `tools/bash.py`：超时返回部分输出 + `[timed out after Ns]`。
- `cli.py`：`handle_line` 捕获 `KeyboardInterrupt`。
- `config.py`：`max_retries` / `retry_base_delay` / `retry_max_delay` / `fallbacks` / `max_tool_output`。
- 测试：`tests/test_ch03_errors.py`（16 个）。

## 第 4 章 · 持久化聊天记录（04-resume.md）

- `loop.py`：历史唯一写入口 `Agent._append(msg, **meta)` + `Agent.listeners`（每条新消息回调）；`load_history()` 恢复历史并 `repair_history()`。
- 新增 `session.py`：`project_slug()`（非字母数字 → `-`，同 Claude Code）、`Session.record()`（每条消息一行，`uuid`/`parentUuid` 串链、assistant 行带 `usage`，首条消息时才建文件）、`SessionStore.load/list/resolve`（容忍半行、序号或 id 前缀）。
- `cli.py`：`App._attach/new_session/resume`；`/new` 保留旧会话；新命令 `/resume`；参数 `-r/--resume`、`-c/--continue`；`/status` 显示 session id。
- 测试：`tests/test_ch04_session.py`（7 个）。

## 第 5 章 · 工具调用权限审批（05-permission.md）

- 新增 `permissions.py`：模式常量（`default` / `acceptEdits` / `auto` / `plan` / `bypassPermissions`）、`Decision` / `PermissionRequest` / `PermissionReply`、`PermissionManager.decide()`（deny 规则 → `extra_checks` 扩展钩子 → bypass → 工具自检 → 只读 → 会话 allow 规则 → acceptEdits 项目内编辑 → auto 审查员 → ask）、`set_mode/next_mode/cycle/on_mode_change`、`denied_message()`（措辞参考 Claude Code）。
- `tools/base.py`：`Tool.read_only / kind / path_arg / self_check() / rule_key()`；`ToolContext.rel()`。`Read` 只读，`Write` 为 edit 类，`Bash` 为 exec 类并实现 `self_check`（只读命令白名单 + `shlex` 拆分管道/`&&`、含重定向与命令替换一律不放行；高危正则一律要问）与按命令的 `rule_key`。
- `tools/registry.py`：拆出 `check_input()`（权限判定前先校验参数）。
- `events.py`：新增 `PermissionDecision`。
- `loop.py`：`Agent.permissions` / `Agent.approver`；`_authorize()` 权限关卡；`_run_tools()` 返回「是否结束本轮」——拒绝且无理由时同批剩余调用标记 Skipped，`TurnEnd("denied")`。
- `ui.py`：`BufferUI.ask()`（测试从 `answers` 取答案）/ `ask_permission()` 三选项弹窗；`ConsoleUI.ask()` 读键盘；渲染 `PermissionDecision`。
- `cli.py`：`/mode` 命令、Shift+Tab 循环切换与底部状态栏、`--permission-mode`；模式变化写入会话（`{"type":"permission-mode"}`）；管道模式改用 `readline()`，与弹窗的 `input()` 共用缓冲。
- `config.py`：`permission_mode`。
- 测试：`tests/test_ch05_permissions.py`（20 个）。

## 第 6 章 · auto 模式（06-auto-mode.md）

- 新增 `auto_mode.py`：`AutoReviewer`（独立请求；只给审查员「用户原话 + 待执行动作 + 项目目录」，不给工具输出与 assistant 文字；`output_config.format` json_schema 取 `{"decision","reason"}`；`effort: low`；fail closed；连续 3 次 block 升级为 ask）、`user_intent()`、`REVIEWER_SYSTEM`、离线用的 `keyword_reviewer_turn`。
- `permissions.py`：Shift+Tab 循环加入 `auto`；auto 模式复用 acceptEdits 的项目内编辑快速通道。
- `model.py`：`FakeClient(responder=...)`，剧本放完后用 responder 一直回答。
- `cli.py`：`App(reviewer_client=...)`，审查员与主对话用不同 client；`--fake` 下用关键词审查员；`/status` 显示审查员调用次数。
- `ui.py`：渲染审查员放行/拦截。
- 测试：`tests/test_ch06_auto_mode.py`（10 个）；`test_ch05_permissions.py::test_mode_cycle` 固定为第 5 章的循环。

## 第 7 章 · 可靠的文件编辑工具（07-file-edit.md）

- 新增 `tools/file_state.py`：`FileStateCache`（路径 → mtime_ns + sha256 + 是否部分读取；`is_stale()` 先比 mtime 再比内容）、`read_text/write_text`（`newline=""` 保留 CRLF）、`guard_write()`（先读后改、读后未变；报错文案与 Claude Code 一致）。
- `tools/read.py`：`cat -n` 风格行号、`offset/limit`、长行截断、目录/二进制拒读、读后登记文件状态。
- `tools/write.py`：已存在文件必须先读且未变；写后登记状态；`ctx.before_write()` 钩子。
- 新增 `tools/edit.py:EditTool`：`old_string` 唯一匹配 / `replace_all` / 拒绝 no-op / 空 `old_string` 新建文件 / CRLF 对齐；找不到时诊断（行号前缀、弯引号、缩进）；成功返回改动附近的带行号片段。
- `tools/base.py`：`ToolContext.file_state`、`ToolContext.write_hooks` + `before_write()`（为第 13 章 rewind 预留）。
- `tools/__init__.py`：默认工具加入 `Edit`。
- 测试：`tests/test_ch07_file_edit.py`（15 个）。
