# 题库与系统设计：52 组真题和两道完整示范

> 本章不对应原站文章，是知识库的补充章节（独立原创）：把公开面经里的 Agent 岗题目去重、归类，每题指到本库能找到答案的章节；再给出系统设计题的答题框架和两道完整示范。

> **一句话结论**：题目看着多，其实就四类：概念题考你懂不懂原理，系统设计题考你会不会取舍，实操题考你能不能写出来，项目深挖考你是不是真做过。系统设计题最拉开差距，用一套固定的六步框架答，每一步都要说出代价。

## 题这么多，从哪开始刷？

不要从头刷到尾。这个题库是拿来查漏的：先按[第 1 篇的考点地图](01-interview-landscape.md)把本库对应章节读一遍，再回来看哪些题你答不上。答不上的，顺着「答案在」那一列回去重读。

难度标记：L1 是基础题，答不上会直接减分；L2 是主力题，大部分面试在这一档；L3 是拉开差距的题，通常出现在二面或三面。

## 概念题

| 题目 | 难度 | 答案在 |
|---|---|---|
| ReAct agent 的架构和工作原理；模型怎么决定调用哪个工具 | L1 | [核心术语](../p0-core/01-llm-and-agent.md)、[十题 · 1](02-top-questions.md) |
| ReAct、Plan-and-Execute、Reflexion 有什么区别 | L2 | ReAct 见[核心术语](../p0-core/01-llm-and-agent.md)；Plan-and-Execute 和 Reflexion 本库未展开，见 [Reflexion 论文](https://arxiv.org/abs/2303.11366)；「先规划再执行」的思路可参考 [Plan-and-Solve 论文](https://arxiv.org/abs/2305.04091)。[Plan Mode](../p3-agent-internals/11-plan-mode.md) 讲的是 Claude Code 里「只规划、经你批准再动手」的实现，可以当先规划再执行的工程例子，但没有对比这几种范式 |
| Agent、Workflow、Tool 有什么区别；什么时候不该用 Agent | L2 | [Workflow 和 Agent](../p2-agent-basics/05-workflow-vs-agent.md) |
| MCP 和 Function Calling 有什么区别 | L1 | Function Calling 见[核心术语](../p0-core/01-llm-and-agent.md)，MCP 见 [MCP 工具](../p2-agent-basics/10-mcp-tool.md) |
| MCP 里 Resources 和 Tools 的区别；传输方式怎么选 | L2 | [MCP 协议](../p2-agent-basics/11-mcp-protocol.md) |
| MCP、A2A 分别解决什么问题 | L2 | [MCP 协议](../p2-agent-basics/11-mcp-protocol.md)、本章「补充：A2A」 |
| 短期记忆和长期记忆分别放在哪；多轮记忆怎么设计 | L2 | [自动记忆](../p3-agent-internals/06-auto-memory.md)、[长期记忆](../p4-mini-cc/12-memory.md) |
| 上下文满了怎么办；压缩丢了关键信息怎么办 | L2 | [上下文压缩](../p3-agent-internals/05-context-compaction.md)、[compact](../p4-mini-cc/14-compact.md) |
| 讲讲你的多级上下文压缩方案，阈值为什么这么定 | L3 | [上下文压缩](../p3-agent-internals/05-context-compaction.md) + 你的项目 |
| Agentic RAG 和传统 RAG 有什么区别 | L2 | [RAG 原理](../p2-agent-basics/04-rag-principles.md) |
| 从 ES 换成向量检索，哪些能力变弱、哪些变强 | L2 | [RAG 原理](../p2-agent-basics/04-rag-principles.md) |
| chunk 策略和大小怎么定；混合检索；为什么要 rerank | L2 | chunk 见 [RAG 问答机器人](../p2-agent-basics/03-rag-qa-bot.md)和 [RAG 原理](../p2-agent-basics/04-rag-principles.md)的实验 1；混合检索和 rerank 见 [RAG 原理](../p2-agent-basics/04-rag-principles.md)的「混合检索和 rerank」一节 |
| 你的 Recall@5 是怎么做到的，怎么防过拟合 | L3 | [评测实践指南](../p3-agent-internals/14-agent-eval-guide.md) + 你的项目 |
| 幻觉的成因和缓解方法；怎么做引用溯源 | L2 | 成因本库未系统展开，见 [Why Language Models Hallucinate](https://arxiv.org/abs/2509.04664)；[token 预测](../p0-core/04-llm-token-prediction.md)的「第三步」只解释了其中一点：逐 token 抽样，一步抽歪，后面就顺着歪掉的前缀往下写。引用溯源的最小做法见 [RAG 问答机器人](../p2-agent-basics/03-rag-qa-bot.md)的「拼 prompt」：只按资料回答并标出处编号 |
| 怎么防提示词注入；怎么给 DELETE 这类危险操作加护栏 | L2 | [Agent 安全](../p3-agent-internals/15-agent-security.md)、[权限检查](../p3-agent-internals/10-permission-check.md) |
| 注册了 30 个工具后准确率下降，怎么办；什么样的工具定义算好 | L3 | [十题 · 3](02-top-questions.md)、[工具设计](../p2-agent-basics/12-tool-design.md) |
| 外部工具出错或超时，怎么容错和恢复 | L2 | [错误处理与重试](../p4-mini-cc/03-error-handling.md) |
| 死循环怎么检测和恢复；怎么限制工具调用次数 | L2 | [十题 · 2](02-top-questions.md)、[Agent 构建指南](../p3-agent-internals/13-agent-build-guide.md) |
| 调工具时 temperature 怎么设 | L1 | [调用 LLM 接口](../p0-core/02-api-and-apikey.md) |
| 怎么评估 Agent 质量；LLM 评委上线前怎么用人工标注校准 | L3 | [评测实践指南](../p3-agent-internals/14-agent-eval-guide.md) |
| token 用量暴涨怎么排查；一次对话花了 10 万 token，怎么控成本 | L2 | [token 计费](../p0-core/03-messages-and-tokens.md)、[可观测性](../p2-agent-basics/08-agent-observability.md)、[成本控制与模型路由](../p3-agent-internals/17-cost-and-routing.md) |
| 什么时候该拆多 agent；agent 之间冲突怎么解决 | L2 | [Sub Agent](../p1-tools/10-sub-agent.md)、[十题 · 7](02-top-questions.md) |
| LangGraph 的 state、条件边、人在环中；和自己写循环怎么选 | L2 | [SDK 对比](../p2-agent-basics/07-agent-sdk-comparison.md) |
| 什么是 SDD（规格驱动开发） | L2 | 本库未展开，见延伸阅读 |
| 什么是 Harness Engineering，为什么能提升复杂任务的表现 | L3 | [Harness Engineering](../p3-agent-internals/12-harness-engineering.md) |
| 设计或实现过 Agent Skill 吗，有哪些取舍 | L2 | [Skills](../p1-tools/12-skills.md)、[渐进式加载 Skills](../p4-mini-cc/20-skill.md) |
| 模型不可用时怎么降级 | L2 | [错误处理与重试](../p4-mini-cc/03-error-handling.md)只覆盖一部分：529 过载是退避重试（不换模型），服务端 fallback 只在拒答时换模型。「重试用尽后切备用模型」本库未实现，那章练习 3 讨论了换模型对 thinking 块和 prompt cache 的影响，可以从这里展开答 |
| 微调和 RAG 怎么选；LoRA 的原理 | L2 | [LoRA 微调](../p6-nn-llm/06-lora-fine-tuning.md)、[RAG 原理](../p2-agent-basics/04-rag-principles.md) |
| 从用户按下回车到答案返回，中间发生了什么 | L2 | [发一句 Hi 会发生什么](../p3-agent-internals/02-hi-request.md)、[流式响应](../p2-agent-basics/09-streaming-response.md) |

## 系统设计题

| 题目 | 难度 | 答题主线 |
|---|---|---|
| 设计一个 Coding Agent，并和 Claude Code、Codex 对比 | L3 | 见下文「示范一」 |
| 设计一个能读仓库、跑测试、提 PR 的 agent | L3 | 示范一的变体：重点讲 PR 由人审、测试结果驱动下一步 |
| 画出路由、编排、执行三层架构，讲每层的瓶颈 | L3 | 各层的职责边界、扩展方式、一层出故障时其他层怎么隔离 |
| 设计一个抓取视频信息的 agent（意图解析、反爬、合规） | L3 | 工具边界、限流、合规审查放在代码闸门里 |
| 设计客服助手：你怎么知道它在帮忙，而不是在添乱 | L2 | 见下文「示范二」 |
| 设计多 agent 协作、产出带引用报告的 Deep Research | L3 | 编排者加执行者，子 agent 只回传摘要，最后单独核对引用 |
| 设计订行程的 agent，重启后避免重复扣款 | L3 | [十题 · 10](02-top-questions.md) |
| 多租户的 agent 部署和评测 harness | L3 | 租户隔离、配额、按租户切片的评测报告 |
| 从零搭一个 agent，哪些组件必不可少 | L2 | [Agent 构建指南](../p3-agent-internals/13-agent-build-guide.md) 的五层加治理线 |

## 编码和实操题

| 题目 | 难度 | 怎么准备 |
|---|---|---|
| 手写 ReAct loop，或写 agent loop 的伪代码 | L2 | 不看书写一遍 [Coding Agent](../p2-agent-basics/02-coding-agent.md) 的循环，带步数上限和错误回填 |
| 用 numpy 手写多头注意力 | L2 | [token 预测](../p0-core/04-llm-token-prediction.md)的「动手」用 numpy 写了一层单头因果注意力（`TinyAttention`，打分在 `code/agent/core/next_token.py` 的 `_logits_last`）。本库只写到单头，多头（拆头、各自算注意力、拼接再投影）需要自己扩展 |
| LeetCode：合并有序数组、判断链表有环、编辑距离 | L1 | 国内面试基本必考一道，单独刷 |
| 调试题：这个 agent 在某些输入上无限循环，找原因并修好 | L2 | [十题 · 2](02-top-questions.md)；练习读 trace |
| Take-home：给 50 篇 Markdown，搭问答系统和 20 题评测集，报告 recall@5 和 faithfulness | L2 | [RAG 问答机器人](../p2-agent-basics/03-rag-qa-bot.md) 搭系统，[RAG 评测](../p3-agent-internals/16-rag-eval.md) 建评测集、算 recall@k 和 faithfulness |
| Take-home：多跳文档问答加引用追踪，或者带准确率评测的代码审查 agent | L2 | 同上，重点是评测和 README |
| 实操类编码：内存数据库、多阶段题 | L2 | 工程基本功 |

## 项目深挖和行为面

| 题目 | 难度 | 怎么准备 |
|---|---|---|
| 为什么转做 Agent；平时用哪些 AI 工具，学到了什么 | L1 | 准备一个具体的使用心得，比如你写过的某个 hook 解决了什么问题 |
| 项目是从零做还是基于开源；最难的问题是什么，你负责哪部分，结果如何 | L2 | 用[第 1 篇的项目稿模板](01-interview-landscape.md)准备 |
| 这个 agent 怎么实现的；团队用什么模型、几个人 | L2 | 能追问到代码层 |
| 客户说 bot「感觉很笨」，你先改什么 | L2 | 先看 trace 归类失败，再决定改提示词、工具还是检索 |
| 讲一个失败的实验；你对模型有什么看法 | L2 | 准备一次真实的失败复盘 |

题目来源见文末脚注 [^c1] [^c2] [^j1] [^n1] [^t1] [^t2] [^p1]。合并了措辞不同、问的是同一件事的题。

## 系统设计的六步框架

系统设计题没有标准答案，面试官看的是你怎么拆问题、怎么取舍。用下面这六步答，至少不会漏掉大块：

```d2
direction: down
s1: "1 澄清需求\n用户是谁 · 哪些动作有副作用 · 怎样算做对"
s2: "2 Workflow 还是 Agent\n哪段路径固定 · 哪段交给模型"
s3: "3 循环和工具\n工具清单 · 权限分级 · 停止条件"
s4: "4 上下文和状态\n检索 · 压缩 · 记忆 · 状态外置 · 幂等"
s5: "5 安全\n致命三要素 · 沙箱 · 凭证"
s6: "6 评测和观测\n回归集 · 在线评委 · trace · 灰度"
s1 -> s2 -> s3 -> s4 -> s5 -> s6
```

每一步讲完，都补一句代价。比如第 4 步说「用子 agent 隔离上下文」，就接着说「代价是 token 多花几倍，所以只用在能并行的搜索上」。面试官的追问，大多是在问你没主动讲的代价。

## 示范一：设计一个 Coding Agent

下面是一段按六步展开的回答，大约十分钟。

**1. 澄清需求。** 我先确认三件事：它在用户本机跑还是在云端跑；能不能直接改代码、执行命令；交付物是一个 PR 还是直接合入。假设答案是：云端运行，可以改代码、跑测试，最后提 PR，由人审核合入。「做对」的标准是：PR 里的测试通过，而且改动范围合理。

**2. Workflow 还是 Agent。** 主体用 agent，因为读哪些文件、改几处、要不要再跑一遍测试，没法提前写死。但两头用固定流程：开头固定执行「拉代码、装依赖、跑一遍现有测试」，结尾固定执行「跑测试、lint、提 PR」。中间才交给模型。

**3. 循环和工具。** 工具尽量少而通用：读文件、按字符串替换编辑文件、执行 shell、搜索代码。用通用工具，是因为模型对 bash 和文件操作训练得最充分，组合能力也最强。权限分三级：读文件和搜索自动放行；改文件放在沙箱的工作区里随意改；执行命令按白名单放行，联网的命令需要单独授权。停止条件：模型不再调用工具，或者撞上步数和时间上限；撞上限时让它总结做到了哪一步。

**4. 上下文和状态。** 大仓库不做向量索引，让 agent 用 grep 和 glob 按需查找，这样不会遇到索引过期的问题；项目约定放在仓库根目录的说明文件里，每次预先加载。长任务开启压缩，保留最近几轮原文和最近读过的文件。保留尾部要先处理 thinking 块，否则会失效，见 [compact](../p4-mini-cc/14-compact.md)。任务状态写在进度文件和 git 提交里，中断后可以从最近一次提交续跑。

**5. 安全。** 每个任务一个独立的沙箱，优先用 microVM，比普通容器隔离更强。代码仓库的凭证不进沙箱，由外部代理在提 PR 时注入。出网默认拒绝，包管理器的源走白名单。仓库里的 issue 内容和代码注释都算不可信输入，读过之后不允许执行对外发送数据的操作。

**6. 评测和观测。** 离线用一批历史上已合并的 PR 做题：给 agent 原始 issue，用原 PR 的测试判卷，同一题跑三次看 pass^3。线上记录每个任务的步数、token、测试是否通过、PR 是否被合入，以及人审时改了多少。改提示词或换模型之前，先跑一遍离线集。

**和 Claude Code、Codex 对比。** 两者的骨架都是这个循环：通用工具、按需检索、压缩、子 agent 隔离上下文、权限分级。差别主要在默认策略上，比如权限默认放多宽、沙箱怎么实现、压缩怎么触发。可以结合[用 Codex 还是 Claude Code](../p1-tools/01-tools-landscape.md)和第 2 部分拆过的细节来讲。

## 示范二：客服助手，怎么知道它在帮忙而不是添乱

这道题的重点在第 1 步和第 6 步，中间几步可以讲得简略。

**澄清「帮忙」怎么定义。** 先问清楚业务指标：一次解决率、转人工率、用户满意度。再问哪些操作有副作用，比如退款、改订单。这些操作要有人工确认，或者设金额上限。

**评测怎么设计。** 这是这道题的核心：

- **离线**：从历史工单里挑出典型问题和失败案例，建一个评测集。每道题按最终状态判分，比如退款是否真的发起、金额对不对，而不是看回复的措辞。同一题跑多次，看 pass^k，因为同一个用户问三次，三次都要答对。
- **评委**：话术质量这类没法用代码判的，用 LLM 评委，每个失败类别配一个只判通过或不通过的评委，并先用人工标注校准，报告它和人工判断的一致率。
- **线上**：抽样跑评委，同时看转人工率和重复来访率。助手在「添乱」时，往往表现为转人工率下降了，但同一个用户隔天又来问同样的问题。
- **闭环**：线上发现的新失败，归类后补进离线评测集。

**添乱的几种典型表现，要提前设计监控**：答非所问，用户重复提问；编造政策，回复里出现知识库里没有的条款；越权操作，调用了不该调用的工具。最后一种不能只靠监控，要用代码闸门挡住。

## 高频追问：怎么看发布会上的榜单分数

系统设计聊到评测时，常被顺带问这个。按这个顺序答：

1. **怎么跑的**：用的什么 harness、跑了几次、报的是 pass@1 还是 pass@k。同一个模型换一套 scaffold，分数可以差很多。
2. **数据靠不靠谱**：有没有污染，是不是已经饱和。典型例子是 OpenAI 在 2026 年 2 月宣布不再报告 SWE-bench Verified，理由是数据有污染、部分测试本身有缺陷，最近半年的最高分只从 74.9% 涨到 80.9% [^swe]。
3. **测的是不是你关心的**：τ²-bench 测工具调用和对话，换成用户也能操作环境的模式后，一些模型的通过率明显下降 [^tau]；BrowseComp 测难找的事实检索；METR 的 time horizon 衡量的是任务难度，不是 AI 花了多长时间 [^metr]。
4. **最后落到自己**：用自己的任务集复测才算数。

## 补充：A2A 是什么

本库没有单独讲 A2A，这里补一段，够应付面试。

MCP 解决 agent 怎么接工具和数据，A2A（Agent2Agent）解决一个 agent 怎么把任务委托给另一个 agent，而且双方不需要知道对方内部怎么实现。它的核心对象有三个：Agent Card，用来声明自己能做什么；Task，一个有生命周期的任务；Message 和 Artifact，用来交换过程信息和产出。A2A 由 Linux Foundation 托管，到 2026 年 4 月已有 150 多个组织支持 [^a2a]。

面试时可以这样区分：MCP 是纵向的，agent 往下接工具；A2A 是横向的，agent 和 agent 之间协作。两者不是二选一。

## 对照你的环境

- 系统设计第 5 步讲的「凭证不进沙箱」，你可以对照自己的环境想一想：Claude Code 执行命令时，能读到你 shell 里的哪些环境变量？哪些 token 其实不该让它看到？
- 示范一里「项目约定放在仓库根目录的说明文件里，每次预先加载」，就是你每个仓库里的 CLAUDE.md 和 AGENTS.md。

## 回到开头的问题

题这么多从哪开始？从考点地图开始读本库，再用这个题库查漏，答不上的顺着链接回去重读。系统设计题单独练：用六步框架完整讲两遍示范，再换一道题自己讲。

回到主线：系统设计的六步，前四步都在回答「模型这一轮该看到什么、能做什么」，后两步在回答「怎么确认它做对了、做错了能不能兜住」。

## 常见坑

- **系统设计一上来就画架构图。** 先花两三分钟澄清需求，问清有哪些副作用、怎样算做对。跳过这一步，后面的取舍就没有依据。
- **每一步只说做法不说代价。** 面试官会一直追问，直到你说出代价为止。
- **把评测留到最后一句带过。** Agent 岗的系统设计，评测往往是最被看重的部分。
- **只刷题不做项目。** 题库是用来查漏的，项目才是面试的主体。

## 练习

**1.** 用六步框架，自己完整讲一遍「设计一个 Deep Research agent」，录音后对照示范一检查漏了哪一步、哪一步没讲代价。

<details>
<summary>提示</summary>

题库里「设计多 agent 协作、产出带引用报告的 Deep Research」那一行已经给了骨架：编排者加执行者，子 agent 只回传摘要，最后单独核对引用。

按六步自查最容易漏的地方：第 2 步要说清哪段固定（最后的引用核对、报告格式）、哪段交给模型（搜什么、搜几轮）；第 4 步讲子 agent 隔离上下文时，补上代价（token 多花几倍），参考 [十道高频题](02-top-questions.md) 第 7 题和 [Sub Agent](../p1-tools/10-sub-agent.md)；第 6 步讲怎么判卷，比如引用是否真的支持结论。

</details>

**2.** 从概念题表里随机挑五道，每道限时一分钟作答。答不上的，顺着「答案在」那一列回去读，第二天再答一遍。

<details>
<summary>提示</summary>

「答案在」一列的链接就是回读的入口。限时一分钟，标准参考 [十道高频题](02-top-questions.md) 开头讲的结构：先一句结论，再一个例子，最后一句代价。

第二天重答时，重点看是否还要靠回忆原文的措辞。如果还在背句子，说明理解没到位；换个角度说一遍，比如用你自己的项目举例。

</details>

**3.** 开放题：示范二里「转人工率下降，但同一个用户隔天又来问」这个信号，你还能想到哪些类似的「指标看着变好，其实在变坏」的情况？怎么设计监控发现它们？

<details>
<summary>提示</summary>

判断方向：找「代理指标」和「真实目标」可以被分开的地方，被优化的往往是更容易动的那一个。几个例子：

- 平均对话轮数下降，但用户其实是放弃了；
- 工具调用失败率下降，因为模型不再调用工具，直接编答案；
- LLM 评委打分上升，但和人工标注的一致率在下降（评委被讨好了）；
- 平均 token 下降，因为压缩更激进，长任务的完成率掉了。

监控设计：每个指标配一个「反向指标」成对看（转人工率配重复来访率）；按最终状态判分而不是看措辞；定期抽样人工复核、校准评委。原理在 [Agent 评测实践指南](../p3-agent-internals/14-agent-eval-guide.md) 和 [可观测性](../p2-agent-basics/08-agent-observability.md)。

</details>

## 延伸阅读

- [2025 秋招 Agent 开发 TOP100](https://juejin.cn/post/7558320134252544034)：概念题覆盖最全的中文清单
- [What the agent system design interview really tests](https://www.techinterview.org/post/3233476823/agent-system-design-interview/)：系统设计的评分视角
- [Grokking the AI System Design Interview · Autonomous coding agent](https://www.designgurus.io/course-play/grokking-the-ai-system-design-interview/doc/scenario-an-autonomous-coding-agent)：Coding Agent 设计题的另一种展开
- [OpenSpec](https://github.com/Fission-AI/OpenSpec)、[Spec Kit](https://github.com/github/spec-kit)：面试里出现过的规格驱动开发工具，本库未展开

[^c1]: [2026 大厂 AI Agent 面试全攻略](https://adg.csdn.net/6a82f7fa10ee7a33f29c2607.html)（二手汇总，2026-08）
[^c2]: [大疆 AI Agent 开发岗面试实录](https://adg.csdn.net/6a87b666662f9a54cb9f1356.html)（2026-08）
[^j1]: [2025 秋招 Agent 开发 TOP100](https://juejin.cn/post/7558320134252544034)（2025-10）
[^n1]: [牛客 · 字节 Agent 开发实习一面](https://www.nowcoder.com/feed/main/detail/931a8a935a5e4b4f8d0b71cd4e818604)（候选人自述）
[^t1]: [techinterview · applied-AI 面试](https://www.techinterview.org/post/3233476824/ai-engineer-interview-rag-agents-evals/)（2026-07）
[^t2]: [techinterview · agent 系统设计](https://www.techinterview.org/post/3233476823/agent-system-design-interview/)（2026-07）
[^p1]: [PromptLayer · Agentic System Design Interview](https://blog.promptlayer.com/the-agentic-system-design-interview-how-to-evaluate-ai-engineers/)（2025-07）
[^swe]: [Why we no longer evaluate SWE-bench Verified](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)（OpenAI，2026-02）
[^tau]: [τ²-bench](https://arxiv.org/abs/2506.07982)
[^metr]: [METR · Time Horizons](https://metr.org/time-horizons/)
[^a2a]: [A2A 一周年](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)（Linux Foundation，2026-04）
