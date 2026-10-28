# /goal 命令：给 Agent 设定目标

> 对应原站：[/goal 命令：给 Agent 设定目标](https://labuladong.online/zh/ai-coding/claude-code/goal-command/)（会员内容；本章为独立原创重写）

> **一句话结论**：`/goal` 本质上是一个只在当前会话生效的 prompt 型 Stop hook。每轮结束时，它把「验收条件 + 到目前为止的对话」交给一个不带工具的小模型去判卷。判「没达成」，理由就变成下一轮的指令；判「达成」或「不可能达成」，目标就自动清除。干活的模型和验收的模型是分开的，这一点是整个设计的关键。

## 脚本判不了的「完成」

[上一章](08-hooks.md)写过一个 Stop hook：transcript 里没出现 `passed` 就不许停。这类检查很可靠，但能检查的东西很有限。

你可能会问：「测试覆盖了边界情况没有」「迁移后的每个调用点都改了没有」「文档补齐了没有」，这些判断怎么写成 shell 脚本？

写不出来。这类判断需要「读懂」，而读懂恰好是 LLM 擅长的事。

那让干活的 Claude 自己判断「我做完了没」不就行了？问题就出在这里。Claude 本来就是因为「觉得自己做完了」才停下来的。让同一个上下文里的同一个模型再问自己一遍，大概率还是同样的答案。

`/goal` 的做法是请一个**外人**来验收。

## 一个循环、两个角色

官方文档（<https://code.claude.com/docs/en/goal>）原话说 `/goal` 是「a wrapper around a session-scoped prompt-based Stop hook」。把它拆开画出来：

```d2
direction: down
start: "" {shape: circle; width: 16; height: 16; style.fill: "#333"}
end: "" {shape: circle; width: 16; height: 16; style.fill: "#333"; style.double-border: true}
working: Working
check: Check
judge: Judge
achieved: Achieved
failed: Failed
stalled: Stalled
cleared: Cleared
start -> working: "/goal 条件\n（条件本身就是第一轮指令）"
working -> check: "本轮结束\n（Stop 时机）"
check -> working: "有子 agent / 后台命令还在跑\n→ 本轮跳过评审"
check -> judge: "发送 条件 + 对话\n给 small fast model"
judge -> working: "not yet met\n（reason 作为下一轮指引）"
judge -> achieved: "met →\n清除目标，记录 achieved"
judge -> failed: "impossible →\n清除目标，记录 failed"
working -> stalled: "连续几轮无工具调用 →\n停循环、警告，目标保留"
working -> cleared: "不可恢复错误（鉴权 / 额度\n/ 上下文溢出 / 模型不可用）"
achieved -> end
failed -> end
```

图里有两个角色：

- **Worker**：主会话里的 Claude，带着全部工具和完整上下文干活。
- **Judge**：文档里叫「small fast model」，就是 Haiku 那一档（可以用 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 换掉，但这个变量是全局的，所有后台小任务都会跟着换）。Judge **不调用任何工具**，只能读对话里已经出现过的内容。

Judge 每次只给三种结论之一，并附一句理由：not yet met、met、impossible。这和 prompt 型 hook 的返回格式 `{"ok": false, "reason": "...", "impossible": true}` 是一一对应的（见官方 hooks-guide 的「Prompt-based hooks」一节）。

打个比方：Worker 是装修队，Judge 是甲方。但这个甲方不进屋，只看装修队发到群里的照片和视频。

这个比方点出了两件事：

- 甲方没法自己拿尺子去量，所以验收条件必须写成「照片能证明的」形式。
- 装修队发什么，甲方就只能看到什么。

这个比方在一个地方不成立：真实的 Judge 每轮都是从零开始判，没有「上次已经验过厨房」的记忆。每次它都会重新读一遍完整的条件和对话。

**回到主线**：Judge 也是一个按概率预测下一个 token 的模型，它不比 Worker 聪明。它的优势在于上下文干净：没有「我刚花了 20 轮写这段代码」的沉没成本，只看条件和证据。换了一个上下文，就换来了一次独立的判断。代价是每轮多一次小模型调用，文档说这部分花费「通常可以忽略」。

## 几个容易想错的行为细节

下面这些都出自官方 goal 文档，有几条和直觉不一样：

- **设目标会立即开跑。** `/goal <条件>` 本身就把条件当作第一轮指令，不需要再发一条 prompt。一个会话同时只能有一个目标，新设的会覆盖旧的。
- **条件最长 4,000 字符。** 想限制时长，就直接写进条件里，比如「或者跑满 20 轮就停」。这个子句也由 Judge 读对话来判断，Claude 每轮会汇报自己的进度。
- **后台任务会推迟评审。** 本轮结束时，如果还有子 agent 或后台 shell 在跑，这一轮就不评审。后台任务卡住 30 分钟后会触发一次 check-in，之后的间隔依次翻倍（上限是首次间隔的 4 倍），可以用 `CLAUDE_CODE_GOAL_CHECKIN_MINUTES` 调整。
- **光说不做会被叫停。** Claude 如果连续几轮只「回应」Judge、却不调用任何工具，循环就会停下来并打印警告，目标保留，等你下一次输入后再继续。底层机制就是上一章讲的 Stop hook block cap。
- **错误分两类处理。** 鉴权失败、额度耗尽、自动压缩也救不回来的上下文溢出、模型不可用，这四类错误会直接清除目标。其它错误（过载、断线、限流）只会让目标重试或暂停。
- **它属于 hooks 体系。** 所以要受工作区信任规则的约束；`disableAllHooks: true` 时 `/goal` 不可用，命令会告诉你原因。
- **`/goal` 不改权限模式。** 想让它无人值守地跑，要配合 auto mode。文档的说法是：auto mode 去掉了「每次调用工具都要确认」，`/goal` 去掉了「每一轮都要你发话」。

至于 Judge 拿到的 prompt 具体长什么样，「对话」是全文还是摘要，文档都没有写。下面 demo 里 `renderForJudge()`（Python 版 `render_for_judge()`）的格式是我的**推测**。依据是：文档说发送的是「the condition and the conversation so far」，评审不调工具，只依据 Claude 已经输出到对话里的内容。

## 先跑起来：离线复刻这个循环

[`code/agent-node/goal_demo/goal_loop.ts`](../code/agent-node/goal_demo/goal_loop.ts)（Python 版 [`goal_loop.py`](../code/agent/goal_demo/goal_loop.py)）用一百来行代码复刻了上面那张状态图。Worker 和 Judge 都是可以替换的函数（Node 版允许它们返回 Promise，所以 `runGoal` 是 `async` 的）：

- 离线模式：`scriptedWorker`（`scripted_worker`）按剧本返回每一轮的结果，`keywordJudge`（`keyword_judge`）只在对话里找 `0 failed` 和 `lint clean` 两个证据。
- 真实模式：`makeLlmJudge(new Anthropic())`（Python 版 `make_llm_judge(anthropic.Anthropic())`）发一次无工具的 `claude-haiku-5-5` 调用，用 `output_config.format` 约束模型输出 `{status, reason}` 这个 JSON。本仓库只用 fake client 测过，没有发真实请求。

剧本是这样的：第 1 轮测试还有失败；第 2 轮起了后台 e2e；第 3 轮修好测试；第 4 轮跑 lint。离线 fake 模型，真实输出：

=== "Node"

    ```text
    $ node goal_demo/goal_loop.ts
    turn 1: judge=not_met reason=对话里还没出现证据：0 failed, lint clean
    turn 2: 后台任务未结束 → 跳过评审
    turn 3: judge=not_met reason=对话里还没出现证据：lint clean
    turn 4: judge=met reason=测试与 lint 证据都已出现
    outcome=achieved turns=4 evaluations=3
    ```

=== "Python"

    ```text
    $ uv run python goal_demo/goal_loop.py
    turn 1: judge=not_met reason=对话里还没出现证据：0 failed, lint clean
    turn 2: 后台任务未结束 → 跳过评审
    turn 3: judge=not_met reason=对话里还没出现证据：lint clean
    turn 4: judge=met reason=测试与 lint 证据都已出现
    outcome=achieved turns=4 evaluations=3
    ```

跑了 4 轮，只评审了 3 次，因为第 2 轮有后台任务没结束。第 3 轮的 reason 只剩「lint clean」，Worker 下一轮就照着这个去跑 lint。整个循环的核心就这么几行：

=== "Node"

    ```ts
    const v = await judge(condition, transcript);
    if (v.status === "met")        return { outcome: "achieved", ... };
    if (v.status === "impossible") return { outcome: "impossible", ... };
    directive = v.reason;                     // 理由 = 下一轮指令
    transcript.push({ role: "user", content: `[goal evaluator] ${v.reason}` });
    ```

=== "Python"

    ```python
    v = judge(condition, transcript)
    if v.status == "met":        return GoalResult("achieved", ...)
    if v.status == "impossible": return GoalResult("impossible", ...)
    directive = v.reason                     # 理由 = 下一轮指令
    transcript.append({"role": "user", "content": f"[goal evaluator] {v.reason}"})
    ```

说穿了，就是在 agent 循环外面再套了一层 `while`，退出条件交给另一个模型来判断。reason 被追加到 messages 的末尾，和 Stop hook 返回 `decision: block` + `reason` 是同一种做法。

真实 Judge 的调用长这样（`makeLlmJudge` / `make_llm_judge` 里的代码，没有对真实 API 执行过）：

=== "Node"

    ```ts
    const resp = await client.messages.create({
      model: "claude-haiku-5-5", max_tokens: 1024, system: JUDGE_SYSTEM,
      output_config: { effort: "low", format: { type: "json_schema", schema: JUDGE_SCHEMA } },
      messages: [{ role: "user", content: renderForJudge(condition, transcript) }],
    });   // 注意：没有 tools
    ```

=== "Python"

    ```python
    resp = client.messages.create(
        model="claude-haiku-5-5", max_tokens=1024, system=JUDGE_SYSTEM,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": JUDGE_SCHEMA}},
        messages=[{"role": "user", "content": render_for_judge(condition, transcript)}],
    )   # 注意：没有 tools
    ```

测试：`node --test 'goal_demo/*.test.ts'`，结果 `ℹ pass 4`（Python 版 `uv run pytest -q goal_demo`，结果 `4 passed`）。其中两条覆盖了「连续无工具调用 → stalled」和「impossible → 清除目标」。还有一条断言请求里**没有** `tools` 字段，评审不许动手，这一点写成了测试。

## /goal、Stop hook、/loop 怎么选

| | 下一轮什么时候开始 | 什么时候停 | 作用范围 |
|---|---|---|---|
| `/goal` | 上一轮结束（或 check-in / 自动重试到期） | Judge 判 met / impossible，或你执行 `/goal clear` | 只在当前会话 |
| command 型 Stop hook | 上一轮结束 | 你的脚本决定 | settings 覆盖到的所有会话 |
| prompt 型 Stop hook | 上一轮结束 | 你写的 prompt + 模型决定 | 同上 |
| `/loop` | 固定时间间隔 | 你叫停，或 Claude 自己判断做完了 | 当前会话 |

我的观点：**能写成脚本的验收就别交给 Judge。** 测试通过、lint 干净、文件数达标，这些用 command 型 Stop hook 判断，确定性高，也不花 token。

`/goal` 真正有价值的地方，是那种「需要读懂才能判断，但又说得清」的条件，比如「设计文档第 3 节列的验收标准逐条满足」。最理想的写法是两者叠加：条件里写明「`npm test` exit 0」，让 Claude 必须把测试输出贴进对话，Judge 再在这些证据之上判断那些「软」条件。

## 对照你的环境

- 你在 `~/.claude/CLAUDE.md` 里写过「完成前跑命令贴真实输出」这条铁律。它和 `/goal` 的设计正好互补：Judge 只能读对话，**贴出来的真实输出就是 Judge 唯一的证据**。没贴输出的「已完成」，在 Judge 看来跟没做一样。
- 你的 `Stop` 事件上目前只挂了 `cc-status`，用来刷新 iTerm 状态。`/goal` 的 Judge 是会话级的另一个 Stop hook。两者同时存在时，按 hooks 文档「命中的 hook 并行执行」的规则，状态刷新和评审互不影响。不过这一点我没有在真实会话里观察过（**推测**）。
- `webapp` 的提测流程里有一步是「受影响的 suite + lint」，这一步很适合写成 goal 条件：`/goal apps/web 受影响的 vitest 全绿且 eslint 无 error，不修改任何 *.test.ts 以外的测试配置，或 15 轮后停`。

## 常见坑

1. **条件写得太虚。** 比如「把代码改好」，Judge 没有可以对照的证据，结果要么永远 not met，要么被一句「我改好了」糊弄过去。条件要包含一个可测量的终态，再加上「怎么证明」。
2. **以为 Judge 会自己去跑测试。** 它不会。它不调用工具，只看对话里已经有的东西。
3. **不写约束子句。** 「测试全过」最省事的达成方法之一，就是把失败的测试删掉。条件里要写上「不许修改哪些东西」。
4. **长时间的后台任务把评审一直往后拖。** 子 agent 没跑完，这一轮就不评审，这时候别以为 `/goal` 卡死了。可以执行 `/goal`（不带参数）查看已评审的轮数和最近一次的理由。
5. **用 `-p` 跑时看起来像卡住了。** 默认的文本输出要等循环结束才打印结果。想看到过程，加上 `--output-format stream-json --verbose`。

## 练习

1. 改 `keywordJudge`（`keyword_judge`）：对话里同时出现 `0 failed` 和「删除了测试」时，返回 `not_met`，理由是「不允许删除测试」。补一条测试（`node:test` 或 pytest）。
2. 不用 `/goal`，在测试仓库的 `.claude/settings.local.json` 里写一个 `type: "prompt"` 的 Stop hook，复现同样的「测试全过才许停」。它和 `/goal` 在作用范围、能不能用 `/goal clear` 撤销这两点上有什么区别？
3. （开放题）Judge 和 Worker 用同一族模型，会不会有「同一个模型族的盲区」？如果让 Codex 来当 Judge（异源评审，就像你的 `codex-review`），要改 `goal_loop.ts`（`goal_loop.py`）的哪个接口？这样做的收益和成本各是什么？

## 延伸阅读

- 官方：Keep Claude working toward a goal：<https://code.claude.com/docs/en/goal>
- 官方：Prompt-based hooks：<https://code.claude.com/docs/en/hooks-guide>
- 本库：[Hooks](08-hooks.md)、[Sub Agent](10-sub-agent.md)（背景子 agent 为什么会推迟评审）、[Harness Engineering](../p3-agent-internals/12-harness-engineering.md)
