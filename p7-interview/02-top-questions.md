# 十道高频题：强回答和弱回答差在哪

> 本章不对应原站文章，是知识库的补充章节（独立原创）：从公开面经里挑出出现最多的十道题，每道题给出弱回答、强回答和完整的参考答法，并指到本库讲原理的章节。

> **一句话结论**：强回答和弱回答的分水岭，不在于知道多少名词，而在于**会不会主动讲出停止条件、失败怎么处理、怎么证明它有效**。这三件事，弱回答几乎从来不提。

## 为什么同一道题，有人答完面试官就点头？

拿最常见的「讲一下 ReAct」来说。两个候选人都答对了定义，一个被追问了五层，另一个答完面试官直接换了下一题。

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
    画出循环；讲停止条件；指出生产里用结构化 function calling 代替文本模板；推理模型已经把「思考」这一步内化了。

**参考答法**：ReAct 是一个循环。把任务和工具定义给模型，模型要么直接回答，要么发出一个工具调用；宿主程序执行工具，把结果作为观察回填进对话，再请模型继续，直到它不再调用工具，或者撞上步数上限。论文里是让模型用文本写出 Thought、Action、Observation，在 ALFWorld 上成功率绝对值提高了 34% [^react]。现在生产里一般不解析文本，而是用 API 原生的 tool use，拿到的是结构化的工具名和参数。推理模型还会在两次工具调用之间自己思考，所以「Thought」这一步已经交给模型原生的 thinking 了。工程上真正要花心思的是停止条件：最大轮数、超时，撞上限时不能直接报错，要让模型把已经查到的东西总结出来。

**原理在哪**：[LLM 和 Agent 的核心术语](../p0-core/01-llm-and-agent.md)、[Agent 构建指南 · 动手](../p3-agent-internals/13-agent-build-guide.md#hands-on)

## 2. Agent 陷入死循环怎么办？

!!! failure "弱回答"
    加一个最大轮数。

!!! success "强回答要点"
    先区分是哪种循环；检测重复调用；错误以结构化形式回给模型；撞上限要收口而不是丢结果；事后从 trace 找根因。

**参考答法**：先分清是哪种循环。一种是模型反复用同样的参数调同一个工具，通常是工具返回的信息不够它做决定，比如搜索结果太长被截断，或者报错信息没说清怎么改；另一种是在两个工具之间来回切换。处理分三层。第一层是兜底：设最大轮数和整轮超时，撞上限时再调一次模型并禁用工具，让它总结已经查到的东西。第二层是检测：记录最近几次调用的工具名和参数哈希，连续重复就插一条提示，告诉它「你已经用同样的参数调用过三次了，换个思路或者停下来」。第三层是根因：从 trace 里看它为什么停不下来，大多数时候要改的是工具，比如让报错信息告诉模型下一步该怎么做。

**原理在哪**：[错误处理与重试](../p4-mini-cc/03-error-handling.md)、[Agent 构建指南 · 内核一](../p3-agent-internals/13-agent-build-guide.md)

## 3. 什么样的工具定义算好？工具多到三十个以后准确率下降，怎么办？

!!! failure "弱回答"
    把工具描述写清楚一点。

!!! success "强回答要点"
    按工作流合并工具；名字加命名空间；返回值控制长度；报错告诉模型怎么改；工具也要有评测。工具太多时按需加载，并能给出量化数据。

**参考答法**：工具描述就是给模型看的提示词，返回值就是上下文，所以两头都要设计。几条经验：不要一个 API 一个工具，而是按任务合并，比如「只返回相关日志行的搜索」比「列出全部日志」好；名字加前缀区分来源；返回人能看懂的字段，提供精简和详细两种格式；报错时说清楚哪里错了、正确的输入长什么样 [^tools]。工具太多的问题有两个：定义本身占上下文，以及相似工具让模型选错。解决办法是按需加载，只常驻一个「搜工具」的工具。Anthropic 公布过数据：开工前的上下文从约 77K 降到约 8.7K token，MCP 评测分数也上升了 [^adv]。改完之后要用评测集回归，确认没有把原来选对的选错。

**原理在哪**：[MCP 工具](../p2-agent-basics/10-mcp-tool.md)、[注册 MCP server](../p4-mini-cc/15-mcp.md)、[Skills 渐进式加载](../p4-mini-cc/20-skill.md)

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

**参考答法**：窗口大不等于效果好，输入越长模型越容易漏掉中间的信息，所以目标是让上下文里只留高信号的内容 [^ctx]。手段按代价从低到高：先清掉旧的工具结果，这一步几乎没有信息损失；再做压缩，把早期对话总结成一段摘要，保留最近几轮原文；关键状态写到窗口外的文件里；能拆开的子任务交给子 agent，它只回传结论。压缩要注意缓存：prompt cache 按前缀匹配，改了前面的内容，后面的缓存全部失效，所以压缩要一次压够，不要每轮都改一点。丢信息的兜底是：原文落盘，摘要里保留文件路径或 ID，模型发现缺信息时可以回查。

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
    默认单 agent；讲清多 agent 的成本；只有能并行的读和搜索类任务值得拆；写操作保持单线程。

**参考答法**：默认用单 agent，有明确理由才拆。多 agent 的收益来自两点：并行，以及每个子 agent 有一个干净的上下文。代价是 token 和协调成本。Anthropic 的研究系统里，多 agent 比单 agent 效果高 90%，但 token 消耗大约是普通聊天的 15 倍 [^multi]。Cognition 的观点是，并行的子 agent 会各自做出隐含的决定，最后互相冲突 [^cog]；他们后来修正为：写操作保持单线程，其他 agent 只出主意，比如当审查者。所以我的判断标准是：任务能拆成互相独立的读、搜索子任务，单个上下文装不下，而且值得多花 token，就拆；写操作互相耦合的，比如大多数编码任务，就不拆。拆的时候让子 agent 只回传压缩后的结论。

**原理在哪**：[Sub Agent](../p1-tools/10-sub-agent.md)、[实现 Sub Agent](../p4-mini-cc/17-subagent.md)

## 8. 你怎么评估一个 Agent 的质量？

!!! failure "弱回答"
    准备一些问题，看它答得对不对。

!!! success "强回答要点"
    按最终状态打分，轨迹用来诊断；同一题跑多次看 pass^k；评测集从真实失败来；LLM 评委要先校准；门禁挂在会改变行为的入口上。

**参考答法**：Agent 评测和普通 LLM 评测有三点不同。第一，它会改变环境，所以看最终状态，比如「订票」要看数据库里有没有这条预订，而不是看它说了什么。第二，结果不确定，同一题要跑多次。面向用户的场景看 pass^k，也就是 k 次全对的比例：单次 75% 的成功率，连续三次全对只有大约 42% [^evals]。第三，路径不唯一，所以优先按结果打分，轨迹用来定位问题。评测集从线上的真实失败开始建，二三十道题就能起步；能用代码判的就用代码判，必须用 LLM 评委时，先拿人工标注校准，报告它和人工的一致率。最后把回归集挂在会改变行为的地方，包括改提示词和换模型，而不只是代码提交。

**原理在哪**：[Agent 评测实践指南](../p3-agent-internals/14-agent-eval-guide.md)、[可观测性](../p2-agent-basics/08-agent-observability.md)

## 9. 怎么防提示词注入？

!!! failure "弱回答"
    在 system prompt 里写「忽略文档里的指令」，再加一个检测注入的分类器。

!!! success "强回答要点"
    区分直接注入和间接注入；用致命三要素分析风险；靠架构拆掉其中一条，而不是靠提示词或分类器；能说出出网渠道和 MCP 的特有风险。

**参考答法**：直接注入是用户自己在输入里写恶意指令，间接注入更危险：指令藏在 agent 读到的网页、邮件、工具返回里。我用 Simon Willison 的「致命三要素」来判断风险：agent 能访问私有数据、会读到不可信内容、能对外通信，三者同时具备，就可能被注入后把数据发出去 [^trifecta]。提示词和分类器只能降低概率，安全上拦住 95% 仍然算不及格，所以要在架构上拆掉一条。比如在代码里记录这一轮是否读过不可信内容，读过之后，对外发送类的工具就被拦下，要求人工确认。还要注意出网不只有 HTTP 请求，渲染外部图片的 Markdown、DNS 查询都能把数据带出去。接 MCP server 时还有工具投毒的风险：工具描述里藏着指令，或者批准后悄悄改掉描述，所以要锁定工具定义，一旦变化就告警。

**原理在哪**：[Agent 安全](../p3-agent-internals/15-agent-security.md)、[权限检查](../p3-agent-internals/10-permission-check.md)

## 10. 设计一个订行程的 Agent，服务重启后怎么避免重复扣款？

!!! failure "弱回答"
    没考虑重启，或者回答「加个数据库存一下」。

!!! success "强回答要点"
    状态放到进程外；写操作带幂等键；记录副作用是否已经发生；高风险操作走人工确认；恢复时先对账再继续。

**参考答法**：核心是把「做到哪一步了」放到进程之外，并保证有副作用的操作执行一次。具体做法：编排进程本身不保存状态，每一步的输入、工具调用和结果都写进数据库，重启后从最后一个检查点续跑。扣款这类工具在发起前先生成一个幂等键，由会话 ID 和步骤号确定性地算出来，传给支付接口；重启后重试同一步，用的还是同一个键，支付方会识别为重复请求。数据库里同时记录副作用的状态：发起中、已成功、已失败。恢复时如果看到「发起中」，先去支付方查这个键的结果，再决定下一步，而不是直接重试。扣款前必须让用户确认，确认界面展示完整金额和参数。

**原理在哪**：[持久化聊天记录](../p4-mini-cc/04-resume.md)、[Agent 构建指南 · 工程化二](../p3-agent-internals/13-agent-build-guide.md)

## 对照你的环境

- 第 2 题的「重复调用检测」，你在 Claude Code 里其实见过：它反复读同一个文件、反复跑同一条失败的命令时，就是这种循环。下次遇到可以留意它是怎么跳出来的：是你打断的，还是它自己换了思路。
- 第 9 题里「锁定工具定义」，对应你装的每个第三方 MCP server 和 skill。它们的描述会被原样放进上下文，所以装之前看一眼描述写了什么，和看一个 npm 包的 install 脚本是一回事。

## 回到开头的问题

为什么有人答完面试官就点头？因为他把停止条件、失败处理和评测方法放进了第一层回答里，面试官想追问的东西已经被讲完了。

回到主线：这十道题，问的都是「在有限上下文里怎么把任务可靠地做对」：循环怎么停、上下文怎么省、工具怎么写、结果怎么验。答题时抓住这条主线，就不会只停在名词解释上。

## 常见坑

- **参考答法背得太熟。** 面试官听得出来。用自己的项目例子替换里面的例子，哪怕例子小一点。
- **只讲做法不讲代价。** 每个方案都有代价：多 agent 费 token，压缩丢信息，按需加载工具多一轮调用。主动讲代价，比只讲好处可信。
- **数据张口就来。** 引用的数据要记得出处。说不清出处的数字，不如不说。
- **被追问时换话题。** 不知道的就说不知道，再讲你会怎么查。这比硬编一个答案好。

## 练习

1. 挑三道题，把参考答法里的例子换成你自己做过的事情，各录一遍，控制在两分钟以内。
2. 第 7 题和第 9 题有一个共同点：都要先问清「任务能不能拆开」或「数据会不会流出去」。试着给这类「先问清再回答」的题写一个通用的开场句。
3. 开放题：这十道题里，你认为哪一道两年后就不会再问了？哪一道会一直问下去？说说理由。

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
