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

## 第 8 章 · 用 @ 引用文件（08-file-mention.md）

- 新增 `attachments.py`：`Attachment(kind, title, text)`、`render()`（`<system-reminder>` 包裹的文本块）、`is_reminder()`。
- 新增 `mentions.py`：`find_mentions()`（排除邮箱、支持引号路径、中文标点截断）、`resolve_mentions()`（文件按 Read 的 `cat -n` 格式附加并**登记 FileState**、目录列一层、非路径原样保留、超 2000 行截断）、`build_user_content()`（附件在前、原话在后）、`list_project_files()`（优先 `git ls-files`）、`fuzzy_score/rank`（子序列模糊匹配）、`FileMentionCompleter`（5 秒缓存）。
- `cli.py`：`handle_line` 解析 @ 并显示「已附加」；REPL 用 `merge_completers` 合并命令补全与文件补全。
- 测试：`tests/test_ch08_mentions.py`（9 个）。

## 第 9 章 · 更灵活的上下文注入机制（09-context-injection.md）

- 新增 `context.py`：
  - `STATIC_PROMPT`（身份、工作规则、`<system-reminder>` 语义说明）+ `environment_text()`（cwd、是否 git、平台、shell、模型）组成 system；`ContextBuilder.system_blocks()` 会话内只算一次，最后一块带 `cache_control`；`system_sections` 扩展点。
  - 提供者（provider）机制：`InjectState(agent, trigger)`，`trigger` 为 `user` / `tool_result`；提供者扫描历史判断是否需要注入（不维护标志位，`/resume`、压缩后依然正确）。
  - 内置提供者：`instructions_provider`（`~/.mini_cc` 与项目根 → cwd 的 `AGENTS.md`/`CLAUDE.md` + 会话开始时的 git 快照，每会话一次）、`date_provider`（首轮注入日期、日期变化时提醒）、`changed_files_provider`（读过的文件被外部修改 → 注入 unified diff 并按新内容登记）、`notifications_provider`（第 16–18 章的后台通知通道）。
  - `ContextBuilder.inject()`：用户发话时注入块放最前，工具结果时放在 `tool_result` 之后；单个提供者异常被跳过。
- `loop.py`：`Agent.context`、`Agent.notify()`（线程安全队列）/`drain_notifications()`、`_append_user()`（追加 user 消息并产出 `ContextInjected`）；`run_turn` 与 `_run_tools` 都经由它写 user 消息；请求带 `cache=True`。
- `model.py`：`ModelRequest.cache` → 顶层 `cache_control={"type":"ephemeral"}`。
- `tools/file_state.py`：`FileRecord.text` 保存模型看到的版本（≤20 万字符），用于算 diff。
- `events.py` / `ui.py`：`ContextInjected`，显示为 `◇ system …`。
- `cli.py`：新命令 `/context`。
- 测试：`tests/test_ch09_context.py`（12 个）；`conftest.without_session_context()`，早期章节的 4 个测试改为忽略会话级注入。

## 第 10 章 · 让 Agent 主动向你提问（10-ask-user-question.md）

- 新增 `tools/ask_user.py`：`AskUserQuestionTool`（1–4 个问题、每题 2–4 个选项、`multiSelect`；只读、免审批；通过 `ctx.extras["ask_user"]` 回调拿答案；结果措辞参考 Claude Code「Your questions have been answered: … You can now continue …」；全部跳过返回 declined；无 UI 时让模型按默认值继续并声明假设）、`Question` / `Answer`、`parse_answer()`（序号 / 逗号多选 / 中文逗号 / 自由文本 = Other / 空 = 跳过 / 无效返回 None）、`render_question()`。
- `ui.py`：`BufferUI.ask_questions()`（逐题显示，无效输入重问一次）。
- `tools/__init__.py`：默认工具加入 `AskUserQuestion`。
- `cli.py`：把 `ui.ask_questions` 接到 `agent.ctx.extras["ask_user"]`。
- `context.py`：`STATIC_PROMPT` 增加「何时提问」一条。
- 测试：`tests/test_ch10_ask_user.py`（8 个）。

## 第 11 章 · 让 Agent 跟踪多步任务（11-task-management.md）

- 新增 `tasks.py`：`Task` / `TaskStore`（每会话一个 `<session>.tasks.json`，先写临时文件再 `replace`；`create/update/unfinished/render`，☐◼☒ 清单）、`task_reminder_provider()`（清单未完成且模型连续 6 次请求没碰清单，或历史里看不到清单时注入提醒；扫描历史推导，不记标志位）。
- 新增 `tools/task_tools.py`：`TaskCreate` / `TaskUpdate` / `TaskList`（只读免审批；`in_progress` 重复时提示；剩余数 / All tasks completed）。
- `tools/base.py`：`ToolContext.pending_events` + `emit()`——工具执行期间产生的事件由循环在 `ToolEnd` 后转发（后续章节的后台任务也可复用）。
- `events.py`：`TasksUpdated`。`loop.py`：一批工具调用里多次改清单只在批末转发一次。`ui.py`：画清单，Task 工具的结果行不重复显示。
- `session.py`：`Session.tasks_path`。`cli.py`：`_attach` 时按会话载入清单（`/new` 新清单、`/resume` 旧清单）；新命令 `/todos`（`/tasks` 留给第 16 章后台任务）。
- `context.py`：默认 provider 加入任务提醒；`STATIC_PROMPT` 增加「3 步以上先建清单」。
- 测试：`tests/test_ch11_tasks.py`（8 个）。
- 收尾（为第 12–21 章预留）：`loop.py` 新增生命周期钩子 `Agent.before_request`（每次请求模型前）与 `Agent.turn_end`（一轮结束时），循环拆为 `_loop()`（调 turn_end 钩子）+ `_steps()`；新增 `tests/test_extension_points.py`（3 个）验证 `before_request` / `turn_end` / `listeners` / `write_hooks` / `system_sections` / `extra_checks` / 运行时注册工具。扩展点清单见 `ARCHITECTURE.md`。

## 第 12 章 · 长期记忆（12-memory.md）

- 新增 `memory.py`：`MemoryStore`（`<home>/projects/<仓库根 slug>/memory/`，`MEMORY.md` 索引 + 每条记忆一个带 frontmatter 的 markdown；`save()` 同 slug 原地更新索引行、`delete()`、`entries()`；`load_index()` 截到 200 行 / 25KB 并明说截断；接近上限 90% 时保存结果里提醒精简）、`slugify()`（ASCII 可读 + 非 ASCII 补稳定哈希）、`system_section()`（记忆指引 + 索引，挂 `ContextBuilder.system_sections`）。
- 新增 `tools/memory_tool.py:MemoryTool`（`save` / `delete`，`self_check` 返回 allow 免审批）；默认工具加入 `Memory`。
- `cli.py`：`App.memory`、`ctx.extras["memory"]`；`_attach()` 换会话时 `context.invalidate()`（新记忆在下个会话进 system，同一会话 system 不变）；新命令 `/memory`（`/memory rm <slug>`）。
- 测试：`tests/test_ch12_memory.py`（8 个）；`test_ch09_context.py` 的 system 断言改为按标题查找 `# Environment` 段。

## 第 13 章 · rewind 回退对话和代码（13-rewind.md）

- 新增 `rewind.py`：`Checkpoint(uuid, prompt, files)`、`FileHistory`（`<home>/file-history/<session>/index.json` + `<路径哈希>@v<n>` 备份；`begin()` 开检查点；`before_write()` 每个检查点每个文件只备份一次、新建文件记 `None`；`restore()` 取目标检查点之后第一次的备份；`truncate()`）、`is_prompt()` / `prompt_text()`。
- `session.py`：`branch()` 从最新叶子沿 `parentUuid` 回走（`load` / `list` 都改用它）；`Session.chain`（与 `Agent.messages` 对齐）；`Session.rewind(keep)` 追加 `{"type": "rewind", "leafUuid"}` 记录。
- `cli.py`：`App._on_message`（listener，排在落盘之后）开检查点；`write_hooks` 接 `FileHistory`；`App.rewind(n, mode)`（both / conversation / code；回退对话时清空文件状态表、原话放进 `App.prefill`，REPL 用作输入框默认值）；`App.checkpoints()`；新命令 `/rewind`（别名 `/checkpoint` `/undo`）。
- `tools/file_state.py`：`FileStateCache.clear()`。
- `ARCHITECTURE.md`：不变量 1 补充「分支点」说明（`load_history` 只用于 resume / rewind / compact）。
- 测试：`tests/test_ch13_rewind.py`（8 个）。
