# Plan Mode 是怎么实现的

> 对应原站：[Plan Mode 是怎么实现的](https://labuladong.online/zh/ai-coding/claude-code/plan-mode/)（会员内容；本章为独立原创重写）

> **一句话结论**：Plan Mode 不是一个新的「模型能力」，而是三种工程手段叠在一起：用指令告诉模型只规划不动手，用权限层挡住除计划文件以外的写操作，用 `ExitPlanMode` 工具把「计划写完了」变成一次需要你点头的交接；负责探索和设计的子 agent 则干脆拿不到写工具。

## 一个反常的发现

上一章我们看到，你的 `defaultMode` 是 `bypassPermissions`。我又翻了你本机所有会话 jsonl 里的 `permission-mode` 记录：13597 条，全部是 `bypassPermissions`。`~/.claude/plans/` 目录是空的。

也就是说，在本机有记录的会话里，你没用过 Plan Mode。

这本身不奇怪，很多重度用户都这样：任务清楚就直接干，不清楚就先聊。但你可能会问：Plan Mode 到底比「先跟它说一句『先别动手，给我个方案』」强在哪？

更有意思的是，官方文档里有一句话，恰好和你的配置有关：**在能用 bypass 的交互式终端会话里，Claude Code 不强制执行 Plan Mode 的拦截**，只是仍然**指示** Claude 先规划不动手。

所以对你来说，「先说一句别动手」和「切 Plan Mode」的差别，可能比你想的要小。我们把它拆开看。

## 三种手段

```d2
shape: sequence_diagram
u: 你
h: Harness
m: 主模型
s: "Explore / Plan 子 agent"
u -> h: "Shift+Tab 切到 plan，或 /plan 前缀"
h -> m: "手段 1：指令「只调研、写计划，不改源码」"
m -> s: "派子 agent 去探索"
s."手段 3：工具集里根本没有 Edit / Write"
s -> m: "调研结论" {style.stroke-dash: 3}
m -> h: "Edit(src/Login.tsx)"
h -> m: "手段 2：权限层拦截（计划文件除外）" {style.stroke-dash: 3}
m -> h: "Write(~/.claude/plans/xxx.md)"
h -> m: "放行" {style.stroke-dash: 3}
m -> h: "ExitPlanMode(计划)"
h -> u: "展示计划：用 auto / 手动审批编辑 / 继续规划"
u -> h: "批准"
h -> h: "退出 plan，切到你选的权限模式"
h -> m: "可以动手了" {style.stroke-dash: 3}
```

### 手段 1：指令

permission-modes 文档对 Plan Mode 的描述是：Claude 读文件、跑 shell 命令去探索、写一份计划，但**不改你的源码**。在 bypass 可用的交互式会话里，文档的原话是「Claude is still instructed to plan without editing」，说明「只规划」首先是一条给模型的指令。

这条指令具体怎么送进上下文的？[prompt-caching 文档](https://code.claude.com/docs/en/prompt-caching)给了答案：Plan Mode 和加载 skill 一样，是把自己的指令**作为对话消息追加**进去的，所以缓存好的前缀保持不变。这也解释了为什么切换权限模式不会让缓存失效（例外是 `opusplan`，它进出 plan 时会换模型）。

至于这条消息长什么样、是不是每轮都提醒一次，文档没说。我在本机 jsonl 里看到过很多类似的「模式提醒」机制，比如 `auto_mode`、`task_reminder` 这类 attachment，它们以 system 角色渲染、附在对话里，推测 Plan Mode 的提醒也是这种形式。（推测，本机没有 plan 模式的会话记录可以核对。）

### 手段 2：权限层拦截

文档写明：除 bypass 可用的交互式终端外，**编辑会一直被挡住，直到你批准计划**。shell 命令则分三种情况：

- bypass 可用的交互式终端：分类器和询问都不适用，命令直接跑。
- auto 模式可用且 `useAutoModeDuringPlan` 开着（默认开）：由分类器审查命令，通过的执行，不通过的拦下。
- 都不满足：内置只读命令集之外的命令都要问你。

还有一条很细的：在 Plan Mode 下，除了 `ExitPlanMode` 本身，你的 PreToolUse hook 返回 `allow` **对非只读操作不起作用**。也就是说，hook 不能帮模型绕过 Plan Mode。

那计划写到哪？受保护路径那一节列了例外：当前会话自己的计划文件，位置是 `~/.claude/plans/`，或者你用 `plansDirectory` 设置的目录。所以「只能写计划文件」也是权限层的规则，不只是一句提示。

### 手段 3：子 agent 拿不到写工具

这一条在你自己的会话里就能看到。Claude Code 给模型的 Agent 工具说明里列了内置的子 agent 类型，其中：

- `Explore`：只读的搜索 agent。
- `Plan`：软件架构师 agent，用来设计实现方案。

两者的工具说明一模一样：「除 Agent、Artifact 系列、ExitPlanMode、Edit、Write、NotebookEdit 之外的所有工具」。

这是最硬的一种约束：**工具根本不在它的 tools 数组里**，模型想改也没有可调的工具。比起「给了工具再拦」，这既更可靠，也更省 token（少几个工具定义）。

### 交接：ExitPlanMode

tools-reference 文档把 `ExitPlanMode` 描述为「展示计划供审批并退出 plan 模式」，它是需要权限的工具；还有一个 `EnterPlanMode`，不需要权限，模型可以自己进入。

批准时你有几个选项：批准并进入 auto 模式（如果是 bypass 启动的会话，这一项变成切到 bypass）、批准但每个编辑手动审批、继续规划。批准之后，会话退出 plan，切到你选的模式。按 `Ctrl+G` 还能在编辑器里直接改计划。

你可能会问：为什么要用一个「工具调用」来交接，而不是让模型直接说「我写完了」？

因为工具调用是**结构化的、程序能识别的**。模型说一句「方案如下」，程序分不清它是写完了还是在中途自言自语；调用 `ExitPlanMode`，程序就确切知道「该停下来让人审了」，可以弹出审批界面、等你决定、再切换模式。这和第 4 章 Edit 的设计是一个道理：把模型的意图变成程序能检查的结构。

回到主线：Plan Mode 在上下文里加了一条指令，在上下文**之外**加了权限拦截和工具裁剪。它说明了一个规律：**单靠上下文里的指令不够可靠，要配合程序层的约束**。这也是下一章 Harness Engineering 的核心。

## 动手：三种手段的最小组合

=== "Node"

    ```ts
    const ALL_TOOLS = ["Read", "Grep", "Bash", "Edit", "Write", "Agent", "ExitPlanMode"];
    const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
    const PLAN_FILE = "~/.claude/plans/session-abc.md";
    const REMINDER = "<system-reminder>Plan mode is active. Do not edit source files. " +
      "Explore, then write your plan to " + PLAN_FILE + " and call ExitPlanMode.</system-reminder>";

    class Harness {
      mode = "plan";
      messages: { role: string; content: { type: string; text: string }[] }[] = [];

      // 手段 1：每轮往上下文里塞提醒（prompt 层）
      buildTurn(userText: string): void {
        const content = [{ type: "text", text: userText }];
        if (this.mode === "plan") content.push({ type: "text", text: REMINDER });
        this.messages.push({ role: "user", content });
      }

      // 手段 2：执行层拦截，只放行写 plan 文件（程序层）
      runTool(name: string, args: Record<string, string>): string {
        if (this.mode === "plan" && WRITE_TOOLS.has(name) && args.file_path !== PLAN_FILE)
          return `✘ ${name} blocked: plan mode, only ${PLAN_FILE} is writable`;
        if (name === "ExitPlanMode") {
          const ok = inputFromUser(args.plan);
          if (ok) {
            this.mode = "acceptEdits";
            return "✔ User approved the plan. You can now edit files.";
          }
          return "✘ User rejected the plan: keep planning.";
        }
        return `✔ ${name} ok`;
      }

      // 手段 3：给探索/设计用的子 agent 直接不给写工具（工具集裁剪）
      static subagentTools(agentType: string): string[] {
        if (["Explore", "Plan"].includes(agentType))
          return ALL_TOOLS.filter((t) => !WRITE_TOOLS.has(t) && t !== "Agent" && t !== "ExitPlanMode");
        return ALL_TOOLS;
      }
    }

    function inputFromUser(plan: string): boolean {
      console.log("   [user sees plan]", plan.split("\n")[0], "→ approve");
      return true;
    }

    const h = new Harness();
    h.buildTurn("把登录页的错误提示改成 i18n");
    console.log("reminder injected:", JSON.stringify(h.messages.at(-1)).includes("Plan mode is active"));
    console.log("Explore subagent tools:", Harness.subagentTools("Explore"));
    for (const [name, args] of [["Grep", { pattern: "errorMsg" }],
                                ["Edit", { file_path: "src/Login.tsx" }],
                                ["Write", { file_path: PLAN_FILE }],
                                ["ExitPlanMode", { plan: "# Plan: Login i18n\n1. 抽 key 2. 替换文案" }],
                                ["Edit", { file_path: "src/Login.tsx" }]] as const)
      console.log(`⏺ ${name}`, "→", h.runTool(name, args as Record<string, string>));
    console.log("mode now:", h.mode);
    ```

=== "Python"

    ```python
    ALL_TOOLS = ["Read", "Grep", "Bash", "Edit", "Write", "Agent", "ExitPlanMode"]
    WRITE_TOOLS = {"Edit", "Write", "NotebookEdit"}
    PLAN_FILE = "~/.claude/plans/session-abc.md"
    REMINDER = ("<system-reminder>Plan mode is active. Do not edit source files. "
                "Explore, then write your plan to " + PLAN_FILE + " and call ExitPlanMode.</system-reminder>")

    class Harness:
        def __init__(self):
            self.mode, self.messages = "plan", []

        # 手段 1：每轮往上下文里塞提醒（prompt 层）
        def build_turn(self, user_text):
            content = [{"type": "text", "text": user_text}]
            if self.mode == "plan":
                content.append({"type": "text", "text": REMINDER})
            self.messages.append({"role": "user", "content": content})

        # 手段 2：执行层拦截，只放行写 plan 文件（程序层）
        def run_tool(self, name, args):
            if self.mode == "plan" and name in WRITE_TOOLS and args.get("file_path") != PLAN_FILE:
                return f"✘ {name} blocked: plan mode, only {PLAN_FILE} is writable"
            if name == "ExitPlanMode":
                ok = input_from_user(args["plan"])
                if ok:
                    self.mode = "acceptEdits"
                    return "✔ User approved the plan. You can now edit files."
                return "✘ User rejected the plan: keep planning."
            return f"✔ {name} ok"

        # 手段 3：给探索/设计用的子 agent 直接不给写工具（工具集裁剪）
        @staticmethod
        def subagent_tools(agent_type):
            if agent_type in ("Explore", "Plan"):
                return [t for t in ALL_TOOLS if t not in WRITE_TOOLS | {"Agent", "ExitPlanMode"}]
            return ALL_TOOLS

    def input_from_user(plan):
        print("   [user sees plan]", plan.splitlines()[0], "→ approve")
        return True

    h = Harness()
    h.build_turn("把登录页的错误提示改成 i18n")
    print("reminder injected:", "Plan mode is active" in str(h.messages[-1]))
    print("Explore subagent tools:", h.subagent_tools("Explore"))
    for name, args in [("Grep", {"pattern": "errorMsg"}),
                       ("Edit", {"file_path": "src/Login.tsx"}),
                       ("Write", {"file_path": PLAN_FILE}),
                       ("ExitPlanMode", {"plan": "# Plan: Login i18n\n1. 抽 key 2. 替换文案"}),
                       ("Edit", {"file_path": "src/Login.tsx"})]:
        print(f"⏺ {name}", "→", h.run_tool(name, args))
    print("mode now:", h.mode)
    ```

===! "Node"

    ```text
    ❯ node plan_mode_demo.ts
    reminder injected: true
    Explore subagent tools: [ 'Read', 'Grep', 'Bash' ]
    ⏺ Grep → ✔ Grep ok
    ⏺ Edit → ✘ Edit blocked: plan mode, only ~/.claude/plans/session-abc.md is writable
    ⏺ Write → ✔ Write ok
       [user sees plan] # Plan: Login i18n → approve
    ⏺ ExitPlanMode → ✔ User approved the plan. You can now edit files.
    ⏺ Edit → ✔ Edit ok
    mode now: acceptEdits
    ```

=== "Python"

    ```text
    ❯ uv run python plan_mode_demo.py
    reminder injected: True
    Explore subagent tools: ['Read', 'Grep', 'Bash']
    ⏺ Grep → ✔ Grep ok
    ⏺ Edit → ✘ Edit blocked: plan mode, only ~/.claude/plans/session-abc.md is writable
    ⏺ Write → ✔ Write ok
       [user sees plan] # Plan: Login i18n → approve
    ⏺ ExitPlanMode → ✔ User approved the plan. You can now edit files.
    ⏺ Edit → ✔ Edit ok
    mode now: acceptEdits
    ```

（纯本地运行，「模型」的工具调用序列是写死的，用户审批也是写死的。）

三种手段分别对应代码里的 `build_turn`（指令）、`run_tool` 里的拦截（权限层）、`subagent_tools`（工具裁剪），Node 版对应 `buildTurn` / `runTool` / `subagentTools`。拦截发生在模型**已经决定**要改文件之后，指令和裁剪则在它做决定之前起作用。

## 对照你的环境

把文档的规则套到你的配置上：

- 你的会话是 bypass 启动的交互式终端，属于「bypass 可用」的情况。文档说这时 Plan Mode 的拦截**不强制执行**：Claude 仍被指示只规划，但它要是真的去改文件或者跑写操作的命令，会直接执行、不会弹窗（明确的 ask 规则和关键路径的 `rm` 除外，而你没有 ask 规则）。
- 所以在你的环境里，Plan Mode 实际上退化成「手段 1 + 手段 3 + 交接」：一条指令、只读的子 agent、一个审批步骤。手段 2 那道最硬的闸不在。
- 如果你想要有硬拦截的 Plan Mode，文档给了路子：在非交互的 `-p` 运行、Agent SDK 会话、VS Code 扩展的聊天面板里，Plan Mode 都保留拦截；或者用非 bypass 的模式启动会话。
- 你在 CLAUDE.md 里明确不走 brainstorming、writing-plans 那套 7 步编排，「拿到需求直接：定位 → 只问会改变做法的问题 → 失败测试 → 实现」。我认可这个决定，但 Plan Mode 和那套编排不是一回事：它很轻，只是「先给我看计划，我点头再动手」。对 webapp 里改动面大、要跨好几个 feature 目录的需求，切一次 Plan Mode 的成本很低。
- 想让规划阶段用更强的模型，可以用 `opusplan` 这个模型别名：Plan Mode 用 Opus，执行时用 Sonnet。不过官方 prompt caching 文档提醒，每次切换都是一次模型切换，会让缓存失效。

## 回到开头的问题

Plan Mode 比「先跟它说别动手」强在哪？强在另外两样东西：权限层的硬拦截，和一个结构化的审批交接。但在你 bypass 启动的会话里，硬拦截被关掉了，剩下的优势是交接流程和只读子 agent。要不要用，取决于你是否需要那个「批准后才动手」的明确节点。

## 常见坑

1. **在 bypass 会话里以为 Plan Mode 有硬拦截**：文档明说不强制。需要硬拦截就换个方式启动。
2. **以为 hook 能在 Plan Mode 里放行编辑**：除 `ExitPlanMode` 外，hook 的 allow 对非只读操作无效。
3. **计划文件写到了项目目录**：默认在 `~/.claude/plans/`，想放项目里用 `plansDirectory`。
4. **频繁切 opusplan**：每次切换都是模型切换，缓存要重写。
5. **把 Plan Mode 当需求澄清**：它只保证「先计划后动手」，不保证计划对。审计划的是你。

## 练习

**1.** 给玩具 harness 加上「拒绝计划」分支：`input_from_user` 返回 False 时，模式保持 plan，模型收到反馈后继续规划。

<details>
<summary>提示</summary>

拒绝分支其实已经写在 `run_tool` 里了（`"✘ User rejected the plan: keep planning."`），缺的是让它跑得到：`input_from_user`（Node：`inputFromUser`）写死了返回 True。把它改成可注入的，比如 `Harness(approver=...)`，或者给一个返回值队列 `[False, True]`。拒绝时最好把用户的意见也拼进返回的结果里，模型才知道往哪改。

预期：第一次 `ExitPlanMode` 之后 `mode` 仍是 `plan`，下一次 `build_turn` 照样注入提醒，紧跟着的 Edit 仍然被拦；改完计划第二次 `ExitPlanMode` 通过，`mode` 变成 `acceptEdits`。

</details>

**2.** 把手段 1 的提醒改成「只在第一轮注入」，写一个假模型：上下文里没有提醒时有 30% 概率调用 Edit。对比「每轮提醒」和「只提醒一次」下被拦截的次数。

<details>
<summary>提示</summary>

在 `build_turn` 里只在第一次调用时 append `REMINDER`。假模型要看的是「最近这条 user 消息里有没有提醒」，不是整个 `messages`：只提醒一次时，那条提醒其实一直留在历史里，按整个上下文判断的话两种方案就没区别了。这本身就值得想一想：真实模型对很久以前的一条提醒会越来越不在意，用「最近几轮有没有」来近似更贴近现实。

用固定种子的 `random.Random(seed)` 跑同样多轮，数 `run_tool` 返回 blocked 的次数。预期：每轮提醒时拦截很少（取决于你给「有提醒」设的概率），只提醒一次时大约是轮数的 30%。但两种情况下 Edit 都被手段 2 拦住了，文件没被改，差别只在浪费的轮次。再想想 bypass 会话里手段 2 不在，这个数就是真实的改动次数。

</details>

**3.** 开放题：手段 3（不给工具）比手段 2（给了再拦）更可靠，那为什么主 agent 在 Plan Mode 下不也直接拿掉 Edit / Write？（提示：想想计划文件，想想退出 plan 之后的缓存。）

<details>
<summary>提示</summary>

两个原因。一是主 agent 得写计划文件：Plan 模式下它唯一允许的写就是 `PLAN_FILE`，拿掉 Write 就写不了。二是缓存：tools 排在缓存前缀的最前面（第 2 章），进 plan 时拿掉工具、退出时再加回来，等于两次改动前缀的最前段，后面整段历史的缓存全部失效；权限层拦截不动请求本身，前缀纹丝不动。

子 agent 没这个问题，它是新起的上下文，本来就没有缓存可失效，裁剪工具几乎零成本。代价是主 agent 这边只能靠「给了再拦」，可靠性全押在拦截那道闸上，而你 bypass 启动的会话里，这道闸恰好不在。

</details>

## 延伸阅读

- 权限模式（Plan Mode、bypass 下的行为、受保护路径）：https://code.claude.com/docs/en/permission-modes
- 工具参考（EnterPlanMode / ExitPlanMode）：https://code.claude.com/docs/en/tools-reference
- 模型配置（opusplan）：https://code.claude.com/docs/en/model-config
- 子 agent：https://code.claude.com/docs/en/sub-agents
- 本库：[上一章 权限检查](10-permission-check.md)、[下一章 Harness Engineering](12-harness-engineering.md)、[Sub Agent](../p1-tools/10-sub-agent.md)、[mini Claude Code：先规划再动手](../p4-mini-cc/21-plan.md)
