# 让 Agent 先规划再动手

> 对应原站：[让 Agent 先规划再动手](https://labuladong.online/zh/ai-coding/coding-agent/plan/)（免费文章，推荐配合阅读；本章为独立原创课文）

> **一句话结论**：plan 模式不是一个新的权限开关，而是四个零件拼起来的一套流程：**权限关卡**挡住除计划文件以外的一切修改，**上下文提醒**告诉模型现在的规矩，**交接工具** `ExitPlanMode` 把「计划写好了」变成一次需要你点头的审批，**只读的 sub agent** 负责探索和设计。四个零件里，前三个都是第 5、9、10 章早就留好的扩展点。

## 一次都没用过 plan 模式，它还值得手搓吗？

[Plan Mode 是怎么实现的](../p3-agent-internals/11-plan-mode.md)那章翻过你本机的会话记录：一万三千多条 `permission-mode` 记录全是 `bypassPermissions`，`~/.claude/plans/` 是空的。你没用过 plan 模式。

你可能会问：既然平时不用，先跟它说一句「先别动手，给我个方案」不就行了？

对小任务，确实够了。但你回想一下那些「写到一半发现方向不对」的时刻：改了五个文件才发现漏了一个调用方；按自己的理解重构完，你才说「其实这个接口不能动」。问题不是模型不肯先想，而是一句口头约定有三个漏洞：

- 它可能「顺手」就改了，没有任何东西拦它；
- 聊了二十轮之后，开头那句「先别动手」早被淹没了；
- 「方案」散落在对话里，你没法明确地说一句「就按这个做」，它也没法确切地知道「现在可以动手了」。

plan 模式把这三个漏洞分别交给程序去堵：拦截交给权限层，提醒交给上下文注入，「批准」交给一个工具调用。第 5 章写权限时，`PLAN` 这个常量就已经在了，只是一直等同于 default。这一章把它补完。

## 先跑起来看看

离线 fake 模型（`examples/ch21.json`）。项目里 `api/posts.py` 定义了 `list_posts(posts)`，`web/feed.py` 调用了它（Node 版是 `api/posts.js` 和 `web/feed.js`，计划里的写法也相应换成了 JS）。你用 `/plan` 进入 plan 模式并直接给出需求（管道模式没法按 Shift+Tab）。计划文件的路径换成了 `$PLAN`（实际是 `<home>/plans/<会话 id>.md`）：

=== "Node"

    ```console
    ❯ /plan 给 list_posts 加分页，别破坏现有调用方
    已进入 plan 模式：只读探索，计划写到 $PLAN，用 ExitPlanMode 交给你审批
    ◇ system  项目说明 0 个文件
    ◇ system  日期 2026-10-22
    ◇ system  plan 模式规则（完整）
    ● 现在是 plan 模式，先只读地摸清现状。调用方可能不止一处，派个 Explore 去找。
    ⏺ Agent(Explore: 找 list_posts 调用方)
      ⎿ Explore: Bash(grep -rn 'list_posts(' --include=*.js .)
    ✔ Agent -> - api/posts.js:1 定义
      - web/feed.js:4 list_posts(all_posts)，不传其他参数，期望拿到全部帖子
        …(+1 lines)
    ● 有一个会影响接口行为的取舍，问一下。
    ⏺ AskUserQuestion(1 个问题：page_size)
    [page_size] (1/1) 分页默认每页多少条？
      1. 20 (Recommended) — 和 list_users 一致
      2. 50 — 减少翻页次数
      或直接输入你自己的答案；回车跳过
    › 1
    ✔ AskUserQuestion -> Your questions have been answered: "分页默认每页多少条？"="20 (Recommended)". You can now continue with these 
    ● （演示：模型「忍不住」想先改签名）
    ⏺ Edit(api/posts.js)
      ⎿ 权限拒绝：plan mode is active; only the plan file $PLAN may be written. Finish the plan and call ExitPlanMode to ask the user for approval
    ✘ Edit -> Permission denied: plan mode is active; only the plan file …
    ● 被拦住了，按规矩把方案写进计划文件。
    ⏺ Write($PLAN)
    ✔ Write -> Created $PLAN …
    ⏺ ExitPlanMode()
    ──────────────────── 计划 ────────────────────
      # 给 list_posts 加分页

      目标：list_posts 支持分页，现有调用方行为不变。

      改动：
      1. api/posts.js：list_posts(posts, page = 1, page_size = 20)，slice 返回
      2. web/feed.js:4 的调用不传参数，默认值保证行为不变（只是从「全部」变成「前 20 条」，需要确认）

      验证：断言 list_posts([...Array(50).keys()], 2) 是 20..39
    ──────────────────────────────────────────────
      1. 批准，之后的编辑自动通过（acceptEdits）
      2. 批准，每次编辑仍然逐个确认（default）
      3. 继续规划（可以附一句话说要改什么）
    选择 [1/2/3]: 3 旧调用方必须拿到全部数据，不能变成只有 20 条
    ✔ ExitPlanMode -> The user reviewed the plan and wants you to keep planning (still in plan mode). Their feedback:
      旧调用方必须拿到全部数据，不能变成只有 20 条
    ◇ system  plan 模式提醒
    ● 明白，旧调用方必须完全不受影响。改计划。
    ⏺ Edit($PLAN)
    ✔ Edit -> The file $PLAN has been updated (1 replacement). …
    ⏺ ExitPlanMode()
    ──────────────────── 计划 ────────────────────
      ...
      2. web/feed.js:4 显式传 page_size = null 表示不分页；list_posts 在 page_size === null 时返回全部，旧行为完全不变
      ...
    选择 [1/2/3]: 1
    ✔ ExitPlanMode -> User has approved your plan. You can now start coding. Start with updating your todo list if applica

      ## Approved Plan:  …(+9 lines)
    ◇ system  已退出 plan 模式
    ⏺ Read(api/posts.js)
    ...
    ⏺ Edit(api/posts.js)
    ✔ Edit -> The file api/posts.js has been updated (1 replacement). Snippet:
           1	function list_posts(posts, page = 1, page_size = 20) {
           2	  if (page_size === null) return posts;  …(+5 lines)
    ⏺ Read(web/feed.js)
    ...
    ⏺ Edit(web/feed.js)
    ✔ Edit -> The file web/feed.js has been updated (1 replacement). Snippet:
    ...
    ● 按批准的计划改完了：list_posts 支持 page / page_size（默认 20），web/feed.js 显式不分页，旧行为不变。
    ❯ /mode
    权限模式：acceptEdits（循环顺序：default → acceptEdits → plan → auto）
    ❯ /exit
    ```

=== "Python"

    ```console
    ❯ /plan 给 list_posts 加分页，别破坏现有调用方
    已进入 plan 模式：只读探索，计划写到 $PLAN，用 ExitPlanMode 交给你审批
    ◇ system  项目说明 0 个文件
    ◇ system  日期 2026-10-21
    ◇ system  plan 模式规则（完整）
    ● 现在是 plan 模式，先只读地摸清现状。调用方可能不止一处，派个 Explore 去找。
    ⏺ Agent(Explore: 找 list_posts 调用方)
      ⎿ Explore: Bash(grep -rn 'list_posts(' --include=*.py .)
    ✔ Agent -> - api/posts.py:1 定义
      - web/feed.py:4 list_posts(all_posts)，不传其他参数，期望拿到全部帖子
        …(+1 lines)
    ● 有一个会影响接口行为的取舍，问一下。
    ⏺ AskUserQuestion(1 个问题：page_size)
    [page_size] (1/1) 分页默认每页多少条？
      1. 20 (Recommended) — 和 list_users 一致
      2. 50 — 减少翻页次数
      或直接输入你自己的答案；回车跳过
    › 1
    ✔ AskUserQuestion -> Your questions have been answered: "分页默认每页多少条？"="20 (Recommended)". You can now continue with these 
    ● （演示：模型「忍不住」想先改签名）
    ⏺ Edit(api/posts.py)
      ⎿ 权限拒绝：plan mode is active; only the plan file $PLAN may be written. Finish the plan and call ExitPlanMode to ask the user for approval
    ✘ Edit -> Permission denied: plan mode is active; only the plan file …
    ● 被拦住了，按规矩把方案写进计划文件。
    ⏺ Write($PLAN)
    ✔ Write -> Created $PLAN …
    ⏺ ExitPlanMode()
    ──────────────────── 计划 ────────────────────
      # 给 list_posts 加分页

      目标：list_posts 支持分页，现有调用方行为不变。

      改动：
      1. api/posts.py：list_posts(posts, page=1, page_size=20)，切片返回
      2. web/feed.py:4 的调用不传参数，默认值保证行为不变（只是从「全部」变成「前 20 条」，需要确认）

      验证：断言 list_posts(range(50), 2) == range(20, 40)
    ──────────────────────────────────────────────
      1. 批准，之后的编辑自动通过（acceptEdits）
      2. 批准，每次编辑仍然逐个确认（default）
      3. 继续规划（可以附一句话说要改什么）
    选择 [1/2/3]: 3 旧调用方必须拿到全部数据，不能变成只有 20 条
    ✔ ExitPlanMode -> The user reviewed the plan and wants you to keep planning (still in plan mode). Their feedback:
      旧调用方必须拿到全部数据，不能变成只有 20 条
    ◇ system  plan 模式提醒
    ● 明白，旧调用方必须完全不受影响。改计划。
    ⏺ Edit($PLAN)
    ✔ Edit -> The file $PLAN has been updated (1 replacement). …
    ⏺ ExitPlanMode()
    ──────────────────── 计划 ────────────────────
      ...
      2. web/feed.py:4 显式传 page_size=None 表示不分页；list_posts 在 page_size=None 时返回全部，旧行为完全不变
      ...
    选择 [1/2/3]: 1
    ✔ ExitPlanMode -> User has approved your plan. You can now start coding. Start with updating your todo list if applica

      ## Approved Plan:  …(+9 lines)
    ◇ system  已退出 plan 模式
    ⏺ Read(api/posts.py)
    ...
    ⏺ Edit(api/posts.py)
    ✔ Edit -> The file api/posts.py has been updated (1 replacement). Snippet:
           1        def list_posts(posts, page=1, page_size=20):
           2            if page_size is None:  …(+3 lines)
    ⏺ Read(web/feed.py)
    ...
    ⏺ Edit(web/feed.py)
    ✔ Edit -> The file web/feed.py has been updated (1 replacement). Snippet:
    ...
    ● 按批准的计划改完了：list_posts 支持 page / page_size（默认 20），web/feed.py 显式不分页，旧行为不变。
    ❯ /mode
    权限模式：acceptEdits（循环顺序：default → acceptEdits → plan → auto）
    ```

（剧本里第三步那次 `Edit` 是故意写的，用来演示关卡；真模型在完整规则的约束下很少这么做，但「很少」不等于「不会」，这正是要有关卡的原因。）

这一段里有一个细节最能说明 plan 模式的价值：第一版计划写着「默认值保证行为不变（只是从全部变成前 20 条）」。这句话自相矛盾，一旦直接动手，`web/feed.py`（Node 版 `web/feed.js`）会悄悄地只拿到 20 条帖子。因为有审批这一步，你在一行代码都没改的时候就把它拦了下来，模型带着你的反馈改了计划，第二版才被批准。

## 原理：四个零件

```d2
direction: down
enter: "进入 plan" {
  a1: "Shift+Tab / /plan /\n--permission-mode plan"
  a2: "模型调 EnterPlanMode"
}
p: "PermissionManager.mode = plan\n（on_mode_change → 写进会话）"
r: "① 提醒 provider\n完整规则 →\n每 5 步精简提醒"
g: "② 权限关卡 extra_checks\n（排在 bypass 之前）\n只读放行 · 计划文件可写 ·\n改状态的命令要问 · 其余编辑拒绝"
s: "④ sub agent 一律只读\nExplore 探索 · Plan 设计"
m: "模型：探索 → 提问 → 写计划文件"
x: "③ ExitPlanMode：读计划文件 → 审批"
e: "mode = acceptEdits 或 default\nprovider 发「已退出 plan」提醒"
enter -> p
p -> r
p -> g
p -> s
r -> m
g -> m
s -> m
m -> x
x -> m: "继续规划 + 反馈"
x -> e: "批准"
```

图注：四个零件挂在三个不同的地方。①在上下文里（模型「知道」规矩），②在执行层（模型「做不到」违规），③是一个工具（模型「交得出」结果），④是工具集的裁剪（子 agent「拿不到」写的能力）。

打个比方，这像装修前的设计阶段。设计师可以进屋量尺寸、拍照、问你喜好（只读探索、提问），也可以在图纸上随便画（计划文件），但不能拿锤子砸墙（编辑被拦）。图纸画完要你签字（ExitPlanMode），签了字施工队才进场（模式切换）。

这个比方在一处不成立：设计师知道自己在设计阶段，不需要每天提醒；模型每次请求都是从上下文里重新「得知」自己处在什么阶段的。所以「提醒」这个零件在人类流程里几乎是多余的，在 agent 里却必不可少。

**回到主线**：plan 模式在上下文里只多放了一段规则和偶尔的提醒，真正的约束在上下文**之外**：权限层和工具集。这是本系列反复出现的一个规律：**上下文里的指令决定模型「倾向」做什么，程序里的约束决定它「能」做什么**。两者叠在一起才可靠。

## 动手

### 零件一：权限关卡

`mini_cc/plan_mode.ts:planCheck`（Python 版 `plan_mode.py:plan_check`），挂在第 5 章留下的 `PermissionManager.extra_checks` 上：

=== "Node"

    ```ts
    return (tool: Tool, args: Args, pm: PermissionManager): Decision | null => {
      if (pm.mode !== PLAN) return null;
      if (tool.name === "ExitPlanMode" || tool.name === "EnterPlanMode" || tool.readOnly) {
        return null; // 交给后面的判定链（只读的会被放行）
      }
      const plan = planFile();
      if (tool.kind === "edit" && tool.pathArg && args[tool.pathArg]) {
        const target = realResolve(...);
        if (target === realResolve(plan)) return new Decision("allow", "plan mode: writing the plan file", "check");
      }
      if (tool.selfCheck(args) === "allow") {
        return null; // 只读命令、维护 agent 自己的状态（任务清单、记忆……）
      }
      if (tool.kind === "exec" || tool.kind === "mcp") return new Decision("ask", "plan mode: this is not read-only", "check");
      return new Decision("deny", `plan mode is active; only the plan file ${plan} may be written. Finish the plan ` +
        "and call ExitPlanMode to ask the user for approval", "check");
    };
    ```

=== "Python"

    ```python
    def check(tool, args, pm):
        if pm.mode != PLAN:
            return None
        if tool.name in ("ExitPlanMode", "EnterPlanMode") or tool.read_only:
            return None                                  # 交给后面的判定链（只读的会被放行）
        plan = plan_file()
        if tool.kind == "edit" and tool.path_arg and args.get(tool.path_arg):
            target = ...resolve()
            if target == plan.resolve():
                return Decision("allow", "plan mode: writing the plan file", "check")
        if tool.self_check(args) == "allow":
            return None                                  # 只读命令、维护 agent 自己的状态（任务清单、记忆……）
        if tool.kind in ("exec", "mcp"):
            return Decision("ask", "plan mode: this is not read-only", "check")
        return Decision("deny", f"plan mode is active; only the plan file {plan} may be written. Finish the plan "
                                "and call ExitPlanMode to ask the user for approval", "check")
    ```

四种结局，各有理由：

| 调用 | 结论 | 为什么 |
|---|---|---|
| Read、只读 Bash（`grep`、`git log`）、只读 MCP | 放行 | 探索本来就是 plan 阶段的工作 |
| Write / Edit 计划文件 | 放行，不用审批 | 写计划是 plan 阶段唯一的「产出」，每次都问你，等于没法规划 |
| 非只读命令（`npm install`、带重定向的 Bash、非只读 MCP） | 问你 | 有些命令在规划时确实有用（比如跑一下现有测试看看基线），由你决定 |
| 其余编辑 | 拒绝，并说明该怎么做 | 这是 plan 模式存在的意义 |

拒绝理由不只是「不行」，而是告诉模型**下一步该干什么**：只能写哪个文件、写完调哪个工具。这和第 7 章那几条报错的原则一样，模型按报错自我修正的前提，是报错里有路可走。演示里模型被拦之后马上去写了计划文件。

你可能会问：为什么挂在 `extra_checks` 上？直接在 `decide()` 里加一个 `if mode == PLAN` 分支不行吗？

位置是关键。`extra_checks` 排在判定链的第二位，在 deny 规则之后、**bypass 之前**。也就是说，就算有人把 plan 和 bypass 的语义混在一起，plan 的拦截依然生效。这一点 mini-cc 和 Claude Code 是不一样的：Claude Code 文档写明，在可以用 bypass 的交互式终端里，plan 模式**不强制拦截**，只是仍然指示模型先规划。我的取舍是：mini-cc 的 plan 模式始终拦截。理由是，一个名叫「先规划再动手」的模式，如果拦不住动手，它就只剩下提示词了，而提示词本来就可以由你随口说一句。

### 零件二：上下文提醒

`plan_mode_provider`（Node 版 `planModeProvider`；三段提醒文本在 Node 版里是三个返回字符串的小函数 `FULL_TEXT(header, plan)` 等，Python 版是 `str.format` 模板）是第 9 章 provider 机制的又一个应用：

=== "Node"

    ```ts
    return (st: InjectState) => {
      const mode = st.agent.permissions.mode;
      let last: string | null = null;
      let gap = 0;
      for (const m of [...st.messages].reverse()) { // 最近一条 plan 提醒，以及它之后有几次模型请求
        if (m.role === "assistant") {
          gap++;
          continue;
        }
        const kinds = blocks.filter(isReminder).map((b) => planReminderKind(b.text)).filter((k) => k !== null);
        if (kinds.length) {
          last = kinds.at(-1)!;
          break;
        }
      }
      if (mode === PLAN) {
        if (last === null || last === "exit") return new Attachment(..., FULL_TEXT(...)); // 刚进入：完整规则
        if (gap >= SPARSE_EVERY) return new Attachment(..., SPARSE_TEXT(...)); // 每 5 次请求：一句精简提醒
        return null;
      }
      if (last === "full" || last === "sparse") return new Attachment(..., EXIT_TEXT(...)); // 刚退出：明确告诉它可以动手了
      return null;
    };
    ```

=== "Python"

    ```python
    def provide(st):
        mode = st.agent.permissions.mode
        last, gap = None, 0
        for m in reversed(st.messages):          # 最近一条 plan 提醒，以及它之后有几次模型请求
            if m["role"] == "assistant":
                gap += 1
                continue
            kinds = [k for b in blocks if is_reminder(b) and (k := _plan_reminder_kind(b["text"]))]
            if kinds:
                last = kinds[-1]
                break
        if mode == PLAN:
            if last in (None, "exit"):
                return Attachment(..., FULL_TEXT)        # 刚进入：完整规则
            if gap >= SPARSE_EVERY:
                return Attachment(..., SPARSE_TEXT)      # 每 5 次请求：一句精简提醒
            return None
        if last in ("full", "sparse"):
            return Attachment(..., EXIT_TEXT)            # 刚退出：明确告诉它可以动手了
        return None
    ```

三种提醒，对应三种时刻：

- **完整规则**（`# Plan mode is active`）：五步工作流（理解 → 澄清 → 设计 → 写计划文件 → 调 ExitPlanMode）、计划文件的路径、计划应该包含什么（目标、做法、改哪些文件、不做什么、怎么验证）。末尾特意写了「不要在文本里问『这个计划可以吗？』，ExitPlanMode 就是你提问的方式」。没有这一句，模型经常在回复里写完计划，然后停下来等你说「好」，那就又回到了口头约定。
- **精简提醒**（`# Plan mode still active`）：一句话，「只读，除了计划文件，写好了调 ExitPlanMode」。长对话里规则会被稀释，隔一段时间提一句，成本很低。
- **退出提醒**（`# Exited plan mode`）：只在「上一条 plan 提醒不是退出」时发一次。

你可能会问：退出提醒有必要吗？ExitPlanMode 的结果里不是已经说了「可以开始写代码了」？

通过 ExitPlanMode 退出时确实有。但你也可能按 Shift+Tab 直接切走，这时模型的上下文里最后一条规矩还是「你不能改任何东西」。不告诉它，它会继续缩手缩脚，甚至拒绝你的修改请求。演示里两条提醒都出现了，测试 `test_full_then_sparse_then_exit_reminders` 守着「退出提醒只发一次」。

这三种提醒在 Claude Code 里都有对应物。二进制里能看到 `plan_mode` 附件带 `reminderType: "full"`（还有 `"sparse"`），精简版的原文是「Plan mode still active (see full instructions earlier in conversation). Read-only except plan file (…)」；`plan_mode_exit` 附件的原文是「## Exited Plan Mode You have exited plan mode. You can now make edits, run tools, and take actions.」。mini-cc 的触发规则（每 5 次请求一次精简提醒）是我定的，Claude Code 具体隔多久提醒一次我没有找到依据。

和第 9 章所有 provider 一样，它**不记标志位**：模式切换写进了会话文件，提醒也在历史里，provider 每次扫描历史得出结论。所以 `/resume` 一个 plan 模式的会话、或者压缩之后，提醒依然正确。

### 零件三：交接工具

`ExitPlanModeTool.run`：

=== "Node"

    ```ts
    const plan = existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8").trim() : "";
    if (!plan) return new ToolResult(`No plan found. Write your plan to ${path} first, then call ExitPlanMode.`, true);
    const [choice, feedback] = await planCtl.approve(plan);
    if (choice === "auto" || choice === "manual") {
      planCtl.setMode(choice === "auto" ? ACCEPT_EDITS : DEFAULT);
      return new ToolResult("User has approved your plan. You can now start coding. Start with updating your todo " +
        `list if applicable. Your plan has been saved to: ${path} You can refer back to it if ` +
        `needed during implementation.\n\n## Approved Plan:\n${plan}`);
    }
    return new ToolResult("The user reviewed the plan and wants you to keep planning (still in plan mode). " +
      (feedback ? `Their feedback:\n${feedback}` : "Ask what to change if it is unclear."));
    ```

=== "Python"

    ```python
    plan = path.read_text(encoding="utf-8").strip() if path.is_file() else ""
    if not plan:
        return ToolResult(f"No plan found. Write your plan to {path} first, then call ExitPlanMode.", True)
    choice, feedback = plan_ctl.approve(plan)
    if choice in ("auto", "manual"):
        plan_ctl.set_mode(ACCEPT_EDITS if choice == "auto" else DEFAULT)
        return ToolResult("User has approved your plan. You can now start coding. Start with updating your todo "
                          f"list if applicable. Your plan has been saved to: {path} You can refer back to it if "
                          f"needed during implementation.\n\n## Approved Plan:\n{plan}")
    return ToolResult("The user reviewed the plan and wants you to keep planning (still in plan mode). "
                      + (f"Their feedback:\n{feedback}" if feedback else "Ask what to change if it is unclear."))
    ```

你可能会问：为什么计划要放在文件里，而不是作为 ExitPlanMode 的参数传进来？

三个理由：

1. **计划要能反复修改**。被打回之后，模型用 Edit 改计划文件里的一行就行（演示里就是这么做的），不用把整份计划重新输出一遍。这正是第 7 章 Edit 省输出 token 的那个道理。
2. **计划要活得比对话久**。批准之后，计划文件还在磁盘上。上下文被压缩、会话被恢复，模型都能回去读它；你也能拿它去提 PR 描述。
3. **你可以直接改**。计划是一个 markdown 文件，你在编辑器里改完再批准，模型拿到的就是你改过的版本。

批准时的三个选项对应「之后谁来把关」：选 1 切到 acceptEdits，项目内的编辑自动通过（计划已经审过了，再逐个确认是重复劳动）；选 2 切回 default，每个编辑还要你点头；选 3 留在 plan 模式，附一句反馈。批准后的返回文案是照搬 Claude Code 二进制里的原文，最后附上了计划全文，模型不用再去读一遍文件。

`EnterPlanMode` 是反方向的交接：模型自己判断「这个任务太大、方向不清」，主动进入 plan 模式。它不需要你批准（`self_check` 返回 `"allow"`），因为进入 plan 只会让模型自己受到更多限制。进入之后，**同一批工具结果**里就会带上完整规则（provider 在 `tool_result` 触发点也会检查模式），模型下一步就知道该怎么做了。

模式切换走第 5 章的 `set_mode()` → `on_mode_change`，所以每次进出 plan 都记进了会话文件（`{"type": "permission-mode", ...}`）。Shift+Tab 的循环也加上了 plan：`default → acceptEdits → plan → auto`。

### 零件四：只读的 sub agent

第 17 章的内置 agent 类型多了一个 `Plan`：只读的软件架构师，返回「做法、改哪些文件、风险、怎么验证」。完整规则的工作流里建议：大范围的搜索交给 Explore（互不相关的方向可以并行派几个），复杂的设计可以让 Plan 起草，主 agent 自己再对照代码核一遍。

还有一条硬规则，加在 `run_subagent` 里：

=== "Node"

    ```ts
    if (kind.readOnly || parent.permissions.mode === "plan") { // plan 模式下派出的 agent 一律只读
      child.permissions.extraChecks.push(readOnlyCheck);
    }
    ```

=== "Python"

    ```python
    if kind.read_only or parent.permissions.mode == "plan":   # plan 模式下派出的 agent 一律只读
        child.permissions.extra_checks.append(_read_only_check)
    ```

没有这一条，plan 模式就有一个后门：模型派一个 general-purpose agent 去「顺便把代码改了」。子 agent 有自己的 `PermissionManager`，父亲的 `plan_check` 管不到它。测试 `test_subagents_are_read_only_in_plan_mode` 守着这个后门。

## 和 Codex 比一比

Codex（本机 0.153.4）也有 plan 模式，但思路很不一样。从它二进制里的提示词看：

- plan 模式是一种「协作模式」（collaboration mode），进入后模型收到一段很长的说明，大段文字在区分「非修改性动作」（读文件、静态分析、甚至允许跑会写缓存的测试）和「修改性动作」（写文件、跑会改文件的 formatter、打补丁）。
- 计划不写文件，而是在回复里输出一个 `<proposed_plan>` 块，客户端特殊渲染；修订时必须输出一个**完整替换**的新块。
- 提示词里写着「不要在最后问『要我继续吗？』」，用户自己切出 plan 模式、要求实施。
- 程序层能确认的限制是：`update_plan`（它的任务清单工具）在 plan 模式下会直接报错。至于写文件有没有程序层的拦截，我没有验证（推测主要靠提示词：它允许跑会写构建产物的测试，这种细粒度的「能写什么」很难用沙箱表达，所以大概率交给了模型判断）。

两边的取舍很清楚。Codex 信任模型能区分「修改」和「非修改」，换来的是规划阶段更大的自由度（能跑测试、能 dry-run）；Claude Code 和 mini-cc 用权限层兜底，换来的是「批准之前一定没动过代码」这个保证。计划的载体也一样：文本块轻，文件可改、可留存。

我站 Claude Code 这一边。plan 模式的价值恰恰在于那个**保证**：我批准之前，工作区一个字节都没变。没有这个保证，「先规划」就只是一种建议，而建议我本来就可以自己说。

## 测试

`tests/ch21_plan.test.ts`（Python 版 `tests/test_ch21_plan.py`），11 个：

- Shift+Tab 的循环包含 plan；plan 模式下 Read 和只读 Bash 照常、改源码被拒（理由里有计划文件路径）、写计划文件免审批；`npm install` 要问你，你的拒绝理由回到模型。
- 提醒：首次完整规则（含路径和 ExitPlanMode）、第 5 次请求精简提醒、切回 default 后恰好一次退出提醒。
- ExitPlanMode：批准 → acceptEdits、返回原文和计划、之后的编辑免审批、模式变化写进会话；打回 → 留在 plan、反馈回到模型；没有计划文件 → 报错并给出路径。
- 模型主动 EnterPlanMode 后，同一批结果里就带上完整规则；plan 模式下派出的 Plan agent 改不了文件；`/plan <需求>`；离线剧本的 `{plan_file}` 占位符。

第 6 章有一个测试（Node 版 `ch06_auto_mode.test.ts` 从一开始就这样写）原来断言 Shift+Tab 的循环是 `default → acceptEdits → auto`，现在中间多了 plan，改成显式传入第 6 章当时的循环（和第 5 章的做法一样）。

=== "Node"

    ```console
    $ cd /Users/me/agent-learn/code/mini_cc-node && node --test tests/*.test.ts
    ℹ tests 204
    ℹ suites 0
    ℹ pass 204
    ℹ fail 0
    ℹ cancelled 0
    ℹ skipped 0
    ℹ todo 0
    ℹ duration_ms 9534.141084
    ```

=== "Python"

    ```console
    $ cd /Users/me/agent-learn/code/mini_cc && uv run pytest -q
    ........................................................................ [ 35%]
    ........................................................................ [ 70%]
    ............................................................             [100%]
    204 passed in 13.74s
    ```

## 和真实 Claude Code 的差异

- **bypass 下是否拦截**：Claude Code 在可以 bypass 的交互式终端里不强制拦截（你的日常环境正是这种）；mini-cc 始终拦截。
- **计划文件**：Claude Code 放在 `~/.claude/plans/`（可用 `plansDirectory` 改），文件名是随机的几个单词；mini-cc 是 `<home>/plans/<会话 id>.md`。
- **审批选项**：Claude Code 的批准选项还包括「批准并进入 auto 模式」，并且可以按 Ctrl+G 在编辑器里改计划；mini-cc 是三选一，改计划请直接编辑文件。
- **hook**：Claude Code 文档说 plan 模式下 PreToolUse hook 返回 allow 对非只读操作无效。mini-cc 没有 hook，但 `extra_checks` 排在所有放行规则之前，效果类似。

## 对照你的环境

- 你在全局规则里明确不走 brainstorming、writing-plans 那套「产出 implementation.md」的编排。plan 模式和它们不是一回事：它没有仪式，只有一个「先给我看计划、我点头再动手」的节点，计划文件也只是几行字。对 webapp 里跨好几个 feature 目录的改动，这个节点的成本远低于返工。
- 因为你的会话是 bypass 启动的，Claude Code 的 plan 模式在你那里没有硬拦截，只剩提醒、审批和只读子 agent。想体验带拦截的版本，可以用非 bypass 的模式启动，或者就用 mini-cc 的 `/plan`。
- 你的规则「只问会改变做法的那一两个问题」写进了完整规则的第 2 步：「Do not ask about things you can decide with a sensible default」。演示里模型只问了一个问题（默认页大小），因为它会改变接口行为。

## 常见坑

1. **只靠提示词**。模型「知道」不该改，和它「改不了」，是两回事。拦截要放在执行层。
2. **拦截没有给出路**。只说「denied」，模型会换个工具再试（Bash `sed -i`）。要告诉它只能写哪个文件、写完调什么。
3. **切出 plan 不告诉模型**。它会继续按 plan 的规矩缩手缩脚，或者拒绝你的修改请求。
4. **忘了 sub agent 的后门**。子 agent 有自己的权限管理器，父亲的 plan 关卡管不到它。
5. **计划只写在回复里**。被打回后要整份重写；批准后压缩一次就找不到了。

## 练习

1. 实现「批准时可以改计划」：审批界面加一个选项「打开编辑器」，用 `$EDITOR` 打开计划文件，保存后再显示一次审批。模型拿到的 `Approved Plan` 应该是你改过的版本。
2. 批准之后，让模型按计划自动建任务清单（第 11 章）：在 ExitPlanMode 的批准结果里附上「把计划的每一步建成一个任务」，并写一个测试，断言批准后的下一次请求里模型调用了 `TaskCreate`。
3. 开放题：Codex 允许在 plan 模式里跑「会写缓存、但不改受版本控制的文件」的测试，mini-cc 一律要问你。如果要支持「允许写 `.cache/`、`node_modules/.vite/`、`target/`，其他一律拦截」，你会在哪一层实现？只读命令白名单、沙箱、还是事后用 `git status` 检查工作区有没有变？各自的漏洞在哪里？

## 延伸阅读

- 原文：[让 Agent 先规划再动手](https://labuladong.online/zh/ai-coding/coding-agent/plan/)（免费文章，推荐配合阅读）
- Claude Code 权限模式（plan 模式、bypass 下的行为、计划文件位置）：<https://code.claude.com/docs/en/permission-modes>
- Claude Code 工具参考（EnterPlanMode / ExitPlanMode）：<https://code.claude.com/docs/en/tools-reference>
- 本系列：[Plan Mode 是怎么实现的](../p3-agent-internals/11-plan-mode.md)、[工具调用权限审批](05-permission.md)、[让 Agent 主动向你提问](10-ask-user-question.md)、[实现 Sub Agent 机制](17-subagent.md)
- 上一章：[渐进式加载 Skills](20-skill.md)
