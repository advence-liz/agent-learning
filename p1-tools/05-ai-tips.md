# AI 编程的基本常识

> 原文（免费）：[AI 编程的基本常识](https://labuladong.online/zh/ai-coding/basics/ai-tips/) —— 建议先读原文，本页是我的笔记

**一句话结论**：模型是无状态的，「会话」只是客户端保存的一个 messages 数组。开新会话、聊久变笨、越用越懂我、首条消息贵、断网不丢进度——这五个日常现象，都能从「数组里有什么、数组有多长、前缀是否命中缓存」推出来。

## 核心要点

1. **session = 一个独立的 messages 数组**。开新会话就是换一个空数组，模型对旧会话一无所知。
2. **「越用越懂我」是应用层注入，不是模型学会了**。产品从历史对话里抽取用户画像并持久化，开新会话时塞进上下文开头。原文的说法是，这「本质上和你每次手动告诉模型『我是一个后端程序员…』没有区别」。
3. **一个会话只聊一个主题**。无关历史会带来两种成本：每轮都要重发，更费钱；它们还会参与下一个 token 的概率计算、分散注意力，导致质量下降，这一点更严重。
4. **长会话会「忘事」，原因有两个**：
   - 接近窗口上限时工具会**摘要压缩**，早期细节（比如开头约定的命名规范）被总结替换掉；
   - 即使没压缩，模型对开头和结尾的内容记得最牢、中间部分容易被忽略，即 **Lost in the Middle**。
5. **主动压缩优于被动压缩**：不要等快满了让工具自动压缩，趁中间过程还不算太长时主动 `/compact`，保留下来的信息更完整。
6. **首条消息贵，后面便宜**：Coding Agent 的 system prompt + 工具定义可能上万 token。第一次请求这段前缀没有缓存，全价计费；之后命中前缀缓存，只有新增部分按原价算。缓存有时效，原文以 Anthropic 默认的 5 分钟为例。
7. **断网 / 打断 / 换模型都不会失忆**：数组保存在客户端（Codex、Claude Code 存在本机），每次请求都完整重发。唯一的代价是换模型或隔久了再回来，缓存失效，首条请求贵一些。

```d2
direction: down
client: "客户端\n（Claude Code / Codex）" {
  mem: "用户记忆\n/ CLAUDE.md" {shape: cylinder}
  sp: "System prompt\n+ 工具定义\n上万 token，稳定前缀"
  arr: messages 数组
  hist: "本地会话文件 .jsonl" {shape: cylinder}
  mem -> arr
  sp -> arr
  hist <-> arr
}
api: "模型 API\n无状态"
c: 缓存 {shape: diamond}
r: 响应追加回数组
cmp: "/compact 摘要\n早期细节丢失" {shape: parallelogram}
client.arr -> api: 每轮完整发送
api -> c: 前缀命中缓存？
c -> r: "命中：便宜"
c -> r: "未命中：首条/超时/换模型"
client.arr -> cmp: 接近上限
cmp -> client.arr
```

```d2
direction: down
start: "" {shape: circle; width: 16; height: 16; style.fill: "#333"}
s1: 新会话
s2: 聚焦对话
s3: 上下文膨胀
s4: 主动压缩
s5: 自动压缩
start -> s1: "空数组 +\n注入记忆"
s1 -> s2: 单一主题
s2 -> s3: "跑题 /\n冗长试错"
s3 -> s4: "/compact\n（推荐，趁早）"
s3 -> s5: "撑到上限\n（细节损失更大）"
s4 -> s2
s5 -> s2
s2 -> s1: "换主题就\n开新会话"
```

> ⚠️ 勘误/补充
> - 原文称 Lost in the Middle 由「斯坦福和 Meta AI 在 2023 年的研究中证实」。论文 *Lost in the Middle: How Language Models Use Long Contexts*（Liu et al., arXiv:2307.03172，2023-07）首页署名单位是 **Stanford University、UC Berkeley、Samaya AI**，没有 Meta AI（实测提取 arXiv PDF 首页文本）。
> - 缓存时效：Anthropic API 的 prompt caching 默认 TTL 是 5 分钟，另提供可选的 1 小时 TTL（`cache_control` 里的 `ttl`）。Claude Code 实际对哪些前缀用哪种 TTL，本笔记未核实。
> - 本机 Claude Code 2.1.306 还提供 `--autocompact <auto|tokens>`，可以把自动压缩的窗口设成 100k–1M token 之间的值（`claude --help` 实测），这是对「何时压缩」的显式控制，原文没提。

### 📝 作者是怎么讲的

- **用一串读者真实遇到过的问题开场。** 开头列了五个日常困惑：为什么要开新会话、为什么聊久了会变笨、为什么越用越懂我、为什么第一条消息贵、断网会不会丢进度。然后说明「这篇用上一篇的原理来回答」。整篇因此是在应用原理、回答问题，不是一份罗列的贴士清单。你写团队分享时可以照搬：先把大家吐槽过的现象列出来，再用一个机制统一解释。
- **所有问题都回到同一个机制。** 记忆、变笨、计费、断线恢复，最后都归结到「模型无状态，所有记忆都在 messages 数组里」。这正是 STYLE 里说的「朴实无华」：产品看起来记得你，其实只是往数组开头多塞了一段用户画像。
- **用「你可能会问」推进。** 讲完「新会话就是清空数组」之后，马上接一句：那 ChatGPT 为什么越用越懂我？用一个反例逼出用户记忆（Memory）的解释，一个问题接一个问题往下推。
- **用生活类比讲 Lost in the Middle。** 读一本长书，最记得开头和结尾，中间模糊。他还给出了这个比喻的边界：1M 上下文只是能力上限，不等于长上下文里不会变笨，并说明这是「我的实际体验」，把论文结论和个人观察分开写。
- **从原理推出可操作的建议。** 知道压缩会丢细节，就得出：趁对话还不长时主动 `/compact`，不要等工具自动压缩。知道 system prompt 有上万 token、第一次请求没有缓存，就得出：第一条消息贵是正常的，不用紧张，但要注意 5 分钟的缓存时效。每个解释都落到一个具体动作上。
- **用一句话先安抚读者，再讲原因。** 「会不会失忆」那一节，先回答「不会，放心吧」，再从「数组由客户端保存、每次完整发送」解释原因，最后补上唯一的代价：切换模型后缓存失效。对于读者担心的问题，先给答案再给理由。

## 回到主线

这章就是主线本身的日常版：上下文是唯一的「记忆」，也是唯一的成本来源。

- **开新会话、单一主题**：拿走无关 token，换取预测准确度；
- **压缩**：拿走旧细节，换取剩余窗口；
- **用户记忆**：往开头放一小段高价值 token，换取个性化；
- **前缀缓存**：不改变上下文内容，只让稳定前缀更便宜。所以 Harness 都会把 system prompt、工具定义这些不变的东西放最前面。

后面的 [上下文压缩](../p3-agent-internals/05-context-compaction.md)、[自动记忆](../p3-agent-internals/06-auto-memory.md)、[Sub Agent](./10-sub-agent.md) 都是这几招的工程化。

## 对照你的环境

- **「用户记忆」在你这里是显式的**：`~/.claude/CLAUDE.md`（全局准则）每个会话都注入；`inject-guardrails.sh` 这个 SessionStart hook 按 cwd 再叠加公司层 / 项目层护栏；`~/.claude/projects/<项目>/memory/` 是 auto-memory。你 CLAUDE.md 里那句「常驻层是稀缺资源——每加一行都在和别的行抢注意力」，就是本章第 3、4 点的另一种说法：常驻内容既占 token，又处在最容易被记住的开头，放错东西代价翻倍。
- **首条消息贵**：你有 46 个 skill 目录 + 插件 skill + 多个 MCP server，它们的描述 / 工具定义都进系统前缀。这解释了为什么 deferred tools（按需 `ToolSearch` 加载 schema）有意义：前缀越短，首条越便宜，缓存失效时的损失也越小。
- **会话可恢复**：本机会话存在 `~/.claude/projects/<cwd 转义>/<session-id>.jsonl`（Codex 是 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`），`claude -c` / `claude -r` 恢复；`--fork-session` 恢复时分出新 ID。详见 [你的聊天记录存在哪](./07-session-storage.md)。

## 自测题

1. 你在一个会话里修完 webapp 的一个 bug，接着想让它写周报。按本章原理，应该怎么做？为什么？
2. 你中午离开 20 分钟回来接着聊，发现这一轮比平时贵很多，但 messages 一条没少。解释原因。
3. 你在会话开头约定「所有新组件放 `features/` 下」，200 轮后 Claude 把组件建到了别处。给出两个可能的机制原因，并各给一个工程上的规避办法。

<details>
<summary>参考答案</summary>

1. 开新会话（或用 subagent 隔离）。周报和修 bug 无关，旧的调试历史会每轮重发、增加费用，还会参与概率预测、干扰写周报的质量。
2. 前缀缓存有 TTL（API 默认 5 分钟），超时后缓存失效，整个长前缀要重新按全价（甚至按写缓存价）计费，与消息条数无关。
3. 一是那条约定已被自动压缩进摘要，细节丢了，规避办法是写进 CLAUDE.md 或项目层护栏，让它常驻、不被压缩。二是它还在上下文里，但位于长上下文中部（Lost in the Middle），规避办法是关键约束靠近末尾重申，或者用 hook / lint 强制，即你 CLAUDE.md 里的「工具链能强制的就别写进上下文」。

</details>

## 相关章节

- [上下文是什么？token 怎么计费？](../p0-core/03-messages-and-tokens.md)（本章的原理篇）
- [LLM 是怎么预测下一个 token 的](../p0-core/04-llm-token-prediction.md)
- [Claude Code 的常用技巧](./06-useful-tips.md) · [你的聊天记录存在哪](./07-session-storage.md)
- [如何实现上下文压缩](../p3-agent-internals/05-context-compaction.md) · [支持 compact 压缩上下文](../p4-mini-cc/14-compact.md)
- [Claude Code 自动记忆系统](../p3-agent-internals/06-auto-memory.md)
- [Sub Agent：上下文管理的艺术](./10-sub-agent.md)
