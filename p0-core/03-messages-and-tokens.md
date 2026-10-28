# 上下文是什么？token 怎么计费？

> 对应原站：[上下文是什么？token 怎么计费？](https://labuladong.online/zh/ai-coding/basics/messages-and-tokens/)（免费文章，推荐配合阅读；本章为独立原创课文）

> **一句话结论**：上下文就是每次请求都完整重发的那个 `messages` 数组。模型没有状态，历史越长，每轮的输入就越多。Prompt Cache 让「前缀不变、只在末尾追加」的请求便宜一个数量级，所以 Agent 设计的第一条经济纪律是：**别动前缀**。

## 一个会话开了一整天，每句话都要重发几十万 token？

先说一组你自己的数字。

你在 webapp 目录下有一个会话，跑了很久（就是 `~/.claude/projects/-Users-me-work-webapp/` 下最大的那个 jsonl）。本章的统计脚本扫完它和它的 6 个 subagent 文件，得出的结论是：**平均每次请求，模型要读约 46.8 万个输入 token。**

你可能会问：我每次只打了一句话，为什么模型要读 46 万 token？

这个问题拆开是两个：

1. 为什么每次都要重发全部历史？
2. 重发了这么多，钱为什么没有爆炸？

第一个问题的答案是「模型无状态」，第二个的答案是「前缀缓存」。

## 模型是纯函数，记忆在调用方手里

你写 React 写得多，应该对这件事很熟悉：一个纯函数组件不记得上一次渲染。同样的 props 进去，同样的 UI 出来；所谓「状态」，都是外面通过 props 或 state 传进来的。

LLM 的推理也是这样。参数只读，两次请求之间没有任何共享。它「记得」你刚才说的话，唯一的原因是客户端把刚才那句话又放进了这一次请求。

所以一次多轮对话在线上长这样：

```d2
shape: sequence_diagram
c: "客户端（维护 messages）"
s: "API（无状态模型 + 前缀缓存）"
c -> s: "[system, tools, u1]"
s -> c: "a1 （前缀第一次出现：写入缓存）" {style.stroke-dash: 3}
c."messages.push(a1, u2)"
c -> s: "[system, tools, u1, a1, u2]"
s."前缀 system..u1 命中，只新算 a1、u2"
s -> c: a2 {style.stroke-dash: 3}
c."messages.push(a2, tool_result)"
c -> s: "[system, tools, u1, a1, u2, a2, tool_result]"
s."前缀 system..u2 命中，只新算 a2、tool_result"
s -> c: a3 {style.stroke-dash: 3}
c."如果中途改了 system 里一个字 → 从那个字往后全部重算"
```

图注：每一次请求都是完整的历史，客户端只往末尾 push。消息有四种身份：`system`（规则）、`user`（你说的话和工具结果）、`assistant`（模型说的话和工具调用），以及工具定义 `tools`。

类比在这里有个地方不成立：React 重渲染很便宜，可以随便来；LLM 每多读一个 token 都要算力、要钱。于是有了第二个问题。

## token：计费的唯一单位

API 按 token 收费。输入和输出分开定价，输出贵得多：`claude-opus-5-5` 输入每百万 token $4，输出 $20，是输入的 5 倍。为什么输出更贵，[下一章](./04-llm-token-prediction.md) 从 GPU 的角度解释。

每次响应都带着一个 `usage` 字段，告诉你这次用了多少。Anthropic 把输入拆成了三份：

```d2
direction: right
p: 这次请求的全部输入
r: "cache_read_input_tokens\n命中缓存的旧前缀\nOpus 5.5：0.05× 输入价"
w: "cache_creation_input_tokens\n本次新写入缓存的部分\n5 分钟 TTL 1.25× · 1 小时 TTL 2×"
n: "input_tokens\n最后一个缓存断点之后的尾巴\n1×"
o: "output_tokens\n模型生成的（含思考）\nOpus 5.5：5× 输入价"
p -> r
p -> w
p -> n
```

注意：`input_tokens` **不是**「输入总量」，只是没走缓存的那一小截。模型实际读到的输入总量，是三项相加。OpenAI 和 DeepSeek 的 `prompt_tokens` 是总量口径，两家的数字不能直接比。

## Prompt Cache：前缀像一条 git 提交链

你可能会问：每轮重发的内容 99% 都和上一轮一样，服务端就不能把算过的部分存起来吗？

可以，这就是 **Prompt Cache**（提示缓存）。服务端把一段前缀的中间计算结果保存一段时间，下一次请求如果开头一模一样，这一段就直接复用，按很低的价格计费。

它的匹配规则最像 **git 的提交链**：每个 commit 的哈希都依赖它所有的祖先。你改了第 3 个 commit，第 3 个之后的哈希就全变了，哪怕后面的 diff 一个字没动。Prompt Cache 也一样，从改动的那个字节开始，后面所有内容都算未命中。渲染顺序是 `tools` → `system` → `messages`，所以改工具列表的代价最大，改最后一条消息的代价最小。

这个类比在一处不成立：git rebase 只是重算哈希，几乎不花钱；缓存失效则要把几十万 token 重新算一遍，按写入价付钱。

缓存还有几条细则（核对自 `claude-api` skill）：

- **写入要加价**。5 分钟 TTL 是输入价的 1.25 倍，1 小时 TTL 是 2 倍，写进去的内容要靠后面的命中来摊平。按 5 分钟 TTL、命中价 0.1× 算，同一前缀用 2 次就回本（1.25 + 0.1 = 1.35，不开缓存是 2）；1 小时 TTL 要用 3 次（2 + 0.2 = 2.2 < 3）。在 Opus 5.5 上命中价只有 0.05×，回本更快。
- **两种开法**。一种是在某个 content block 上放 `cache_control` 显式断点，一种是在请求顶层放 `cache_control: {type: "ephemeral"}` 开**自动缓存**：服务端把断点放在最后一个可缓存块上，随着对话增长自动前移。一个请求最多 4 个断点。
- **太短不缓存，而且不报错**。最小可缓存长度随模型不同，在 512 到 4096 token 之间（skill 记载 Opus 5.5 / Sonnet 5.5 / Haiku 5.5 是 512，并注明以官方文档为准）。不够长的前缀只会静默地显示 `cache_creation_input_tokens: 0`。
- **中途插指令别改 system**。新一代模型支持在 `messages` 里追加一条 `role: "system"` 消息。这样能下达新指令，又不破坏前缀。

**回到主线**：这一章把「上下文」落到了一个具体的数据结构上。主线上的每一项技术，从此都可以翻译成对这个数组的操作：Agent 循环是在末尾追加 `tool_use` 和 `tool_result`；压缩是把前半段替换成摘要（省了窗口，但替换点之后的缓存全部失效）；Sub Agent 是另开一个新数组干活，只把结论带回来。Prompt Cache 则给所有这些设计加了一条经济上的硬约束：只追加，不修改前缀。

## 动手：算一算你自己的会话账单

Claude Code 把每次 API 响应的 `usage` 原样写进了会话 jsonl（存储格式见 [你的聊天记录存在哪](../p1-tools/07-session-storage.md)）。脚本 [`code/agent-node/core/usage_stats.ts`](../code/agent-node/core/usage_stats.ts)（Python 版 [`usage_stats.py`](../code/agent/core/usage_stats.py)）只读每条 assistant 记录的 `message.model`、`message.id`、`message.usage` 这三个字段，**不读也不打印任何会话正文**，最后只输出汇总数字。

先看结果（对本机真实会话只读运行；价格是第一方 API 标价，你实际走的渠道另计，这里重在看比例）：

=== "Node"

    ```text
    $ S=~/.claude/projects/-Users-me-work-webapp/<session-id>
    $ node core/usage_stats.ts $S.jsonl $S/subagents/*.jsonl
    扫描 7 个文件（只读 usage 字段）
    价格表：claude-api skill，第一方 API 标价，cached 2026-10-06（Vertex 等合作方渠道另计价）
    model                  请求       未缓存输入           缓存读        写5m         写1h         输出     命中率       实际$      无缓存$
    claude-sonnet-5-5    2025       4,050   936,809,389  5,487,054   5,000,585  1,604,497   98.9%    237.13   1910.65
    合计（有价目的模型）：实际 ≈ $237.13，若无缓存 ≈ $1910.65，缓存省了 87.6%
    去重掉的重复行：2456；解析失败行：0
    ```

=== "Python"

    ```text
    $ S=~/.claude/projects/-Users-me-work-webapp/<session-id>
    $ uv run python -m core.usage_stats $S.jsonl $S/subagents/*.jsonl
    扫描 7 个文件（只读 usage 字段）
    价格表：claude-api skill，第一方 API 标价，cached 2026-10-06（Vertex 等合作方渠道另计价）
    model                  请求       未缓存输入           缓存读        写5m         写1h         输出     命中率       实际$      无缓存$
    claude-sonnet-5-5    2025       4,050   936,809,389  5,487,054   5,000,585  1,604,497   98.9%    237.13   1910.65
    合计（有价目的模型）：实际 ≈ $237.13，若无缓存 ≈ $1910.65，缓存省了 87.6%
    去重掉的重复行：2456；解析失败行：0
    ```

几个关键实现：

=== "Node"

    ```ts
    // 单位：美元 / 百万 token。来源：claude-api skill「Current Models」表（cached: 2026-10-06），第一方 API 标价。
    // cache_read 一列：Opus 5.5 / Sonnet 5.5 的 $0.20 是 skill 里写明的；其余按 skill 的一般规则「≈0.1× 输入价」推算，标 *。
    export const PRICES: Record<string, Price> = {
      "claude-opus-5-5":   { input: 4.0, output: 20.0, cache_read: 0.2 },
      "claude-opus-5":     { input: 5.0, output: 25.0, cache_read: 0.5 },   // *
      "claude-sonnet-5-5": { input: 2.0, output: 10.0, cache_read: 0.2 },
      "claude-haiku-5-5":  { input: 0.1, output: 0.5,  cache_read: 0.01 },  // * 且只适用于 ≤100K 的提示
    };
    const WRITE_5M = 1.25;
    const WRITE_1H = 2.0;
    ```

=== "Python"

    ```python
    # 单位：美元 / 百万 token。来源：claude-api skill「Current Models」表（cached: 2026-10-06），第一方 API 标价。
    # cache_read 一列：Opus 5.5 / Sonnet 5.5 的 $0.20 是 skill 里写明的；其余按 skill 的一般规则「≈0.1× 输入价」推算，标 *。
    PRICES: dict[str, dict[str, float]] = {
        "claude-opus-5-5":   {"input": 4.00, "output": 20.00, "cache_read": 0.20},
        "claude-opus-5":     {"input": 5.00, "output": 25.00, "cache_read": 0.50},   # *
        "claude-sonnet-5-5": {"input": 2.00, "output": 10.00, "cache_read": 0.20},
        "claude-haiku-5-5":  {"input": 0.10, "output": 0.50,  "cache_read": 0.01},   # * 且只适用于 ≤100K 的提示
    }
    WRITE_5M, WRITE_1H = 1.25, 2.0
    ```

按 `message.id` 去重的那几行：

=== "Node"

    ```ts
    // 一次 API 响应会按 content block 拆成多行写进 jsonl，每行带同一份 usage → 按 message.id 去重
    const mid: string | undefined = msg.id;
    if (mid && seen.has(mid)) {
      rep.duplicateLines += 1;
      continue;
    }
    ```

=== "Python"

    ```python
    # 一次 API 响应会按 content block 拆成多行写进 jsonl，每行带同一份 usage → 按 message.id 去重
    mid = msg.get("id")
    if mid in seen:
        rep.duplicate_lines += 1
        continue
    ```

这一步去重很关键。同一个会话不去重会数出 4481 次「请求」，估算费用变成 $545.02，是去重后的 2.3 倍，因为有 2456 行是同一次响应的重复记录。我验证过，同一个 `message.id` 的多行 `usage` 完全相同，所以按 id 只取一次就对了。另外，`model` 为 `<synthetic>` 的记录是 Claude Code 在本地合成的消息，没有打 API，要跳过。

写入还要分 TTL 来算。新版记录的 `usage.cache_creation` 里带有 `ephemeral_5m_input_tokens` 和 `ephemeral_1h_input_tokens` 两个拆分；老记录没有这个拆分，脚本就按默认的 5 分钟来算。

读这张表能得到三个结论：

- **命中率 98.9%**。Claude Code 的前缀极其稳定，46 万 token 的上下文里，每轮真正新写入的只有几千。
- **缓存省了 87.6%**。不开缓存的话，这个会话按标价要 $1910；实际是 $237。
- **剩下的钱主要花在「读缓存」上**。拆开算：缓存读 $187.36，占 79%；两种写入合计 $33.7；输出只有 $16。即便单价打到一折，一个 46 万 token 的上下文被读两千次，依然是大头。这就是为什么长会话该压缩、新任务该开新会话：省下的不只是窗口，还有那 79%。

还有一个实测观察：这个会话主线程的缓存写入里，1 小时 TTL 和 5 分钟 TTL 都有（约 500 万 vs 432 万）；6 个 subagent 的写入则**全是 5 分钟 TTL**。Claude Code 是按什么规则选 TTL 的，我没有查到文档，这里只记录现象。

测试 [`core/usage_stats.test.ts`](../code/agent-node/core/usage_stats.test.ts)（Python 版 `core/tests/test_usage_stats.py`）用一份合成的 jsonl 覆盖了去重、`<synthetic>`、坏行、TTL 拆分和费用公式，并断言输出里不会出现正文；Node 版另有一个用例在临时目录里造会话文件，验证不带参数时取的是最大的那个。

## 对照你的环境

- **SessionStart 注入的内容在前缀里**。`inject-guardrails.sh` 注入的护栏在会话开头，之后不再变，所以只付一次写入费，之后每轮按命中价读取。反过来，如果哪个 hook 每轮都往**前缀**里塞带时间戳的内容，缓存就会每轮失效。动态内容应该追加在末尾，UserPromptSubmit hook 的 `additionalContext` 就是跟着当轮消息走的。
- **「常驻层是稀缺资源」的计费含义**。你 CLAUDE.md 里这句话，从账单上看就是：常驻层每多 1000 token，每个新会话多付一次写入费，之后**每一轮**再多付一次读取费。以上面那个会话两千次请求来算，1000 token 的常驻内容就要被读 200 万次。
- **想看任何一个会话**：`node core/usage_stats.ts <path.jsonl>`（Python 版 `uv run python -m core.usage_stats <path.jsonl>`）。不带参数时，默认读 webapp 项目目录下最大的那个会话。

## 常见坑

1. **把 `input_tokens` 当成输入总量**。它只是缓存断点之后的尾巴，总量要三项相加。
2. **统计 jsonl 不去重**。同一次响应会拆成多行，费用会被算成好几倍。
3. **在 system 里放会变的东西**，比如当前时间、请求 ID、没排序的 JSON。每轮都会让整个前缀失效。
4. **以为加了 `cache_control` 就一定缓存**。前缀不够最小长度时，静默不缓存。
5. **中途改工具列表**。tools 排在最前面，改了它，后面所有内容都要重算。

> ⚠️ 价格与口径说明：表中 Opus 5.5 / Sonnet 5.5 的缓存读价 $0.20 取自 `claude-api` skill 的原文；Opus 5 和 Haiku 5.5 的缓存读价是按 skill 里「≈0.1× 输入价」这条一般规则推算的，脚本里标了 `*`。Haiku 5.5 的 $0.10 / $0.50 只适用于 ≤100K token 的提示，超过后是 $0.50 / $2.50。第三方的对照：DeepSeek 英文定价页（2026-10-21 查）的标价是输入未命中 $0.15、命中 $0.003、输出 $0.60 每百万 token（非高峰时段），命中价约为未命中的 1/50；高峰时段（UTC 01–04、06–10）价格翻倍。

## 练习

**1.** 你让 Claude 帮忙写 webapp 的一个 hook，它每轮都把「当前时间」写进 system prompt 的开头。会有什么后果？怎么改？

<details>
<summary>参考答案</summary>

system 位于前缀最前面（只排在 tools 之后），每轮内容都不同，等于每轮从开头起前缀就变了，缓存全部失效。所有历史都要按写入价重新计费，首字延迟也会明显变长。改法：system 保持字节级不变；时间这类动态信息追加在末尾，放进最新一条 user 消息，或者在新模型上追加一条 messages 内的 `role: "system"` 消息；缓存断点放在稳定前缀之后。

</details>

**2.** 用 Opus 5.5 的价格（输入 $4，缓存读 $0.20，即 0.05×）重算回本点：5 分钟 TTL 和 1 小时 TTL 下，一段前缀分别要被用几次，开缓存才划算？

<details>
<summary>参考答案</summary>

5 分钟 TTL：用 1 次时 1.25× > 1×，亏；用 2 次时 1.25 + 0.05 = 1.30× < 2×，已经划算。1 小时 TTL：用 2 次时 2 + 0.05 = 2.05× > 2×，还差一点；用 3 次时 2 + 0.10 = 2.10× < 3×，划算。所以 1 小时 TTL 只适合「请求间隔超过 5 分钟、但会被反复命中」的前缀。

</details>

**3.** 给 `usage_stats.py` 加一个 `--per-turn` 选项：按时间顺序输出每次请求的「输入总量」和「命中率」（只输出数字），找出你会话里命中率突然掉到很低的那几轮，再结合你当时做了什么（`/compact`？切换模型？改了 MCP？）解释原因。

**4.**（开放题）上面那个会话 79% 的钱花在读缓存上。如果由你给 Claude Code 设计一条「该开新会话了」的提示规则，你会用什么信号触发？累计读缓存的 token 数？上下文长度？任务边界？说说各自的误报场景。

## 延伸阅读

- 原站文章：[上下文是什么？token 怎么计费？](https://labuladong.online/zh/ai-coding/basics/messages-and-tokens/)
- Anthropic：[Prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)、[Pricing](https://docs.claude.com/en/docs/about-claude/pricing)、[Token counting](https://docs.claude.com/en/docs/build-with-claude/token-counting)
- DeepSeek：[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)

## 相关章节

- 上一篇：[如何调用 LLM 接口](./02-api-and-apikey.md)
- 下一篇：[LLM 是怎么预测下一个 token 的](./04-llm-token-prediction.md)（KV cache 才是 Prompt Cache 的真身）
- [LLM 和 Agent 的核心术语和原理](./01-llm-and-agent.md)
- [AI 编程的基本常识](../p1-tools/05-ai-tips.md)
- [动手实现一个 AI 聊天机器人](../p2-agent-basics/01-ai-chatbot.md)
- [给 Claude Code 发一句 Hi 会发生什么](../p3-agent-internals/02-hi-request.md)
- [如何实现上下文压缩](../p3-agent-internals/05-context-compaction.md)
- [你的聊天记录存在哪](../p1-tools/07-session-storage.md)
- [Sub Agent：上下文管理的艺术](../p1-tools/10-sub-agent.md)
