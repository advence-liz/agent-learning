# Agent 研发面试考什么，怎么用这个知识库备考

> 本章不对应原站文章，是知识库的补充章节（独立原创）：把 2025–2026 年公开的 Agent 岗面经整理成考点地图，再把每个考点对应到本库的章节。

> **一句话结论**：国内外的 Agent 岗面试都在验证同一件事：**你是不是亲手做过一个 agent，能不能讲清它的可靠性、成本和评测**。只会背概念过不了；能把 [mini Claude Code](../p4-mini-cc/01-cli.md) 讲到代码层的人，题库里大部分题都能接住。

## 「我天天用 Claude Code，算不算会做 Agent？」

不算，但离得很近。

面试官问「ReAct 是什么」，你能答出 Thought、Action、Observation。他接着问：「那你的 agent 什么时候停？工具报错了模型怎么知道？撞上步数上限时，前面查到的东西丢不丢？」这时候，用过和做过的差别就出来了。

你可能会问：那准备面试是不是要另外刷一套八股？其实不用。这个知识库前五部分拆的每个零件，都对应一类面试题。这一章做的，就是把这张对应表画出来。

## 国内和海外，考法差在哪

先看公开面经里能溯源的部分。

| | 国内大厂 | 海外 applied-AI 岗 |
|---|---|---|
| 轮次 | 一般三轮技术面加 HR 面。字节一个 Agent 实习岗是一面、二面、三面加 HRBP，只有一面有手撕代码 [^n2] | 四到五轮，只有一轮像传统算法面，其余是电话筛选、take-home、现场调试、系统设计、产品感 [^t1] |
| 内容 | 项目深挖、Agent 原理、后端基础（Redis、并发、MySQL），外加一道 LeetCode。大疆一场 20 题里，前 14 题问 Agent 和项目，后 6 题问 Java 后端 [^c2] | take-home 要求端到端搭一个系统并附评测；调试题直接给你一个会死循环的 agent |
| 看重什么 | 据二手汇总：字节会连续追问五六层，最在意是不是真做过；阿里会让你画分层架构；腾讯偏 MCP、A2A 和多 agent [^c1] | 对模型有自己的观点、能讲失败过的实验；take-home 一定要带评测；最扣分的是教科书式回答 [^p1] |

还有一个新趋势：2026 年流行的新名词已经进了面试题。字节一场 Agent 实习一面，问到了 SDD、Spec-kit、Harness Engineering，还追问候选人简历上写的「Recall@5 做到 91.2%」是怎么测出来的 [^n1]。

说白了，简历上写的每个数字，都要能讲清楚怎么测的、评测集多大、有没有过拟合。

!!! note "来源说明"
    牛客帖是候选人自述，CSDN 和掘金的文章是二手汇总，「各家侧重」那一列只能当参考。月之暗面、MiniMax、智谱的 Agent 岗没有找到能溯源的面经，这里不下结论。

## 考点地图：每类题在本库哪里有答案

面试题看着五花八门，归类后是下表的 11 类考点。答案主要集中在本库的四个部分（多 Agent 那一类还要用到第 1 部分的两篇工具章）：

```d2
grid-columns: 2
grid-gap: 24
k0: "第 0 部分 · 核心概念\n循环与停止 · token 成本"
k2: "第 2 部分 · Agent 开发基础\n工具与 MCP · RAG · 可观测"
k3: "第 3 部分 · 工业级 Agent\n上下文与记忆 · harness 与权限\n评测 · 安全"
k4: "第 4 部分 · mini Claude Code\n循环与错误处理 · 多 Agent\n项目深挖的素材"
```

细到章节是这样：

| 考点 | 必读章节 | 面试时能拿出来讲的 |
|---|---|---|
| Agent 是什么、何时用 workflow | [LLM 和 Agent 的核心术语](../p0-core/01-llm-and-agent.md)、[Workflow 和 Agent](../p2-agent-basics/05-workflow-vs-agent.md) | 「控制流由谁决定」这一条分界线，以及五种 workflow 模式 |
| 循环、停止条件、错误重试 | [Agent 构建指南](../p3-agent-internals/13-agent-build-guide.md) 的「动手」、[错误处理与重试](../p4-mini-cc/03-error-handling.md) | 三个 break（撞上限收口、软预算、打断后补齐工具结果）在构建指南的「动手」里实现；mini Claude Code 撞上限时目前只发提示、以 `max_iterations` 结束，不收口，可以做构建指南的练习 1 自己补上，再拿来讲项目。错误处理那章能讲的是 API 重试与退避、工具报错回填 |
| 上下文与 token 成本 | [上下文和 token 计费](../p0-core/03-messages-and-tokens.md)、[上下文压缩](../p3-agent-internals/05-context-compaction.md)、[compact](../p4-mini-cc/14-compact.md)、[成本控制与模型路由](../p3-agent-internals/17-cost-and-routing.md) | 压缩前后 messages 长什么样；改前缀为什么会让缓存失效 |
| 记忆 | [Claude Code 自动记忆](../p3-agent-internals/06-auto-memory.md)、[mem0](../p3-agent-internals/08-mem0-memory.md)、[Zep](../p3-agent-internals/09-zep-memory.md)、[长期记忆](../p4-mini-cc/12-memory.md) | 三种记忆方案的取舍：文件、抽取合并、时序图谱 |
| RAG 与检索 | [RAG 问答机器人](../p2-agent-basics/03-rag-qa-bot.md)、[RAG 原理](../p2-agent-basics/04-rag-principles.md) | 什么时候用向量检索，什么时候让 agent 自己 grep |
| 工具与 MCP | [工具设计](../p2-agent-basics/12-tool-design.md)、[MCP 工具](../p2-agent-basics/10-mcp-tool.md)、[MCP 协议](../p2-agent-basics/11-mcp-protocol.md)、[注册 MCP server](../p4-mini-cc/15-mcp.md)、[Skills](../p4-mini-cc/20-skill.md) | 亲手写过一个 MCP server；渐进式加载为什么省上下文 |
| 多 Agent | [Sub Agent](../p1-tools/10-sub-agent.md)、[Fork Agent](../p1-tools/11-fork-agent.md)、[实现 Sub Agent](../p4-mini-cc/17-subagent.md) | 子 agent 只回传摘要，换来干净的主上下文 |
| Harness、权限 | [Harness Engineering](../p3-agent-internals/12-harness-engineering.md)、[权限检查](../p3-agent-internals/10-permission-check.md)、[权限审批](../p4-mini-cc/05-permission.md) | 软约束和硬约束：能写成代码闸门的，就不靠提示词 |
| 评测与可观测 | [Agent 评测实践指南](../p3-agent-internals/14-agent-eval-guide.md)、[可观测性](../p2-agent-basics/08-agent-observability.md) | pass^k、能力集和回归集、门禁挂在哪 |
| 安全 | [Agent 安全](../p3-agent-internals/15-agent-security.md) | 致命三要素，以及在代码里拆掉其中一条 |
| SDK 与框架选型 | [Agent SDK](../p2-agent-basics/06-agent-sdk.md)、[SDK 对比](../p2-agent-basics/07-agent-sdk-comparison.md) | 什么时候自己写循环，什么时候上框架 |

你会发现，表里最常出现的是第 3 部分和第 4 部分。原因很简单：面试问的是「你做过什么」，而这两部分一个在拆真实产品，一个在亲手造。

## 动手：把 mini Claude Code 变成你的面试项目

面试最怕的是项目讲不深。你已经跟着第 4 部分做过一个 mini Claude Code，它天然就是一个好项目：从 0 长到 21 个能力，每一步都有代码和测试。

问题在于，「我跟着教程写了一个 Claude Code」这句话本身没有说服力。要把它讲成面试项目，得补上三样东西：

1. **一个你自己定的指标。** 比如给它加一份 20 道题的小评测集，统计改动前后的通过率和平均 token。没有指标，项目深挖问到「效果怎么样」就答不上来。
2. **一次真实的取舍。** 比如压缩阈值为什么定在这里、记忆为什么选文件而不是向量库。面试官追问五层，追的就是这些决定背后的理由。
3. **一次失败。** 比如某次改提示词后，它开始一读文件就停不下来，你是怎么从 trace 里发现、怎么修好的。海外面试会专门问「讲一个失败的实验」。

可以用下面这个模板准备项目深挖稿，每一栏写两三句：

```text
项目一句话：      一个带 21 项能力的终端编码 agent（mini Claude Code）
我负责的部分：    全部；重点讲 compact、权限审批、sub agent 三块
关键指标：        自建 20 题评测集，pass^3 从 __% 提到 __%；平均每题 token __
最难的问题：      __（一句话现象）→ 根因 __ → 修法 __
一次取舍：        __ 选了 A 没选 B，因为 __；代价是 __
如果重做：        __
```

写完拿 [第 2 篇的十道高频题](02-top-questions.md) 对照一遍：每道题能不能用你这个项目里的具体例子来答？能答上来的越多，这份稿子就越扎实。

## 对照你的环境

- 你平时 review 别人的 PR，靠的是一套判断标准。面试官看你的项目也一样：先看你知不知道它会在哪里坏，再看你怎么让它不坏。你给自己的 Claude Code 写过的那些 hook，比如按目录注入护栏、PreToolUse 拦截，本身就是「把软约束硬化成代码闸门」的实例，可以直接当项目素材讲。
- 你用 codex 做异源 review，这就是「用另一个模型当评委」。面试被问到 LLM-as-judge 的偏差时，可以从你自己的使用体验讲起：两个模型什么时候意见一致，什么时候会互相打架。

## 回到开头的问题

天天用 Claude Code 算不算会做 Agent？用过让你知道它在哪里好用；做过才让你知道它在哪里会坏，以及为什么。面试考的是后者。

回到主线：面试题问的循环、压缩、记忆、工具、评测，全是「在有限上下文里把任务做对」的工程方法。准备面试，就是把这条主线在你自己的项目里讲一遍。

## 常见坑

- **背了名词没有例子。** 被问「什么是 context engineering」，答了定义，接着被问「你在项目里怎么做的」就卡住。每个概念至少准备一个自己的例子。
- **简历上的数字讲不清来源。** 写了「准确率提升 30%」，却说不出评测集多大、跑了几次、对比的基线是什么。
- **把框架当能力。** 「我用 LangGraph 搭了一个 agent」不等于懂 agent。面试官更想听你会不会不用框架，自己写出那个循环。
- **忽视后端基础。** 国内很多 Agent 岗有一半题在问 Redis、并发和数据库。agent 上生产后要处理的幂等、锁、重试，本来就是后端问题。

## 练习

**1.** 用上面的模板，给你做过的 mini Claude Code（或者你工作里接触过的任意一个 agent 功能）写一份项目深挖稿。

<details>
<summary>提示</summary>

照模板逐栏写，每栏两三句。最容易空着的是「关键指标」和「最难的问题」：没有指标就先补一份 20 题的小评测集，评测怎么搭见 [Agent 评测实践指南](../p3-agent-internals/14-agent-eval-guide.md)。

写完拿 [十道高频题](02-top-questions.md) 自检：每道题能不能用这个项目里的一个具体例子来答。答不上的题，就是你稿子里缺的那一栏。

</details>

**2.** 从「考点地图」里挑一个你最没底的考点，读完对应章节后，不看书讲给自己听三分钟，录下来回放一遍。

<details>
<summary>提示</summary>

选题时可以对照「考点地图」表的第三列「讲清这个就够」，它就是讲三分钟要覆盖的范围。比如选「上下文与 token 成本」，三分钟里要讲到压缩前后 messages 的样子、改前缀为什么会让缓存失效，对应 [上下文和 token 计费](../p0-core/03-messages-and-tokens.md)。

回放时重点听两件事：有没有一个自己的例子；有没有讲代价。这是 [十道高频题](02-top-questions.md) 「常见坑」里列的两类典型问题。

</details>

**3.** 开放题：如果你是面试官，只有 45 分钟，你会问哪三个问题来区分「用过」和「做过」？为什么是这三个？

<details>
<summary>提示</summary>

判断方向：别问定义，问「坏了怎么办」和「怎么知道它好」。本章开头那段就是示范：问完 ReAct，接着问什么时候停、工具报错模型怎么知道、撞上限后前面查到的东西丢不丢。

我会选这三类：一是停止条件和失败处理（对应 [十道高频题](02-top-questions.md) 第 2 题）；二是评测，问「你怎么知道改了提示词之后没变差」（第 8 题）；三是一次具体的失败复盘，从现象追到根因（[题库](03-question-bank.md)「项目深挖和行为面」）。理由：这三样都只有亲手做过、踩过坑才答得出细节，背是背不出来的。

</details>

## 延伸阅读

- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)：面试里引用最多的分类框架
- [What applied-AI engineer interviews test in 2026](https://www.techinterview.org/post/3233476824/ai-engineer-interview-rag-agents-evals/)：海外各轮题型和 take-home 示例
- [The Agentic System Design Interview](https://blog.promptlayer.com/the-agentic-system-design-interview-how-to-evaluate-ai-engineers/)：面试官视角的评分维度
- [Hugging Face Agents Course](https://huggingface.co/learn/agents-course)：免费，想换个框架视角时可以过一遍

[^n1]: [牛客 · 字节 Agent 开发实习一面](https://www.nowcoder.com/feed/main/detail/931a8a935a5e4b4f8d0b71cd4e818604)（候选人自述）
[^n2]: [牛客 · 字节 AI agent 实习面经](https://www.nowcoder.com/feed/main/detail/36f397670374455896bd05de6858c06a)（候选人自述）
[^c1]: [2026 大厂 AI Agent 面试全攻略](https://adg.csdn.net/6a82f7fa10ee7a33f29c2607.html)（二手汇总，2026-08）
[^c2]: [大疆 AI Agent 开发岗面试实录](https://adg.csdn.net/6a87b666662f9a54cb9f1356.html)（2026-08）
[^t1]: [techinterview · applied-AI 面试](https://www.techinterview.org/post/3233476824/ai-engineer-interview-rag-agents-evals/)（2026-07）
[^p1]: [PromptLayer · Agentic System Design Interview](https://blog.promptlayer.com/the-agentic-system-design-interview-how-to-evaluate-ai-engineers/)（2025-07）
