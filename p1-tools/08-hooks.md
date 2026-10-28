# 用 Hooks 给 Claude Code 加规矩

> 对应原站：[用 Hooks 给 Claude Code 加规矩](https://labuladong.online/zh/ai-coding/claude-code/hooks/)（会员内容；本章为独立原创重写）

> **一句话结论**：hook 是 Claude Code 在主循环固定节点上 fork 出来的子进程。stdin 收一份 JSON，靠 exit code、stdout、stderr 三个通道回话，模型完全不参与。规矩写在 CLAUDE.md 里，模型可能照办也可能不照办；写成 hook，每次都会执行。

## 写进 CLAUDE.md 的规矩，为什么会被忘

你的 `~/.claude/CLAUDE.md` 里早就写了「代码变更走独立 worktree」。可你一定见过这种场面：Claude 先 `git worktree add` 建好 worktree，然后每条命令都 `cd` 进去干活。statusline 上显示的一直是主工作区的分支，你根本看不出它到底在哪条分支上改代码。

后来你写了 `enforce-worktree.py`，挂在 `PreToolUse(Bash)` 上，这个问题就再没出现过。

你可能会问：同一条规则，为什么写成文字就不管用，写成脚本就管用？

原因要从 LLM 的本质说起。CLAUDE.md 只是上下文里的一段 token，它会影响下一个 token 的概率，但改不了这个概率本身是个概率。对话一长，这段规则离当前位置越来越远，还要和几万 token 的工具输出抢注意力，被「忘掉」很正常。

hook 根本不进这场概率游戏。到了指定节点，执行它的是 Claude Code 这个程序（harness），模型想不想、记不记得都无关。

打个比方：CLAUDE.md 是贴在工位上的「离开请锁屏」，hook 是公司 IT 推下来的「5 分钟无操作自动锁屏」策略。前者靠自觉，后者靠系统。这个比方也有不成立的地方：IT 策略管不了你屏幕上在写什么，hook 也一样，它只能在固定的几个时机插手，管不到模型每一句话怎么说。

## 事件：主循环上的几个挂载点

先看 hook 挂在循环的哪些位置。下图只画了日常最常用的几个事件。官方 hooks 文档（Claude Code 2.1.306）一共列了 33 个事件，你的 `settings.json` 配了其中 10 个。

```d2
shape: sequence_diagram
u: 用户
h: "Claude Code (harness)"
k: "hook 子进程"
m: "模型 API"
h -> k: "SessionStart（stdout 纯文本 → 进上下文）"
u -> h: "输入 prompt"
h -> k: "UserPromptSubmit（exit 2 → 这条 prompt 被拦下）"
"loop：每一次工具调用": {
  h -> m: "messages + tools"
  m -> h: tool_use {style.stroke-dash: 3}
  h -> k: "PreToolUse（deny / ask / allow / 改写参数）"
  h -> h: "权限检查（必要时弹 PermissionRequest）"
  h -> h: 执行工具
  h -> k: "PostToolUse（工具已经跑完，只能补充反馈）"
}
m -> h: "end_turn（模型想停）" {style.stroke-dash: 3}
h -> k: "Stop（decision:block → 把 reason 喂回去，接着干）"
h -> k: SessionEnd
```

图里最该记住的是第 5 步和第 8 步的区别。PreToolUse 发生在工具执行**之前**，它能拦、能改参数。PostToolUse 发生在**之后**，木已成舟，最多只能告诉模型「刚才那一步有问题」。

Stop 的位置也很特别：模型已经说完了，按理这一轮该结束了，Stop hook 在这里还能把它拽回来继续干。下一章 [/goal](09-goal-command.md) 整个就是在这个点上做文章。

## 输入：stdin 里的那份 JSON

每个 hook 被调用时，Claude Code 往它的 stdin 写一个 JSON 对象。所有事件都有几个公共字段（官方 hooks 文档）：

| 字段 | 含义 |
|---|---|
| `session_id` / `transcript_path` | 当前会话 ID、对话 jsonl 路径（文档注明它可能落后于内存里的对话） |
| `cwd` | hook 被调用时的工作目录 |
| `hook_event_name` | 哪个事件触发的 |
| `permission_mode` | `default` / `plan` / `acceptEdits` / `auto` / `dontAsk` / `bypassPermissions` |
| `agent_id` / `agent_type` | 在子 agent 里触发时才有 |

再往上叠各事件自己的字段。PreToolUse 带 `tool_name`、`tool_input`、`tool_use_id`；Stop 带 `stop_hook_active`，后面讲死循环时会用到它。

你的 `inject-guardrails.sh` 就是靠这套输入干活的：它从 stdin 读出 `cwd`，再用 git origin 推出「这是哪个仓库」。

## 输出：三个通道各管一件事

hook 回话只有三个通道：退出码、stdout、stderr。规则很简单，但每条都容易踩坑。

**退出码 0**：成功。如果 stdout 是一个完整的 JSON 对象，就按 JSON 协议解析；如果不是，就当纯文本处理。

**退出码 2**：阻断。stderr 的内容就是阻断理由。文档特别强调，exit 2 时 stdout 里的 JSON 会被忽略，JSON 也推翻不了这次阻断。

**其它退出码（包括 1）**：非阻断错误，动作照常执行。文档专门警告过：想用 hook 执行策略，必须 `exit 2`。写了 `sys.exit(1)` 以为能拦住，其实什么都没拦。

至于 exit 2 到底「阻断」了什么，要看具体事件：

| 事件 | exit 2 的效果 |
|---|---|
| `PreToolUse` | 这次工具调用不执行 |
| `UserPromptSubmit` | 这条 prompt 被拦下 |
| `Stop` / `SubagentStop` | 不许停，对话继续 |
| `PostToolUse` | stderr 给模型看，但工具已经执行过了 |
| `SessionStart` / `SessionEnd` | stderr 只给用户看 |
| `PermissionRequest` | 不认 exit 2，要用 JSON 里的 `decision` 对象 |
| `Notification` | 退出码和 stderr 都被忽略 |

想表达的意思比「拦 / 不拦」更细时，就用 exit 0 + JSON。常用字段分两层：

- **顶层通用字段**：`continue: false` 会让整个 Claude 停下来，优先级最高；`stopReason` 是停下时给用户看的话；`systemMessage` 是给用户的警告。还有 `decision: "block"` + `reason`，Stop、PostToolUse、UserPromptSubmit 等事件用它。
- **`hookSpecificOutput`**：必须带 `hookEventName`。PreToolUse 在这里放 `permissionDecision`（`allow` / `deny` / `ask` / `defer`）、`permissionDecisionReason` 和 `updatedInput`（直接替换工具参数）。SessionStart、Stop 等事件在这里放 `additionalContext`。

`additionalContext` 进上下文时会被包成一条 system reminder，模型在下一次请求时看到。超过 10,000 字符的部分会被写成文件，模型只拿到路径和 2,000 字符的预览。

还有一个特例：SessionStart 和 UserPromptSubmit 的**纯文本 stdout** 也会直接进上下文；其它事件的纯文本 stdout 只写进 debug log。

说穿了，hook 对主循环的影响，就是 harness 在循环里预留了几个 `if`：

=== "Node"

    ```ts
    const verdict = runHooks("PreToolUse", payload);   // 子进程 + stdin JSON
    if (verdict.blocked) {
      messages.push(toolResult({ error: verdict.reason }));  // 模型看到理由，自己换路
      continue;
    }
    if (verdict.updatedInput) toolInput = verdict.updatedInput;
    ```

=== "Python"

    ```python
    verdict = run_hooks("PreToolUse", payload)   # 子进程 + stdin JSON
    if verdict.blocked:
        messages.append(tool_result(error=verdict.reason))  # 模型看到理由，自己换路
        continue
    if verdict.updated_input:
        tool_input = verdict.updated_input
    ```

这段代码就是本章「动手」部分 `hook_runner.ts`（Python 版 `hook_runner.py`）的核心。

**回到主线**：LLM 是一个按概率预测下一个 token 的模型，上下文里的规则只能「影响」它，不能「保证」它。hook 把一部分规则从上下文里搬到了上下文之外的确定性代码中。这样既省掉了常驻 token，也换来了概率给不了的可靠性。

## 先跑起来：用 echo 伪造一次工具调用

测 hook 不需要启动 Claude Code。它就是一个读 stdin、写 stdout 的普通程序，用 echo 造一份 JSON 喂进去就能测。

演示代码在 [`code/agent-node/hooks_demo/`](../code/agent-node/hooks_demo/guard_bash.ts) 下（Python 版在 [`code/agent/hooks_demo/`](../code/agent/hooks_demo/guard_bash.py)，文件名相同，扩展名是 `.py`）：

- `guard_bash.ts`：PreToolUse 守卫，故意把四种拦法都演示一遍。
- `stop_gate.ts`：Stop 守卫，「没看到 passed 不许停」（Node 版同时认 `node --test` 的 `ℹ pass N`）。
- `hook_runner.ts`：迷你调度器，模拟 harness 怎么按 matcher 选 hook、怎么解读三个通道。
- `run_demo.sh`：用 echo 构造 stdin，把上面几个脚本挨个跑一遍（Node 版用 `node hooks_demo/guard_bash.ts` 这样的命令调 hook 脚本）。

先看效果（真实输出）：

=== "Node"

    ```text
    $ cd code/agent-node && bash hooks_demo/run_demo.sh
    ### PreToolUse: ls -la
    exit=0

    ### PreToolUse: rm -rf /
    exit=2
    stderr=拒绝：`rm -rf /` 会删除根目录或家目录。请改成删除具体子目录。

    ### PreToolUse: git push origin main --force
    exit=0
    stdout={"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"禁止 --force，改用 --force-with-lease"}}

    ### PreToolUse: npm publish
    exit=0
    stdout={"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"发包需要人工确认"}}

    ### PreToolUse: python3 scripts/x.py
    exit=0
    stdout={"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"已自动加 -I 隔离模式","updatedInput":{"command":"python3 -I scripts/x.py","description":"demo"}}}

    ### Stop（第一次，transcript 里没有 passed）
    {"decision":"block","reason":"还没看到测试通过的输出。请运行 `npm test` 并把结果贴出来再结束。"}
    exit=0

    ### Stop（stop_hook_active=true，放行）
    exit=0 (stdout 为空 = 允许停)
    ```

=== "Python"

    ```text
    $ cd code/agent && bash hooks_demo/run_demo.sh
    ### PreToolUse: ls -la
    exit=0

    ### PreToolUse: rm -rf /
    exit=2
    stderr=拒绝：`rm -rf /` 会删除根目录或家目录。请改成删除具体子目录。

    ### PreToolUse: git push origin main --force
    exit=0
    stdout={"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "禁止 --force，改用 --force-with-lease"}}

    ### PreToolUse: npm publish
    exit=0
    stdout={"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": "发包需要人工确认"}}

    ### PreToolUse: python3 scripts/x.py
    exit=0
    stdout={"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": "已自动加 -I 隔离模式", "updatedInput": {"command": "python3 -I scripts/x.py", "description": "demo"}}}

    ### Stop（第一次，transcript 里没有 passed）
    {"decision": "block", "reason": "还没看到测试通过的输出。请运行 `uv run pytest -q` 并把结果贴出来再结束。"}
    exit=0

    ### Stop（stop_hook_active=true，放行）
    exit=0 (stdout 为空 = 允许停)
    ```

五条 Bash 命令得到了五种结果：

- `ls -la`：不表态，走正常的权限流程。
- `rm -rf /`：最硬的 exit 2。
- `git push --force`：JSON deny，带一个结构化的理由。
- `npm publish`：ask，交给人来确认。
- `python3 ...`：allow，同时用 `updatedInput` 偷偷改写了参数。

最后一种最容易被忽略。hook 不只是个闸门，还能当中间件用，在工具执行前把参数改掉。

再看 `guard_bash.ts` 的核心。注意它是一个纯函数，返回 `[exitCode, stdout, stderr]` 三元组（Python 版是 `(exit_code, stdout, stderr)`），所以不启动子进程也能单测：

=== "Node"

    ```ts
    function decide(payload: HookPayload): [number, string, string] {
      if (payload.hook_event_name !== "PreToolUse" || payload.tool_name !== "Bash") return [0, "", ""];
      const cmd = String(payload.tool_input?.command ?? "");
      if (/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(\s|$)/.test(cmd) ...) {
        return [2, "", `拒绝：\`${cmd}\` 会删除根目录或家目录。...`];
      }
      if (/\bgit\s+push\b.*--force(?!-with-lease)/.test(cmd)) {
        const out = { hookSpecificOutput: { hookEventName: "PreToolUse",
                      permissionDecision: "deny", permissionDecisionReason: "..." } };
        return [0, JSON.stringify(out), ""];
      }
      ...
    }
    ```

=== "Python"

    ```python
    def decide(payload: dict) -> tuple[int, str, str]:
        if payload.get("hook_event_name") != "PreToolUse" or payload.get("tool_name") != "Bash":
            return 0, "", ""
        cmd = payload.get("tool_input", {}).get("command", "")
        if re.search(r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+/(\s|$)", cmd) ...:
            return 2, "", f"拒绝：`{cmd}` 会删除根目录或家目录。..."
        if re.search(r"\bgit\s+push\b.*--force(?!-with-lease)", cmd):
            out = {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                   "permissionDecision": "deny", "permissionDecisionReason": "..."}}
            return 0, json.dumps(out, ensure_ascii=False), ""
        ...
    ```

`stop_gate.ts`（`stop_gate.py`）演示的是防死循环。Stop hook 拦一次，模型就多干一轮；干完又想停，又被拦……如果条件永远达不到，就会一直转下去。

官方给了两道保险。一是 stdin 里的 `stop_hook_active`：它为 true，说明这次 Stop 本身就是被拦回去之后再次触发的，脚本应该直接放行。二是 harness 自己的上限：连续 block 8 次、中间模型一次工具都没调用，Claude Code 就强行结束（上限可以用 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 调）。

最后用 `hook_runner.ts`（`hook_runner.py`）把整条链路串起来，看 harness 拿到 exit 2 之后怎么处理：

=== "Node"

    ```text
    $ node hooks_demo/hook_runner.ts hooks_demo/demo_settings.json <rm -rf / 的事件文件>
    · "node hooks_demo/guard_bash.ts" -> exit=2
    {"blocked":true,"permission":"deny","reason":"拒绝：`rm -rf /` 会删除根目录或家目录。请改成删除具体子目录。","updatedInput":null,"context":[],"stopSession":false}
    ```

=== "Python"

    ```text
    $ python3 hooks_demo/hook_runner.py hooks_demo/demo_settings.json <rm -rf / 的事件文件>
    · 'python3 hooks_demo/guard_bash.py' -> exit=2
    {"blocked": true, "permission": "deny", "reason": "拒绝：`rm -rf /` 会删除根目录或家目录。请改成删除具体子目录。", "updated_input": null, "context": [], "stop_session": false}
    ```

测试：`node --test 'hooks_demo/*.test.ts'`，结果 `ℹ pass 6`（Python 版 `uv run pytest -q hooks_demo`，结果 `6 passed`）。

想在真 Claude Code 里试，把 `demo_settings.json` 里那段 `hooks` 拷进某个测试仓库的 `.claude/settings.local.json` 就行。不要改 `~/.claude/settings.json`，那是全局生效的。

## 对照你的环境

你的配置几乎把三种输出通道都用上了，正好拿来对照：

- **`inject-guardrails.sh`（SessionStart）用的是纯文本 stdout。** 脚本头部注释写着「SessionStart 只把纯 stdout 当上下文；JSON 形状不对会被静默丢弃」。这和文档一致：纯文本最省事，JSON 一旦写错字段层级，hook 就悄无声息地失效了。我本机实测，同一个脚本在不同 cwd 下注入的量是：
  - `~/agent-learn`（不是 git 仓库）：0 字符。这正是脚本设计的「拿不到身份就什么都不注入」（deny by default）。
  - `~/dotfiles/claude-skills`：4,017 字符（5,767 字节）。
  - `~/work/webapp/apps/web`：7,683 字符（12,008 字节），公司层加项目层两层累积。

  官方文档写明纯文本 stdout 和 `additionalContext` 一样受这个上限约束：「A hook's `additionalContext`, `systemMessage`, and `initialUserMessage` strings, and its plain stdout, are capped at 10,000 characters」。上限按**字符**算，不是字节。中文在 UTF-8 里一个字占 3 字节，所以 `wc -c` 量出来的 12,008 是字节数，按字符只有 7,683，没超，离上限还有约 2,300 字符。这里踩过一次坑：最早用 `wc -c` 量，误判成了超限。量字符要用 `wc -m`（并确保 locale 是 UTF-8）、Python 的 `len(text)` 或 Node 的 `[...text].length`（`text.length` 数的是 UTF-16 码元，emoji 会算成 2）。
- **`enforce-worktree.py`（PreToolUse: Bash）用的是 exit 2 + stderr。** 它的 docstring 写得很清楚：「2 = 拒绝该次工具调用，stderr 回灌给模型」。它还专门处理了「heredoc 和引号里出现的 `git worktree add` 是数据不是调用」这种误伤，这正是常见坑第 3 条。
- **`cc-status` 挂在 10 个事件上**，全部不带 matcher，所以每个事件都会触发。我统计了最近 40 个会话的 jsonl，`hook_success` 类型的 attachment 有一万三千多条。每条都记着 `hookName`（例如 `SessionStart:startup`）、`exitCode`、`stdout`、`durationMs`。hook 不生效时，先翻 jsonl 里的这些记录，比盲猜快得多。
- **你的 CLAUDE.md 原则 1「工具链能强制的就别写进上下文」**，说的就是本章这件事。原则 3 说「关流程 = 关规则 + 卸工具」，hook 就是那个「卸工具」的手段：deny 掉的那条路，模型想走也走不了。

说实话，我的观点是：**大部分规矩用不着 hook**。现在的模型对指令的遵从度已经很高，每加一个 hook 就多一个子进程、多一份要维护的脚本。

值得写成 hook 的只有两类：

- 出了错要返工的硬约束，比如 worktree、发布、删除。
- 需要「在模型之外」看一眼的验收，比如测试通过才许停。

官方 skills 文档在「Claude stops following a skill」一节也是这个建议：每次都必须成立的规则，从 skill 挪到 hook 里。

## 常见坑

1. **用 `exit 1` 想拦截。** 1 是非阻断错误，工具照常执行，只有 `exit 2` 才会阻断。
2. **JSON 前面混进了别的输出。** shell profile 里有一句无条件的 `echo`，stdout 就不再以 `{` 开头，整段 JSON 失效，而且不报任何错。另一种情况是把 `permissionDecision` 放到了顶层，它应该放在 `hookSpecificOutput` 里面。
3. **对命令字符串做朴素的正则匹配。** `echo "git worktree add"` 这种「提到」也会被当成「调用」拦掉。反过来，`bash -c "..."` 能绕过匹配。你的 `enforce-worktree.py` 选择抹掉引号里的内容，接受「刻意绕过拦不住」，换来「日常不误伤」。这个取舍是对的。
4. **Stop hook 不检查 `stop_hook_active`。** 条件永远达不到时，模型会被拦 8 次才放出来，白白烧掉 8 轮 token。
5. **matcher 写成了正则还以为是精确匹配。** matcher 里只出现字母、数字、`_`、`|` 这类字符时，按精确名或列表匹配；一旦出现别的字符，就当成不锚定的 JS 正则。所以 `Edit.*` 也会匹配 `NotebookEdit`，想精确匹配要写 `^Edit$`。

## 练习

1. 给 `guard_bash.ts`（或 `guard_bash.py`）加一条规则：命令里出现 `.env` 就 deny。用 `run_demo.sh` 的方式造一份 stdin 验证，再写一条测试（`node:test` 或 pytest）。
2. 把 `stop_gate.ts`（`stop_gate.py`）从「搜字符串 passed」改成真正解析 transcript jsonl：找到最后一次 Bash 的 `tool_result`，判断其中是否出现 `N passed` 且没有 `failed`。想一想：`transcript_path`「可能落后于内存中的对话」，这会给你的判断带来什么风险？
3. （开放题）你现在有 45 个 skill，其中有哪些步骤其实是「每次都必须成立」、应该从 skill 正文挪到 hook 里的？挑一个，写出它应该挂在哪个事件、用哪个通道回话，并说明为什么不能继续只写在 skill 里。

## 延伸阅读

- 官方 Hooks reference：<https://code.claude.com/docs/en/hooks>（事件全集、输入输出 schema、exit code 表）
- 官方 Hooks guide：<https://code.claude.com/docs/en/hooks-guide>（prompt 型和 agent 型 hook、block cap 排障）
- 本库：[/goal 命令](09-goal-command.md)（基于 Stop hook 的 LLM 验收循环）、[Skills](12-skills.md)（skill frontmatter 里也能挂 hook）、[权限检查](../p3-agent-internals/10-permission-check.md)
