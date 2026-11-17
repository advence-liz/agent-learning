# Agent 核心机制：从循环、工具到 RAG、评测与安全

> 本章不对应原站文章，是知识库的补充章节（独立原创）：围绕 Agent 的控制流、上下文与质量，组织原理追问、强弱回答与练习。题目结合公开面经线索和教学设计，不作频率排名。

> **一句话结论**：强回答和弱回答的分水岭，不在于知道多少名词，而在于**会不会主动讲出停止条件、失败怎么处理、怎么证明它有效**。这三件事，弱回答几乎从来不提。

## 为什么同一道题，有人答完面试官就点头？

拿「讲一下 ReAct」来说。两个候选人都答对了定义，一个被追问了五层，另一个答完面试官直接换了下一题。

区别在于第二个人在第一层就把面试官想追问的东西讲掉了：循环怎么停、工具报错怎么办、为什么生产里不用文本版 ReAct。面试官的追问，本质上是在找你还没讲到的那块。

所以这一章的每道题都按同一个结构写：

- **弱回答**：常见的、会被继续追问的答法
- **强回答要点**：面试官希望听到的几个点
- **参考答法**：一段可以直接说出口的完整回答，大约一两分钟
- **原理在哪**：本库讲清这件事的章节

参考答法只是示范。真正面试时，把里面的例子换成你自己项目里的，效果会好得多。

## 1. 讲一下 ReAct agent 的原理

!!! failure "弱回答"
    ReAct 就是 Reasoning 加 Acting，让模型先思考再行动。

!!! success "强回答要点"
    画出循环；讲停止条件；指出生产里用结构化 function calling 代替文本模板；结构化工具调用不等于必须公开输出 Thought。

**参考答法**：ReAct 是一个循环。把任务和工具定义给模型，模型要么直接回答，要么发出一个工具调用；宿主程序执行工具，把结果作为观察回填进对话，再请模型继续，直到它不再调用工具，或者撞上步数上限。论文里是让模型用文本写出 Thought、Action、Observation，在 ALFWorld 上成功率绝对值提高了 34% [^react]。现在生产里一般不解析文本，而是用 API 原生的 tool use，拿到的是结构化的工具名和参数。某些推理模型支持工具调用间的内部推理，但具体接口不同，不能把显式 Thought 模板当成所有模型必需的协议。工程上真正要花心思的是停止条件：最大轮数、超时，撞上软预算可以在预留额度内收口；硬超时、取消或安全中断时不能无条件再调模型。

**原理在哪**：[LLM 和 Agent 的核心术语](../p0-core/01-llm-and-agent.md)、[Agent 构建指南](../p3-agent-internals/13-agent-build-guide.md)的[「动手：给循环写好三个 break」](../p3-agent-internals/13-agent-build-guide.md#hands-on)一节

## 2. Agent 陷入死循环怎么办？

!!! failure "弱回答"
    加一个最大轮数。

!!! success "强回答要点"
    先区分是哪种循环；检测重复调用；错误以结构化形式回给模型；撞上限要收口而不是丢结果；事后从 trace 找根因。

**参考答法**：先分清是哪种循环。一种是模型反复用同样的参数调同一个工具，通常是工具返回的信息不够它做决定，比如搜索结果太长被截断，或者报错信息没说清怎么改；另一种是在两个工具之间来回切换。处理分三层。第一层是兜底：设最大轮数和整轮超时；若只是软预算且仍有预留额度，可禁用工具再做一次总结。若已硬超时、取消或遇到安全阻断，就停止并返回已持久化的进度，不再无条件发起模型调用。第二层是检测：记录最近几次调用的工具名和参数哈希，连续重复就插一条提示，告诉它「你已经用同样的参数调用过三次了，换个思路或者停下来」。第三层是根因：从 trace 里看它为什么停不下来，大多数时候要改的是工具，比如让报错信息告诉模型下一步该怎么做。

**原理在哪**：撞上限收口和软预算见 [Agent 构建指南](../p3-agent-internals/13-agent-build-guide.md)的「内核一」和「动手」两节，那里有离线可跑的代码。[mini Claude Code](../p4-mini-cc/01-cli.md) 撞上限时目前只发一条提示、以 `max_iterations` 结束，并不收口；构建指南的练习 1 就是把收口搬进 mini Claude Code，做完再拿来讲项目。工具报错怎么回填给模型，见[错误处理与重试](../p4-mini-cc/03-error-handling.md)。重复调用检测本库没有实现。

## 3. 什么样的工具定义算好？工具多到三十个以后准确率下降，怎么办？

!!! failure "弱回答"
    把工具描述写清楚一点。

!!! success "强回答要点"
    按工作流合并工具；名字加命名空间；返回值控制长度；报错告诉模型怎么改；工具也要有评测。工具太多时按需加载，并能给出量化数据。

**参考答法**：工具描述就是给模型看的提示词，返回值就是上下文，所以两头都要设计。几条经验：不要一个 API 一个工具，而是按任务合并，比如「只返回相关日志行的搜索」比「列出全部日志」好；名字加前缀区分来源；返回人能看懂的字段，提供精简和详细两种格式；报错时说清楚哪里错了、正确的输入长什么样 [^tools]。工具太多的问题有两个：定义本身占上下文，以及相似工具让模型选错。解决办法是按需加载，只常驻一个「搜工具」的工具。Anthropic 公布过数据：开工前的上下文从约 77K 降到约 8.7K token，MCP 评测分数也上升了 [^adv]。改完之后要用评测集回归，确认没有把原来选对的选错。

**原理在哪**：[工具设计：写给模型用的接口](../p2-agent-basics/12-tool-design.md)（粒度、返回值、错误信息、按需加载，有离线对照实验）、[MCP 工具](../p2-agent-basics/10-mcp-tool.md)、[注册 MCP server](../p4-mini-cc/15-mcp.md)、[Skills 渐进式加载](../p4-mini-cc/20-skill.md)

## 4. Agent 的记忆怎么设计？

!!! failure "弱回答"
    用一个向量库存历史对话。

!!! success "强回答要点"
    先分短期和长期；回答谁来写、存成什么、怎么读、怎么更新、怎么保证安全；对比几种实现的取舍。

**参考答法**：短期记忆就是当前的 messages，靠压缩控制长度；长期记忆是跨会话的外部存储，设计时要回答五个问题。谁来写：模型自己决定写什么，还是后台从对话里抽取。存成什么：文件、键值、向量还是图。怎么读：常驻在上下文里，还是按需检索。怎么更新：新旧信息冲突时怎么合并、过期了怎么删。怎么保证安全：按用户隔离、过滤敏感信息、防路径穿越。几种实现正好代表不同选择：Claude Code 用 Markdown 文件，常驻加按需读取；mem0 用模型抽取事实，再和已有记忆合并；Zep 用带时间的知识图谱，能回答「某件事是什么时候变的」。我会按场景选：个人助手用文件就够，多用户的客服更需要抽取和合并。

**原理在哪**：[Claude Code 自动记忆](../p3-agent-internals/06-auto-memory.md)、[mem0](../p3-agent-internals/08-mem0-memory.md)、[Zep](../p3-agent-internals/09-zep-memory.md)

## 5. 上下文窗口满了怎么办？压缩丢了关键信息怎么办？

!!! failure "弱回答"
    截断前面的对话，或者换一个更长上下文的模型。

!!! success "强回答要点"
    按代价从低到高排几种手段；讲压缩和 prompt cache 的冲突；给出丢信息的兜底方案。

**参考答法**：窗口大不等于效果好，输入越长模型越容易漏掉中间的信息，所以目标是让上下文里只留高信号的内容 [^ctx]。手段按代价从低到高：先清理可重取、低价值的旧工具结果，同时保留引用与必要状态；再做压缩，把早期对话总结成一段摘要，保留最近几轮原文（保留尾部要先处理 thinking 块，否则会失效甚至请求报 400，见 [compact](../p4-mini-cc/14-compact.md)）；关键状态写到窗口外的文件里；能拆开的子任务交给子 agent，它只回传结论。压缩要注意缓存：prompt cache 按前缀匹配，改了前面的内容，后面的缓存全部失效，所以压缩要一次压够，不要每轮都改一点。丢信息的兜底是：原文落盘，摘要里保留文件路径或 ID，模型发现缺信息时可以回查。

**原理在哪**：[上下文和 token 计费](../p0-core/03-messages-and-tokens.md)、[上下文压缩](../p3-agent-internals/05-context-compaction.md)、[compact](../p4-mini-cc/14-compact.md)

## 6. Agent 和 Workflow 有什么区别？什么时候不该用 Agent？

!!! failure "弱回答"
    Agent 更智能，能自主决策，所以优先用 Agent。

!!! success "强回答要点"
    一条分界线：控制流由谁决定；先用最简单的方案；说出几种 workflow 模式和各自适用的场景。

**参考答法**：区别只有一个：控制流由谁决定。Workflow 的步骤写在代码里，模型只负责其中几步的内容；agent 把「下一步做什么」交给模型。能提前写死流程的任务，用 workflow 更稳定、更便宜、也更好调试；只有步数和路径事先没法知道的任务，才值得用 agent。Anthropic 列过五种 workflow 模式：串行链、路由、并行、编排者加执行者、生成加评审 [^bea]。比如每天定时汇总工单发报告，流程固定，就该用 workflow；修一个不知道在哪的 bug，才需要 agent。

**原理在哪**：[Workflow 和 Agent](../p2-agent-basics/05-workflow-vs-agent.md)

## 7. 什么时候该拆成多个 Agent？

!!! failure "弱回答"
    任务复杂就拆，每个 agent 负责一个角色。

!!! success "强回答要点"
    默认单 agent；讲清多 agent 的成本；优先拆独立子任务；共享写要隔离、串行化或显式协调。

**参考答法**：默认用单 agent，有明确理由才拆。多 agent 的收益来自两点：并行，以及每个子 agent 有一个干净的上下文。代价是 token 和协调成本。Anthropic 报告过其特定研究任务的多 agent 收益与较高 token 消耗，这不是任意任务都能复现的提升比例 [^multi]。Cognition 的观点是，并行的子 agent 会各自做出隐含的决定，最后互相冲突 [^cog]；他们后来修正为：写操作保持单线程，其他 agent 只出主意，比如当审查者。所以我的判断标准是：任务能拆成相对独立的子任务、有上下文隔离或并行收益，而且收益覆盖协调成本，就考虑拆；共享写操作先做所有权与冲突控制，不能凭“分了角色”就安全并行。拆的时候让子 agent 只回传压缩后的结论。

**原理在哪**：[Sub Agent](../p1-tools/10-sub-agent.md)、[实现 Sub Agent](../p4-mini-cc/17-subagent.md)

## 8. 你怎么评估一个 Agent 的质量？

!!! failure "弱回答"
    准备一些问题，看它答得对不对。

!!! success "强回答要点"
    按最终状态打分，轨迹用来诊断；同一题跑多次看 pass^k；评测集从真实失败来；LLM 评委要先校准；门禁挂在会改变行为的入口上。

**参考答法**：Agent 评测和普通 LLM 评测有三点不同。第一，它会改变环境，所以看最终状态，比如「订票」要看数据库里有没有这条预订，而不是看它说了什么。第二，结果不确定，同一题要跑多次。面向用户的场景看 pass^k，也就是 k 次全对的比例：在三次独立且同成功率的假设下，单次 75% 的成功率，连续三次全对约 42% [^evals]。第三，路径不唯一，所以优先按结果打分，轨迹用来定位问题。评测集从线上的真实失败开始建，二三十道题就能起步；能用代码判的就用代码判，必须用 LLM 评委时，先拿人工标注校准，报告它和人工的一致率。最后把回归集挂在会改变行为的地方，包括改提示词和换模型，而不只是代码提交。

**原理在哪**：[Agent 评测实践指南](../p3-agent-internals/14-agent-eval-guide.md)、[可观测性](../p2-agent-basics/08-agent-observability.md)

## 9. 怎么防提示词注入？

!!! failure "弱回答"
    在 system prompt 里写「忽略文档里的指令」，再加一个检测注入的分类器。

!!! success "强回答要点"
    区分直接注入和间接注入；用致命三要素分析风险；靠架构拆掉其中一条，而不是靠提示词或分类器；能说出出网渠道和 MCP 的特有风险。

**参考答法**：直接注入是用户自己在输入里写恶意指令，间接注入更危险：指令藏在 agent 读到的网页、邮件、工具返回里。我用 Simon Willison 的「致命三要素」来判断风险：agent 能访问私有数据、会读到不可信内容、能对外通信，三者同时具备，就可能被注入后把数据发出去 [^trifecta]。提示词和分类器只能降低概率，安全上拦住 95% 仍然算不及格，所以要在架构上拆掉一条。比如在代码里记录这一轮是否读过不可信内容，读过之后，对外发送类的工具就被拦下，要求人工确认。还要注意出网不只有 HTTP 请求，渲染外部图片的 Markdown、DNS 查询都能把数据带出去。接 MCP server 时还有工具投毒的风险：工具描述里藏着指令，或者批准后悄悄改掉描述，所以要锁定工具定义，一旦变化就告警。

**原理在哪**：[Agent 安全](../p3-agent-internals/15-agent-security.md)、[权限检查](../p3-agent-internals/10-permission-check.md)

## 10. RAG 找错了还是模型编了，怎么区分？

!!! failure "弱回答"
    换 embedding 模型，或者把 chunk 调大一点。

!!! success "强回答要点"
    分开测摄取、检索和生成；先判断答案是否存在与可见，再看召回和排序；最后检查回答是否被证据支持，拒答单独计数。

**参考答法**：先在有标注的小集合上检查文档是否成功解析、是否被权限过滤、索引是否及时更新。检索侧看 Recall@k、排序和答案相关片段，生成侧在固定证据下测正确性、忠实性与引用支撑；有答案与无答案问题分开。需要精确关键词时混合词法和向量检索，候选太杂时考虑 rerank，但增加延迟与成本。Agentic RAG 让模型决定是否检索、如何改写与再检索，也需要轮数和预算上限；不能把多跑几轮当作质量证明。

**原理在哪**：[RAG 原理](../p2-agent-basics/04-rag-principles.md)、[RAG 评测](../p3-agent-internals/16-rag-eval.md)。

## 11. 提示词写得越详细、JSON 越规范，就越可靠吗？

!!! failure "弱回答"
    system prompt 写清角色、给几个例子，再要求只输出 JSON。

!!! success "强回答要点"
    指令层级与不可信材料分离；任务、输出和失败协议清楚；用代表性示例与版本化评测验证；结构合法不等于业务正确或有权执行。

**参考答法**：先把任务边界和成功条件写清，外部文档只能作为数据，不能升级成授权。示例覆盖正常、缺信息、拒绝和工具失败，避免只教快乐路径。结构化输出减少解析问题，但仍要运行时 schema、业务约束和权限检查。改提示词时固定模型、工具、检索与评测集做对照，记录失败切片和成本；否则不知道是指令真的改善了，还是换了条件。

**原理在哪**：[System Prompt](../p3-agent-internals/03-system-prompt.md)、[工具设计](../p2-agent-basics/12-tool-design.md)、[评测指南](../p3-agent-internals/14-agent-eval-guide.md)。

## 按机制查漏：尚未讲透的追问回到原理章

上面的答法不重复列在表里。下表只收扩展追问：L1 是概念边界，L2 是机制与实现，L3 是诊断与取舍，不对应特定面试轮次。

| 题目 | 难度 | 答案在 |
|---|---|---|
| ReAct、Plan-and-Execute、Reflexion 有什么区别 | L2 | ReAct 见[核心术语](../p0-core/01-llm-and-agent.md)；Plan-and-Execute 和 Reflexion 本库未展开，见 [Reflexion 论文](https://arxiv.org/abs/2303.11366)；「先规划再执行」的思路可参考 [Plan-and-Solve 论文](https://arxiv.org/abs/2305.04091)。[Plan Mode](../p3-agent-internals/11-plan-mode.md) 讲的是 Claude Code 里「只规划、经你批准再动手」的实现，可以当先规划再执行的工程例子，但没有对比这几种范式 |
| MCP 和 Function Calling 有什么区别 | L1 | Function Calling 见[核心术语](../p0-core/01-llm-and-agent.md)，MCP 见 [MCP 工具](../p2-agent-basics/10-mcp-tool.md) |
| MCP 里 Resources 和 Tools 的区别；传输方式怎么选 | L2 | [MCP 协议](../p2-agent-basics/11-mcp-protocol.md) |
| Agentic RAG 和传统 RAG 有什么区别 | L2 | [RAG 原理](../p2-agent-basics/04-rag-principles.md) |
| 从 ES 换成向量检索，哪些能力变弱、哪些变强 | L2 | [RAG 原理](../p2-agent-basics/04-rag-principles.md) |
| chunk 策略和大小怎么定；混合检索；为什么要 rerank | L2 | chunk 见 [RAG 问答机器人](../p2-agent-basics/03-rag-qa-bot.md)和 [RAG 原理](../p2-agent-basics/04-rag-principles.md)的实验 1；混合检索和 rerank 见 [RAG 原理](../p2-agent-basics/04-rag-principles.md)的「混合检索和 rerank」一节 |
| 你的 Recall@5 是怎么做到的，怎么防过拟合 | L3 | [评测实践指南](../p3-agent-internals/14-agent-eval-guide.md) + 你的项目 |
| 幻觉的成因和缓解方法；怎么做引用溯源 | L2 | 成因本库未系统展开，见 [Why Language Models Hallucinate](https://arxiv.org/abs/2509.04664)；[token 预测](../p0-core/04-llm-token-prediction.md)的「第三步」只解释了其中一点：逐 token 抽样，一步抽歪，后面就顺着歪掉的前缀往下写。引用溯源的最小做法见 [RAG 问答机器人](../p2-agent-basics/03-rag-qa-bot.md)的「拼 prompt」：只按资料回答并标出处编号 |
| 外部工具出错或超时，怎么容错和恢复 | L2 | [错误处理与重试](../p4-mini-cc/03-error-handling.md) |
| token 用量暴涨怎么排查；一次对话花了 10 万 token，怎么控成本 | L2 | [token 计费](../p0-core/03-messages-and-tokens.md)、[可观测性](../p2-agent-basics/08-agent-observability.md)、[成本控制与模型路由](../p3-agent-internals/17-cost-and-routing.md) |
| LangGraph 的 state、条件边、人在环中；和自己写循环怎么选 | L2 | [SDK 对比](../p2-agent-basics/07-agent-sdk-comparison.md) |
| 什么是 SDD（规格驱动开发） | L2 | 本库未展开，可查 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 与 [Spec Kit](https://github.com/github/spec-kit) |
| 什么是 Harness Engineering，为什么能提升复杂任务的表现 | L3 | [Harness Engineering](../p3-agent-internals/12-harness-engineering.md) |
| 设计或实现过 Agent Skill 吗，有哪些取舍 | L2 | [Skills](../p1-tools/12-skills.md)、[渐进式加载 Skills](../p4-mini-cc/20-skill.md) |
| 模型不可用时怎么降级 | L2 | [错误处理与重试](../p4-mini-cc/03-error-handling.md)只覆盖一部分：529 过载是退避重试（不换模型），服务端 fallback 只在拒答时换模型。「重试用尽后切备用模型」本库未实现，那章练习 3 讨论了换模型对 thinking 块和 prompt cache 的影响，可以从这里展开答 |
| 从用户按下回车到答案返回，中间发生了什么 | L2 | [发一句 Hi 会发生什么](../p3-agent-internals/02-hi-request.md)、[流式响应](../p2-agent-basics/09-streaming-response.md) |



## 跨 Agent 通信：MCP 与 A2A 不在同一层

MCP 侧重 agent 如何接入工具和数据，A2A（Agent2Agent）侧重独立 agent 间的任务委托与结果交换。Agent Card 描述能力，Task 承载生命周期，Message 与 Artifact 表达过程和产出。二者可组合，不是二选一；这里覆盖协议分工，不代表已经实现跨组织互信与任务恢复。[A2A 官方文档](https://a2a-protocol.org/latest/)

## 对照你的环境

日常工具反复调用失败时，试着区分是工具反馈不足、模型策略失误还是终止条件缺失。你给 MCP 和 skills 写的描述也是模型输入；安装与更新时检查来源、能力变化及权限，不因“只是提示词”而忽略信任边界。

## 常见坑

- **把参考答法背成台词。** 用自己的项目例子替换，否则追问到代码就断层。
- **把案例结论绝对化。** 多 agent、缓存、RAG 都要先交代约束和失效条件。
- **只答机制不说证据。** 提升率、通过率与成本要说明基线、数据集和运行次数。

## 练习

**1.** 不看书写一段带步数、时间与成本预算的工具循环，并解释工具报错如何回填。

<details><summary>提示</summary>

用离线 fake 响应覆盖直接回答、工具失败、重复调用和撞上限；不要把再次调用模型总结当成没有额外时间与成本的免费操作。

</details>

**2.** 选 RAG、压缩、多 Agent 三者之一，给出一个“指标变好但任务变差”的反例。

<details><summary>提示</summary>

例如压缩省 token 却丢授权条件；召回更多却混入旧政策；多 agent 并行加速却让引用失真。按结果与反向指标一起测。

</details>

**3.** 开放题：同一任务，何时先改提示词、工具、检索、训练或固定流程？

<details><summary>提示</summary>

从失败切片定位瓶颈再选干预，明确控制变量和拒绝该方案的条件；训练的原理与证据要求回看[模型原理与训练](02-model-fundamentals.md)。

</details>

回到主线：循环决定下一步给模型什么输入、允许什么动作，评测和权限负责限制后果。下一章：[全栈与生产工程](04-production-engineering.md)，把这个循环交付成可以恢复和观测的产品。

## 延伸阅读

- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)：第 3 题的依据
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)：第 5 题的依据
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)：第 8 题的依据
- [What the agent system design interview really tests](https://www.techinterview.org/post/3233476823/agent-system-design-interview/)：强弱回答对照的另一个视角

[^react]: [ReAct 论文](https://arxiv.org/abs/2210.03629)
[^tools]: [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)（Anthropic，2025-09）
[^adv]: [Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)（Anthropic，2025-11）
[^ctx]: [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)（Anthropic，2025-09）；[Context Rot](https://www.trychroma.com/research/context-rot)（Chroma，2025-07）
[^bea]: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)（Anthropic，2024-12）
[^multi]: [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)（Anthropic，2025-06）
[^cog]: [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)（2025-06）；[Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working)（2026-04）
[^evals]: [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)（Anthropic，2026-01）
[^trifecta]: [The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)（Simon Willison，2025-06）
