# 对工具调用进行权限审批

> 对应原站：[对工具调用进行权限审批](https://labuladong.online/zh/ai-coding/coding-agent/permission/)（会员内容；本章为独立原创重写）

> **一句话结论**：权限检查就是在「模型说要调工具」和「工具真的执行」之间插一道关卡，关卡只回答一个问题：allow、ask 还是 deny。所有花样（只读放行、记住规则、acceptEdits、bypass）都只是这个判定函数里的一条分支。

## 你的 `defaultMode` 是 `bypassPermissions`，那谁在拦 `rm -rf`？

翻一下你的 `~/.claude/settings.json`：

```json
"permissions": { "allow": ["Bash(git push:*)", "Bash(git commit:*)", ...], "defaultMode": "bypassPermissions" }
```

你可能会问：既然是 bypass，那 `allow` 列表还有什么用？配置的 `PermissionRequest` hook 又在什么时候触发？

要回答这些，得先看清权限判定在循环里**到底在哪一步、按什么顺序**发生。而 mini-cc 目前的情况更糟：模型说调什么就调什么，往 `Bash` 里塞一句 `rm -rf ~`，它眼都不眨就执行了。

## 先跑起来看看

离线 fake 模型（`examples/ch05.json`；Node 版剧本写的是 `hello.js`、跑 `node hello.js`），在一个临时项目目录里跑，弹窗的回答也从管道喂进去：

=== "Node"

    ```console
    ❯ 写个 hello.js 跑一下
    ◇ system  项目说明 0 个文件
    ◇ system  日期 2026-10-22
    ● 先看看目录。
    ⏺ Bash(ls)
    ✔ Bash -> build
    ● 写一个 hello.js。
    ⏺ Write(hello.js)
    是否允许 Write(hello.js)？（needs approval）
      1. 允许
      2. 允许，且本会话不再询问 Write
      3. 拒绝（可以附一句话告诉模型该怎么做）
    选择 [1/2/3]: 1
    ✔ Write -> Created hello.js (1 lines)
    ● 跑一下。
    ⏺ Bash(node hello.js)
    是否允许 Bash(node hello.js)？（needs approval）
      1. 允许
      2. 允许，且本会话不再询问 Bash(node hello.js)
      3. 拒绝（可以附一句话告诉模型该怎么做）
    选择 [1/2/3]: 2
    ✔ Bash -> hello
    ● 再跑一次确认。
    ⏺ Bash(node hello.js)
    ✔ Bash -> hello
    ● 顺手清理 build 目录。
    ⏺ Bash(rm -rf build)
    是否允许 Bash(rm -rf build)？（needs approval）
      1. 允许
      2. 允许，且本会话不再询问 Bash(rm -rf build)
      3. 拒绝（可以附一句话告诉模型该怎么做）
    选择 [1/2/3]: 3
    说明（可留空，回车跳过）: build 里有缓存，别删
    ✘ Bash -> The user doesn't want to proceed with this tool use. The tool use was rejected (it was NOT executed)
      build 里有缓存，别删
    ● 明白，build 目录保留不动。hello.js 已创建并运行通过。
    ❯ /status
    model     claude-opus-5-5
    effort    medium
    cwd       $SCRATCH/demo_proj
    session   d3f9c327-7544-40be-97ec-1615156d504a
    mode      default
    allow     Bash(node hello.js)
    reviewer  0 calls
    messages  12
    context   100 tokens（最近一次请求的输入）
    total     in 600 / out 120 / 6 requests
    ```

=== "Python"

    ```console
    ❯ 写个 hello.py 跑一下
    ● 先看看目录。
    ⏺ Bash(ls)
    ✔ Bash -> build
    ● 写一个 hello.py。
    ⏺ Write(hello.py)
    是否允许 Write(hello.py)？（needs approval）
      1. 允许
      2. 允许，且本会话不再询问 Write
      3. 拒绝（可以附一句话告诉模型该怎么做）
    选择 [1/2/3]: 1
    ✔ Write -> Wrote 15 chars to hello.py
    ● 跑一下。
    ⏺ Bash(python3 hello.py)
    是否允许 Bash(python3 hello.py)？（needs approval）
      ...
    选择 [1/2/3]: 2
    ✔ Bash -> hello
    ● 再跑一次确认。
    ⏺ Bash(python3 hello.py)
    ✔ Bash -> hello
    ● 顺手清理 build 目录。
    ⏺ Bash(rm -rf build)
    是否允许 Bash(rm -rf build)？（needs approval）
      ...
    选择 [1/2/3]: 3
    说明（可留空，回车跳过）: build 里有缓存，别删
    ✘ Bash -> The user doesn't want to proceed with this tool use. The tool use was rejected (it was NOT executed)
      build 里有缓存，别删
    ● 明白，build 目录保留不动。hello.py 已创建并运行通过。
    ❯ /status
    ...
    mode      default
    allow     Bash(python3 hello.py)
    ```

四个细节：`ls` 没问就放行了（只读）；第二次 `python3 hello.py` 没问（选过「不再询问」）；`rm -rf build` 被拒，**拒绝理由原样交给了模型**，模型据此改了主意。

同一份剧本用 `--permission-mode acceptEdits` 再跑一次：

=== "Node"

    ```console
    ❯ 写个 hello.js 跑一下
    ◇ system  项目说明 0 个文件
    ◇ system  日期 2026-10-22
    ● 先看看目录。
    ⏺ Bash(ls)
    ✔ Bash -> build
    ● 写一个 hello.js。
    ⏺ Write(hello.js)
    ✔ Write -> Created hello.js (1 lines)
    ● 跑一下。
    ⏺ Bash(node hello.js)
    是否允许 Bash(node hello.js)？（needs approval）
      1. 允许
      2. 允许，且本会话不再询问 Bash(node hello.js)
      3. 拒绝（可以附一句话告诉模型该怎么做）
    选择 [1/2/3]: 1
    ✔ Bash -> hello
    ● 再跑一次确认。
    ⏺ Bash(node hello.js)
    是否允许 Bash(node hello.js)？（needs approval）
      1. 允许
      2. 允许，且本会话不再询问 Bash(node hello.js)
      3. 拒绝（可以附一句话告诉模型该怎么做）
    选择 [1/2/3]: 3
    说明（可留空，回车跳过）: 
    ✘ Bash -> The user doesn't want to proceed with this tool use. The tool use was rejected (it was NOT executed)
    ```

=== "Python"

    ```console
    ⏺ Write(hello.py)
    ✔ Write -> Wrote 15 chars to hello.py
    ● 跑一下。
    ⏺ Bash(python3 hello.py)
    是否允许 Bash(python3 hello.py)？（needs approval）
    选择 [1/2/3]: 1
    ...
    ⏺ Bash(python3 hello.py)
    选择 [1/2/3]: 3
    说明（可留空，回车跳过）:
    ✘ Bash -> The user doesn't want to proceed with this tool use. The tool use was rejected (it was NOT executed)
    ```

写文件不再问了，跑命令照问。最后一次拒绝**没给理由**，这一轮就直接结束了——模型没有机会再说话，等你下一句指令。

## 一个函数，三种结论

```d2
direction: down
s: "模型发来 tool_use"
v: "参数合法？\ncheck_input" {shape: diamond}
err: "InputValidationError\n（不进权限判定）"
d1: "命中 deny 规则？" {shape: diamond}
deny: "deny"
x: "extra_checks\n（扩展钩子）" {shape: diamond}
out: "按钩子结论"
b: "bypass 模式？" {shape: diamond}
allow: "allow"
h: "工具自检：高危？" {shape: diamond}
ask: "ask"
r: "只读 / 自检安全？" {shape: diamond}
ru: "会话 allow 规则？" {shape: diamond}
ae: "acceptEdits 且\n项目内编辑？" {shape: diamond}
au: "auto 模式？" {shape: diamond}
cl: "审查员判定\n（下一章）"
u: "用户选择" {shape: diamond}
rem: "记住规则"
s -> v
v -> err: 否
v -> d1: 是
d1 -> deny: 是
d1 -> x: 否
x -> out: 有结论
x -> b: 无
b -> allow: 是
b -> h: 否
h -> ask: 是
h -> r: 否
r -> allow: 是
r -> ru: 否
ru -> allow: 是
ru -> ae: 否
ae -> allow: 是
ae -> au: 否
au -> cl: 是
au -> ask: 否
ask -> u
u -> allow: "1 允许"
u -> rem: "2 不再询问"
rem -> allow
u -> deny: "3 拒绝"
```

图注：这就是 `mini_cc/permissions.py:PermissionManager.decide` 的全部逻辑，自上而下、先命中先返回。

打个比方，这像公司的报销审批。日常小额（只读）直接过；你说过「这类以后不用找我」（会话规则）的也直接过；行政用品（编辑项目内文件）在某些部门（acceptEdits）是预批的；超过红线（高危命令）的，不管什么部门都得找老板签字；老板出差前说「这周都别找我」（bypass），那就全过。

这个比方不成立的地方是：报销被拒了，员工会自己想办法；而 agent 里**拒绝理由是写进上下文的**，模型下一步怎么做，完全取决于你拒绝时说了什么。所以「拒绝」在这里不只是一个门禁动作，它还是一次沟通。

**回到主线**：权限判定本身不往上下文里放任何东西——除了被拒绝时那条 `tool_result`。这条结果是 agent 世界里最便宜也最有效的「纠偏信号」：一句「别删 build，用 make clean」，比你事后再开一轮对话解释，省下的是整整一轮完整上下文。

## 判定顺序里的三个讲究

`decide()` 的代码几乎就是上面那张图的直译：

=== "Node"

    ```ts
    async decide(tool: Tool, args: Args): Promise<Decision> {
      const key = tool.ruleKey(args);
      if (this.denyRules.has(key) || this.denyRules.has(tool.name))
        return new Decision("deny", `matches deny rule ${key}`, "rule");
      for (const check of this.extraChecks) {
        const d = await check(tool, args, this);
        if (d !== null) return d;
      }
      if (this.mode === BYPASS) return new Decision("allow", "bypassPermissions mode", "mode");
      const verdict = tool.selfCheck(args);
      if (verdict === "ask") return new Decision("ask", "high-risk operation", "tool");
      if (tool.readOnly || verdict === "allow") return new Decision("allow", "read-only", "tool");
      if (this.allowRules.has(key) || this.allowRules.has(tool.name))
        return new Decision("allow", `session rule ${key}`, "rule");
      if (this.mode === ACCEPT_EDITS && tool.kind === "edit" && this.insideProject(tool, args))
        return new Decision("allow", "acceptEdits: edit inside project", "mode");
      if (this.mode === AUTO && this.classifier !== null) return this.classifier(tool, args);
      return new Decision("ask", "needs approval", "mode");
    }
    ```

=== "Python"

    ```python
    def decide(self, tool, args) -> Decision:
        key = tool.rule_key(args)
        if key in self.deny_rules or tool.name in self.deny_rules:
            return Decision("deny", f"matches deny rule {key}", "rule")
        for check in self.extra_checks:
            d = check(tool, args, self)
            if d is not None:
                return d
        if self.mode == BYPASS:
            return Decision("allow", "bypassPermissions mode", "mode")
        verdict = tool.self_check(args)
        if verdict == "ask":
            return Decision("ask", "high-risk operation", "tool")
        if tool.read_only or verdict == "allow":
            return Decision("allow", "read-only", "tool")
        if key in self.allow_rules or tool.name in self.allow_rules:
            return Decision("allow", f"session rule {key}", "rule")
        if self.mode == ACCEPT_EDITS and tool.kind == "edit" and self._inside_project(tool, args):
            return Decision("allow", "acceptEdits: edit inside project", "mode")
        if self.mode == AUTO and self.classifier is not None:
            return self.classifier(tool, args)
        return Decision("ask", "needs approval", "mode")
    ```

你可能会问：为什么 deny 要排第一，比 bypass 还早？

因为 deny 规则是你**事先**明确表达的意图（「这个仓库永远别 `git push`」），而 bypass 是一个宽泛的开关。具体的禁令应该压过宽泛的放行。

第二个讲究：**高危检查排在会话规则前面**。你选过「`Bash` 以后都不用问」，但模型下一条是 `sudo rm -rf /`——这时候还是得问。测试 `test_dangerous_command_asks_even_with_allow_rule` 守着这一条。

第三个讲究：`extra_checks` 是留给后面章节的**扩展钩子**，排在 bypass 之前。第 21 章的 plan 模式要求「除了 plan 文件，什么都不许写」，这种约束不应该被任何放行规则覆盖，所以它挂在最前面。

## 工具自己最懂自己

模式只知道「这是编辑类」「这是执行类」，但 `Bash` 里的 `ls` 和 `rm` 天差地别。所以每个工具可以实现一个 `self_check(args)`，返回 `'allow'`（我确定这次安全）、`'ask'`（这次很危险）或 `None`（交给模式决定）。

`mini_cc/tools/bash.ts:BashTool.selfCheck`（Python 版 `bash.py:BashTool.self_check`）做了两件事：

=== "Node"

    ```ts
    selfCheck(args: Args): "allow" | "ask" | null {
      const cmd: string = args.command ?? "";
      if (DANGEROUS.some((p) => p.test(cmd))) return "ask";   // rm -rf / ~ *、sudo、mkfs、curl | sh、git push --force…
      if (isReadOnly(cmd)) return "allow";                     // ls、cat、grep、git status……
      return null;
    }
    ```

=== "Python"

    ```python
    def self_check(self, args):
        cmd = args.get("command", "")
        if any(p.search(cmd) for p in DANGEROUS):   # rm -rf / ~ *、sudo、mkfs、curl | sh、git push --force…
            return "ask"
        if is_read_only(cmd):                         # ls、cat、grep、git status……
            return "allow"
        return None
    ```

`is_read_only()` 的核心是 `split_commands()`：用 `shlex`（Node 没有 shlex，`bash.ts` 里写了一个按同样规则分词的小函数）按 `|`、`&&`、`||`、`;` 拆成子命令，**每一段**都在只读白名单里才算只读。这里我坚持一个原则：**看不懂就不放行**。只要出现重定向 `>`、命令替换 `$(...)` 或反引号、后台 `&`，直接返回 `False`：

| 命令 | 只读？ | 为什么 |
|---|---|---|
| `git status && git diff` | 是 | 两段都在白名单 |
| `cat a.txt \| grep x \| wc -l` | 是 | 三段都在白名单 |
| `ls > out.txt` | 否 | 重定向会写文件 |
| `echo $(rm x)` | 否 | 命令替换里能藏任何东西 |
| `find . -delete` | 否 | `find` 带 `-delete/-exec` 不算只读 |

说实话，这个白名单永远不可能完美。`cat ~/.ssh/id_rsa` 是「只读」的，但你未必想让模型读。安全边界真正靠得住的是沙箱，命令解析只是减少打扰的手段——这一点我们在常见坑里还会说。

`rule_key()` 决定「不再询问」记住的是什么。默认是工具名（选了「不再询问 Write」就是整个 Write）；`Bash` 记的是**具体命令** `Bash(python3 hello.py)`，否则批准一次 `ls`，就等于批准了所有命令。

## 关卡插在循环的哪里

`mini_cc/loop.ts:Agent.runTools`（Python 版 `loop.py:Agent._run_tools`）对每个工具调用依次做：

=== "Node"

    ```ts
    const bad = this.tools.checkInput(tu.name, tu.input);   // ① 参数校验（上一章的防线 1）
    let r: ToolResult;
    if (bad !== null) {
      r = bad;
    } else if (stop) {
      r = new ToolResult("Skipped: an earlier tool call in this batch was rejected by the user.", true);
    } else {
      const [ok, denied, stopNow] = yield* this.authorize(tu);  // ② 权限关卡
      stop = stop || stopNow;
      r = ok ? await this.tools.execute(...) : denied!;          // ③ 执行
    }
    ```

=== "Python"

    ```python
    bad = self.tools.check_input(tu["name"], tu["input"])   # ① 参数校验（上一章的防线 1）
    if bad is not None:
        r = bad
    elif stop:
        r = ToolResult("Skipped: an earlier tool call in this batch was rejected by the user.", True)
    else:
        ok, r, stop_now = yield from self._authorize(tu)     # ② 权限关卡
        stop = stop or stop_now
        if ok:
            r = self.tools.execute(...)                       # ③ 执行
    ```

顺序有讲究：**先校验、再判权限**。拿着一个缺参数的调用去问用户「允许吗？」，既浪费用户的注意力，判定函数也可能因为缺字段而出错。

`_authorize()` 是一个返回值的生成器（`yield from` 拿到返回值；Node 版是 `yield*`）。遇到 `ask` 时，它**同步**调用 `self.approver(req)`——也就是 UI 的弹窗——然后等着（Node 版是 `await this.approver(req)`，效果一样：这一轮停在这里）。这里第 2 章「生成器是惰性的」那个设计开始发挥作用：循环停在这一行，什么都不会继续发生，直到你按下数字。

用户的三种选择映射成：

- **1 允许 / 2 不再询问**：执行；选 2 时 `permissions.remember(req)` 把 `rule_key` 加进会话规则。
- **3 拒绝 + 理由**：不执行，`tool_result` 写入 `denied_message(feedback)`，循环继续，模型带着理由重新规划。
- **3 拒绝、不给理由**：同一批剩下的调用全部标记 `Skipped`，然后 `TurnEnd("denied")`，**不再请求模型**。

拒绝的措辞参考了 Claude Code。它的二进制里能看到两个版本：没给理由时是「…The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.」，给了理由时结尾换成「To tell you how to proceed, the user said:」。为什么要强调 NOT written？因为模型很容易「假设」自己的编辑已经生效，接着在一个并不存在的修改上继续干活。

没有 approver 的时候（比如 `-p` 非交互模式没人能回答），一律按拒绝处理：**拿不到同意就当作不同意**。

## 模式：Shift+Tab 和会话记录

模式切换有三个入口：命令行 `--permission-mode acceptEdits`、命令 `/mode acceptEdits`、REPL 里按 **Shift+Tab** 循环（`default → acceptEdits → default`，底部状态栏显示 `▶▶ acceptEdits（Shift+Tab 切换）`；Node 版的 `node:readline` 没有底部状态栏，模式显示在提示符前面：`[acceptEdits] ❯`）。`PermissionManager.cycle` 是一个列表，下一章会把 `auto` 加进去，第 21 章加 `plan`。

每次模式变化都通过 `on_mode_change` 写一条 `{"type": "permission-mode", "permissionMode": ...}` 记录进会话文件。上一章说过，读取时这类记录会被忽略；它的用处是**审计**：事后回看，你能知道某个文件是在哪个模式下被改的。你本机的 Claude Code 会话里，这种记录有两千多条。

## 测试

`tests/ch05_permissions.test.ts`（Python 版 `tests/test_ch05_permissions.py`），20 个：

- 只读命令判定（参数化 9 条）、完整的判定表（含 acceptEdits 不放行项目外路径 `../outside.txt` 和 `/etc/hosts`）、高危命令压过 allow 规则、`extra_checks` 优先于 bypass、模式循环。
- 循环里的审批：允许一次、记住规则后第二次不再问、拒绝带理由后继续、**拒绝不带理由时整批跳过、不再请求模型**、deny 规则事件、没有 approver 时拒绝、`/mode` 命令与会话记录。

=== "Node"

    ```console
    $ cd /Users/me/agent-learn/code/mini_cc-node && node --test 'tests/ch0[1-5]*.test.ts'
    ℹ tests 57
    ℹ suites 0
    ℹ pass 57
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 2232.285458
    ```

=== "Python"

    ```console
    $ cd /Users/me/agent-learn/code/mini_cc && uv run pytest -q
    .........................................................                [100%]
    57 passed in 1.61s
    ```

## 回到开头

现在可以回答开头的问题了。按 Claude Code 的设计（本机 2.1.306 的 `--permission-mode` 可选值是 `acceptEdits / auto / bypassPermissions / manual / dontAsk / plan`，内部模式名里还能看到 `default`），`bypassPermissions` 会让绝大多数调用直接放行，`allow` 列表在这个模式下的作用就小多了——它真正发挥作用是在你切回其他模式的时候。而 `PermissionRequest` hook，从名字和我们这张图看，它挂的位置就是图里的 `ask` 节点：**只有判定结果是「要问人」时才会触发**，bypass 模式下几乎不会走到那里。

谁在拦 `rm -rf`？在 bypass 模式下，答案是：没有人。这不是吓唬你，是这张图的直接推论。

## 和真实 Claude Code 的差异

- **规则持久化**：Claude Code 的规则写在 `settings.json` 的 `permissions.allow / deny / ask` 里，分 user / project / local 多层合并，支持 `Bash(git push:*)` 这样的前缀通配。mini-cc 只有会话内的精确匹配，规则不落盘。
- **更多模式**：Claude Code 还有 `dontAsk`、`plan`、`auto`（下一章）。`plan` 在 mini-cc 里只是占了个名字，第 21 章实现。
- **命令解析**：Claude Code 对 Bash 的解析细得多（二进制里能看到 PowerShell、重定向、`hasStopParsing` 之类的解析结构）。我们的 `shlex` 方案只覆盖常见情况，原则是看不懂就问。
- **hook 介入**：Claude Code 的 `PreToolUse` hook 可以直接返回 allow/deny 决定，`PermissionRequest` hook 可以代替用户回答弹窗。mini-cc 对应的扩展点是 `PermissionManager.extra_checks` 和 `Agent.approver`。

## 对照你的环境

- 你的 `PermissionRequest` hook 配的是 `~/.config/iterm2/cc-status`（更新 iTerm 状态）。结合本章的图：它只在 `ask` 节点触发。你在 bypass 模式下很少看到它被调用，这是符合预期的。
- 你允许了 `Bash(git push:*)`，同时 CLAUDE.md 里又有一条「push 后查目标 PR 是否已合并」的护栏。这是一个很好的分层示范：权限层只回答「能不能做」，「做完之后要检查什么」不归权限层管，归上下文（CLAUDE.md）管。

## 常见坑

1. **把命令解析当安全边界**。白名单挡不住 `cat ~/.ssh/id_rsa`，也挡不住白名单程序本身的危险参数。真要防，靠容器、沙箱、只读挂载。
2. **「不再询问」记得太宽**。`Bash` 按工具名记规则，等于一次批准放行所有命令。
3. **拒绝时不告诉模型「没执行」**。模型会假设编辑已经生效，在一个不存在的修改上继续干活。
4. **先判权限后校验参数**。缺参数的调用也弹窗问用户，体验差，判定函数还可能 KeyError。
5. **acceptEdits 不检查路径**。模型写 `../../.zshrc` 也会被「项目内编辑」放行；`_inside_project()` 用 `resolve()` 后的路径判断。

## 练习

1. 支持前缀规则：选「不再询问」时记成 `Bash(npm test:*)`，之后 `npm test -- --watch` 也放行。想想 `npm test; rm -rf ~` 该怎么防。
2. 把 `allow_rules` 持久化到 `<cwd>/.mini_cc/settings.json`，启动时加载。注意 user 级和 project 级规则冲突时谁优先。
3. 开放题：`cat ~/.ssh/id_rsa` 该不该算只读？如果不该，你会怎么设计「敏感路径」规则，而又不把正常的 `cat` 全变成要问？

## 延伸阅读

- Claude Code 权限配置：<https://code.claude.com/docs/en/iam>
- Hooks 参考（PreToolUse / PermissionRequest）：<https://code.claude.com/docs/en/hooks>
- 本系列：[Claude Code 的权限检查是怎么实现的](../p3-agent-internals/10-permission-check.md)、上一章 [持久化聊天记录](04-resume.md)、下一章 [auto 模式自动进行权限审批](06-auto-mode.md)
