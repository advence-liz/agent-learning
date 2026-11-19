# 其他主流 Agent SDK 对比

> 对应原站：[其他主流 Agent SDK 对比](https://labuladong.online/zh/ai-coding/basics/agent-sdk-comparison/)（会员内容；本章为独立原创重写）

> **一句话结论**：Agent SDK 围绕的内核还是 [Coding Agent](02-coding-agent.md) 那个「模型 + 工具 + 循环」，选型看**它替你多做哪一块，以及你要控制到哪一层**。LangChain、LangGraph、DeepAgents 还可以上下组合，不必当成三个平级选项；框架省掉的是通用机制，不是你的业务系统。

上一章我们用 Claude Agent SDK 把 Coding Agent 缩成了几十行。可你刷技术圈，满屏都是 LangGraph、Pydantic AI、OpenAI Agents SDK、CrewAI……

你可能会问：它们是不是在解决同一个问题？我是不是应该挑一个「最好的」学透？

它们确实都在跑同一个循环。但就像都是「数据请求库」，axios、SWR、TanStack Query 各自优化的方向不同。这一章用**同一个任务**（读 `calc.py` → 把 `a - b` 改成 `a + b`）分别写一遍，让你看到每个 SDK 的「性格」。

## 先跑起来看看

两个能离线跑的版本在 [`code/agent-node/sdk_compare/`](../code/agent-node/sdk_compare/)（Python 版 [`code/agent/sdk_compare/`](../code/agent/sdk_compare/)）。我在 `code/agent` 里装了 `pydantic-ai-slim`（2.59.0）和 `langgraph`（1.2.16），Node 版在 `code/agent-node` 里装了 `ai`（7.0.148）和 `@langchain/langgraph`（1.5.2），都提供了不需要真模型的测试方式。

**Pydantic AI**（Node 版 [`ai_sdk_agent.ts`](../code/agent-node/sdk_compare/ai_sdk_agent.ts)；Python 版 [`pydantic_ai_agent.py`](../code/agent/sdk_compare/pydantic_ai_agent.py)，用官方的 `FunctionModel` 当离线模型）：

=== "Node"

    Node 生态里对应 Pydantic AI 位置的是 Vercel AI SDK（npm 包 `ai`）：同样是模型无关的 `Agent` 抽象 + 类型化工具 + 结构化输出（用 zod 描述）。离线模型用官方 `ai/test` 里的 `MockLanguageModelV4`：

    ```text
    $ node sdk_compare/ai_sdk_agent.ts
    output: { fixed: true, summary: '把 a - b 改成 a + b' }
    messages: [ 'assistant', 'tool', 'assistant', 'tool', 'assistant' ]
    calc.py: return a + b
    usage: requests=3 tool_calls=2 input_tokens=150 output_tokens=30
    ```

    （token 数是 mock 模型里写死的，不是真实计费；`messages` 是 `responseMessages`，不含最初那条 user prompt。）

=== "Python"

    ```text
    $ uv run python -m sdk_compare.pydantic_ai_agent
    output: fixed=True summary='把 a - b 改成 a + b'
    messages: ['ModelRequest', 'ModelResponse', 'ModelRequest', 'ModelResponse', 'ModelRequest', 'ModelResponse', 'ModelRequest']
    calc.py: return a + b
    usage: RunUsage(input_tokens=174, output_tokens=62, requests=3, tool_calls=2)
    ```

（`input_tokens=174` 是 `FunctionModel` 按文本长度估算的，不是真实计费。）

**LangGraph**（[`langgraph_agent.ts`](../code/agent-node/sdk_compare/langgraph_agent.ts)（Python 版 [`langgraph_agent.py`](../code/agent/sdk_compare/langgraph_agent.py)），「模型」节点是一个按脚本返回决定的普通函数）：

=== "Node"

    ```text
    $ node sdk_compare/langgraph_agent.ts
    [llm] {"role":"assistant","tool":"read_file","args":{"path":"calc.py"}}
    [tools] {"role":"tool","content":"def add(a, b):\n    return a - b\n"}
    [llm] {"role":"assistant","tool":"write_file","args":{"path":"calc.py","content":"def add(a, b):\n    return a + b\n"}}
    [tools] {"role":"tool","content":"ok"}
    [llm] {"role":"assistant","text":"已修复：a - b → a + b"}
    ```

=== "Python"

    ```text
    $ uv run python -m sdk_compare.langgraph_agent
    [llm] {'role': 'assistant', 'tool': 'read_file', 'args': {'path': 'calc.py'}}
    [tools] {'role': 'tool', 'content': 'def add(a, b):\n    return a - b\n'}
    [llm] {'role': 'assistant', 'tool': 'write_file', 'args': {'path': 'calc.py', 'content': 'def add(a, b):\n    return a + b\n'}}
    [tools] {'role': 'tool', 'content': 'ok'}
    [llm] {'role': 'assistant', 'text': '已修复：a - b → a + b'}
    ```

它还能把自己画出来（`app.get_graph().draw_mermaid()` 的真实输出，略去样式行；Node 版是 `(await app.getGraphAsync()).drawMermaid()`，只有边的书写顺序不同）：

```d2
direction: down
start: __start__ {shape: oval}
llm: llm
tools: tools
end: __end__ {shape: oval}
start -> llm
llm -> end {style.stroke-dash: 3}
llm -> tools {style.stroke-dash: 3}
tools -> llm
```

把这张图和第 2 章的流程图放一起看，你会发现它们**是同一张图**。

=== "Node"

    ```text
    $ node --test sdk_compare/*.test.ts
    ✔ Vercel AI SDK 离线跑通（对应 Python 版的 Pydantic AI）
    ✔ LangGraph 离线跑通
    ℹ pass 2
    ```

=== "Python"

    ```text
    $ uv run pytest -q sdk_compare
    ..                                                                       [100%]
    2 passed, 1 warning in 0.36s
    ```

（Python 版的 warning 是 `pydantic_graph` 的一条 DeprecationWarning，和本例无关。）

## 四个 SDK，四种性格

### Pydantic AI：把类型安全带进 Agent

=== "Node"

    Node 生态里这个位置用 Vercel AI SDK，写法几乎一一对应：

    ```ts
    const Report = z.object({ fixed: z.boolean(), summary: z.string() });

    const agent = new ToolLoopAgent({
      model,                                       // MockLanguageModelV4（离线）或 anthropic("claude-opus-5-5")
      instructions: "你是编程 Agent。",
      output: Output.object({ schema: Report }),
      tools: {
        read_file: tool({
          description: "读取文件内容。",
          inputSchema: z.object({ path: z.string() }),
          execute: async ({ path }) => FILES[path],
        }),
      },
    });

    const r = await agent.generate({ prompt: "修好 calc.py" });
    r.output        // { fixed: true, summary: ... }，按 zod schema 校验过，不是字符串
    ```

    两处和 Pydantic AI 不同：工具的 schema 来自显式写的 zod 对象（TS 的类型在运行时不存在，没法从函数签名反射）；结构化输出不是一个「交卷工具」，而是请求里带 `responseFormat: json` + schema，模型最后一步直接输出 JSON 文本，框架再用 zod 校验。

=== "Python"

    ```python
    class Report(BaseModel):
        fixed: bool
        summary: str

    agent = Agent(FunctionModel(scripted_model), instructions="你是编程 Agent。", output_type=Report)

    @agent.tool_plain
    def read_file(path: str) -> str:
        """读取文件内容。"""
        return FILES[path]

    r = agent.run_sync("修好 calc.py")
    r.output        # Report(fixed=True, summary=...)，不是字符串
    ```

它最有特色的是两点。第一，工具的 JSON Schema 从**函数签名和 docstring** 自动生成，不用手写。第二，`output_type=Report` 让最终输出变成一个**校验过的 Pydantic 对象**。

你可能会问：结构化输出是怎么实现的？看 `scripted_model` 的最后一步：模型调用了一个叫 `info.output_tools[0].name` 的工具来「交卷」。说穿了，Pydantic AI 把「输出格式」也变成了一个工具，模型调用它，框架校验参数，不合格就让模型重来。

离线测试是它的一等公民：`FunctionModel` / `TestModel` 就是官方版的「fake client」。真实使用时把第一个参数换成 `"anthropic:claude-opus-5-5"` 这样的模型字符串（需要 `pydantic-ai-slim[anthropic]`）。

### LangGraph：把循环画成状态图

=== "Node"

    ```ts
    const State = Annotation.Root({
      messages: Annotation<Msg[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),  // reducer：节点返回的列表会被「追加」
      step: Annotation<number>(),
    });

    const app = new StateGraph(State)
      .addNode("llm", llm)
      .addNode("tools", tools)
      .addEdge(START, "llm")
      .addConditionalEdges("llm", route, ["tools", END])   // ← 第 2 章 while 循环里的那个 if
      .addEdge("tools", "llm")
      .compile();
    ```

=== "Python"

    ```python
    class State(TypedDict):
        messages: Annotated[list[dict], operator.add]   # reducer：节点返回的列表会被「追加」
        step: int

    g = StateGraph(State)
    g.add_node("llm", llm)
    g.add_node("tools", tools)
    g.add_edge(START, "llm")
    g.add_conditional_edges("llm", route, ["tools", END])   # ← 第 2 章 while 循环里的那个 if
    g.add_edge("tools", "llm")
    app = g.compile()
    ```

LangGraph 不关心你用什么模型，节点就是普通函数。它管的是**状态怎么在节点之间流动**：`Annotated[list, operator.add]`（Node 版是带 `reducer` 的 `Annotation`）声明了「每个节点返回的 messages 要追加，不是覆盖」。

它的价值在 Agent 变复杂之后才显现：你想在「工具执行前」停下来等人审批？加一个中断点。想让「审查」和「修复」两个节点循环直到通过？加一条条件边。想崩溃后从第 7 步恢复？它有 checkpoint 机制。这其实是把第 5 章 [Workflow 和 Agent](05-workflow-vs-agent.md) 的光谱**显式化**了：哪些边是写死的（Workflow），哪些边由模型决定（Agent），图上一目了然。

### OpenAI Agents SDK：handoff 是一等公民

这个我没有在本机装和运行，下面的写法来自它的官方 Quickstart 和 Handoffs 文档（安装：`pip install openai-agents`；JS 版 `npm install @openai/agents`）：

=== "Node"

    ```ts
    // 未在本机运行；API 依据 openai.github.io/openai-agents-js 的 quickstart / handoffs 页面（npm install @openai/agents）
    import { Agent, run } from "@openai/agents";

    const historyTutorAgent = new Agent({ name: "History Tutor", instructions: "..." });
    const mathTutorAgent = new Agent({ name: "Math Tutor", instructions: "..." });
    const triageAgent = Agent.create({
      name: "Triage Agent",
      instructions: "判断问题属于哪个学科，交给对应的老师",
      handoffs: [historyTutorAgent, mathTutorAgent],
    });
    const result = await run(triageAgent, "罗马帝国是什么时候灭亡的？");
    console.log(result.finalOutput);
    ```

=== "Python"

    ```python
    # 未在本机运行；API 依据 openai.github.io/openai-agents-python 的 quickstart / handoffs 页面
    from agents import Agent, Runner

    history_tutor_agent = Agent(name="History Tutor", instructions="...")
    math_tutor_agent = Agent(name="Math Tutor", instructions="...")
    triage_agent = Agent(
        name="Triage Agent",
        instructions="判断问题属于哪个学科，交给对应的老师",
        handoffs=[history_tutor_agent, math_tutor_agent],
    )
    result = await Runner.run(triage_agent, "罗马帝国是什么时候灭亡的？")
    print(result.final_output)
    ```

它的招牌是 handoff：一个 Agent 把对话**整个交接**给另一个 Agent。官方文档原话是 handoff 对模型而言「表现为工具」，也就是说，模型调用一个名为「转给数学老师」的工具，框架就把后续对话切换到另一个 Agent 的 instructions 和工具集。

你可能会问：这和 Claude Code 的 subagent 有什么不同？subagent 是**派出去干完活再回来汇报**，主 Agent 的上下文里只收到一个结果；handoff 是**把对话交出去**，接手的人从此和用户直接对话。前者是为了隔离上下文，后者是为了切换角色。

### Claude Agent SDK：送你一整个 Claude Code

上一章讲过了。它和前三个的根本区别是：前三个是**框架**，你要自己提供工具；Claude Agent SDK 是**产品**，自带一套打磨过的编程工具（Read / Edit / Bash / Grep……）和上下文管理（自动压缩、subagent）。

### CrewAI 之类的多角色框架

CrewAI 走的是「角色扮演 + 协作」路线：定义研究员、写手、审稿人等角色，让它们按流程协作。我没有在本机验证它的 API，这里只说定位，不给代码。

## LangChain、LangGraph、DeepAgents：不是三个平级选项

你可能会问：LangGraph 已经能跑 Agent，为什么还有 LangChain 和 DeepAgents？**它们主要差在抽象层，不是三个互斥的品牌选项。** 就像网络请求原语、请求 Hook 和带缓存策略的封装，越往上默认替你做的事越多。不过这个类比只说明封装关系，不意味着每个项目都必须装齐三层。

下面依据官方 overview 核对，只讨论开源库 / SDK，不把托管服务的能力算进来；这部分没有在本机新增运行实验。

| 层次 | 你主要在描述什么 | 替你接好的部分 | 什么时候值得选 |
|---|---|---|---|
| LangGraph：底层编排与运行时 | 状态、节点、边 | 状态流转，以及 checkpoint、中断等运行机制 | 你需要亲自控制流程；图机制沿用前面的例子，不再展开 |
| LangChain：模型 / 工具接口与高层 Agent 抽象 | 模型、工具、提示词、中间件 | 用 `createAgent`（Python：`create_agent`）组装模型—工具循环，Agent 底下用 LangGraph 运行 | 想快速搭一个工具调用 Agent，再逐项定制循环周围的策略 |
| DeepAgents（官方写作 Deep Agents）：更完整的 Agent harness | 任务、工具，以及可配置的上下文和执行环境 | 在 LangChain 构件和 LangGraph 运行时上组合文件系统上下文、子 agent、摘要等能力，并提供可选的任务规划 | 多步骤任务已经需要这些配套，不想逐项拼装；不是为了换个名字再套一层 |

**组合关系说穿了就是：DeepAgents 建在 LangChain 构件和 LangGraph 运行时之上；LangChain 的高层 Agent 又建在 LangGraph 上。** 反过来不强制成立：LangGraph 可以脱离 LangChain 使用，LangChain Agent 也不要求你先手写一张图。选上层入口，不等于底下的运行时消失了。

举个独立构造的例子：做一个「桌游规则助手」，只需查规则、回答问题，LangChain 的模型和工具抽象就够用了；如果流程必须固定为「检索 → 检查引用 → 不合格则重试」，可用 LangGraph 明确控制；如果变成整理多份规则材料、维护中间笔记、分派独立核对任务，再考虑 DeepAgents 的整套 harness。这是选型推演，不是运行结果，也不是说前一层绝对做不到后一层的事。

你可能会问：那用 DeepAgents，是不是业务系统也搭好了？**没有。框架里的任务清单不是业务任务库，文件系统接口也不自动等于持久、安全的文件服务。** 你仍要选配存储与执行 backend，落实用户鉴权、数据隔离、业务校验和外部写入的幂等；运行时能恢复，不代表业务副作用天然只执行一次。相关边界见 [Agent 构建指南](../p3-agent-internals/13-agent-build-guide.md)，harness 本身的含义见 [Harness Engineering](../p3-agent-internals/12-harness-engineering.md)。

## 对比表

| | Claude Agent SDK | Pydantic AI | LangGraph | OpenAI Agents SDK |
|---|---|---|---|---|
| 核心抽象 | `query()` / `ClaudeSDKClient` | `Agent` + 类型化工具和输出 | `StateGraph` 节点和边 | `Agent` + `Runner` + handoff |
| 循环在哪 | CLI 子进程里（Claude Code） | 框架内部 | 你画的图里 | 框架内部 |
| 内置工具 | 有，整套编程工具 | 无 | 无 | 有一些托管工具（**推测**：依据其文档导航，未核对细节） |
| 模型 | Claude | 多家（含 Anthropic） | 不绑定 | 默认 OpenAI，可接其他 |
| 离线测试 | 无官方 fake（本库自写了假 CLI） | `FunctionModel` / `TestModel` | 节点即函数，天然可测 | （未核对） |
| 最适合 | 要一个现成的编程/文件操作 Agent | 输出要强类型、业务后端 | 流程复杂、要中断审批和持久化 | 多角色客服、分诊交接 |

## 我的选择

说实话，大部分场景你不需要框架。第 2 章的 100 行就是一个能用的 Agent，第 5 章的 Workflow 几十行就能写完。框架的价值出现在你**确定**需要它那一块能力的时候：

- 要编程能力、文件操作、权限、压缩：直接用 Claude Agent SDK，别自己重写 Claude Code。
- 要强类型输出、要把 Agent 嵌进 FastAPI 这类后端：Pydantic AI，它和 Pydantic 生态一脉相承。
- 流程本身很复杂（多个审批点、失败恢复、长时间运行）：LangGraph，用图把控制流显式化，比在代码里堆 `if` 好维护。
- 多个角色之间要「转接」：OpenAI Agents SDK 的 handoff 模型最直接。

而我最不推荐的，是在还没写过手写循环的情况下就选一个重框架。框架出问题时，你得知道它底下那个循环长什么样，才能判断是 prompt 的问题、工具的问题，还是框架的问题。

**回到主线**：这些 SDK 都没有改变「LLM 预测下一个 token、循环把工具结果塞回上下文」这个本质。它们在不同的地方替你管理上下文：Claude Agent SDK 管压缩和隔离，Pydantic AI 管输入输出的结构，LangGraph 管状态在节点间怎么流，OpenAI Agents SDK 管对话在角色间怎么交接。

## 对照你的环境

- 你日常用的 subagent / fork 是 Claude Code 的上下文隔离手段，最接近的对应物是 LangGraph 的子图和 OpenAI Agents SDK 的 agent-as-tool，而不是 handoff。见 [Sub Agent](../p1-tools/10-sub-agent.md)。
- 你的 `codex-cross-review` 是「两个异源 Agent 并行 + 主进程裁决」，用 LangGraph 画出来就是一个 fan-out 到两个节点、再 fan-in 到一个合并节点的图。

## 常见坑

1. **把框架概念当新能力**。handoff、crew、graph 都是在同一个循环上的组织方式，不会让模型变聪明。
2. **跨框架迁移时忽略消息格式**。各家内部的消息结构不同（Pydantic AI 的 `ModelRequest/ModelResponse`、LangGraph 的 state、Anthropic 的 content blocks），历史记录不能直接互用。
3. **为了「可能会用到」引入重框架**。依赖、升级、调试成本都是实打实的。
4. **只在真模型上测试**。Pydantic AI 的 `FunctionModel`、LangGraph 的普通函数节点，都让你能离线写确定性测试，别浪费。

## 练习

**1.** 给 `langgraph_agent.ts`（Python 版 `langgraph_agent.py`）加一个「审批」节点：`write_file` 之前先经过它，如果 `content` 里含 `rm -rf` 就路由到 END。

<details>
<summary>提示</summary>

加一个 `approve` 节点，节点本身不改状态，返回 `{}` 就行。改 `route`：最后一条消息是 `write_file` 时去 `"approve"`，其它 tool 照旧去 `"tools"`。`addConditionalEdges("llm", ...)` 的目标列表也要加上 `"approve"`。再给 `approve` 加一条条件边：`content` 含 `rm -rf` 就去 `END`，否则去 `"tools"`。`SCRIPT` 是写死的，测试要能换剧本：把它改成可注入，造一个 `write_file` 内容带 `rm -rf` 的剧本，断言 `FILES["calc.py"]` 没被改。正常剧本还要照样修好 calc.py。这只是静态检查；真要「等人点头」，要用本章说的中断点。

</details>

**2.** 把 `ai_sdk_agent.ts` / `pydantic_ai_agent.py` 的 `Report` 加一个字段 `files_changed`（zod 里是 `z.array(z.string())`，Python 里是 `list[str]`），让 fake 模型也填上，写测试断言。

<details>
<summary>提示</summary>

Node 版：`Report` 加 `files_changed: z.array(z.string())`，`model` 的 `doGenerate` 最后一步输出的 JSON 里加上 `files_changed: ["calc.py"]`。Python 版：`Report` 加 `files_changed: list[str]`，`scripted_model` 最后那个 `ToolCallPart(out_tool, {...})` 里加同样的字段。测试在 `sdk_compare.test.ts`（`test_sdk_compare.py`）里断言 `output.files_changed` 等于 `["calc.py"]`。建议先故意不填，看看两个框架各自怎么报校验错误，这正是「输出也是带校验的类型」的意义。

</details>

**3.** 开放题：如果要把第 5 章的分诊系统上线，并且要求「每张工单创建前都要人工确认，且服务重启后能接着处理」，你会选哪个 SDK？为什么？

<details>
<summary>提示</summary>

两个要求拆开看：「每张单创建前人工确认」要能在工具执行前暂停，「重启后能接着处理」要把状态持久化。本章的对比表里，同时把这两件事当一等公民的是 LangGraph，它有中断点和 checkpoint。所以我会选 LangGraph，但 checkpoint 一定要存数据库，不能用内存，否则一重启照样丢。也可以换个角度：第 5 章说过分诊基本能写成 Workflow，用普通代码加一张数据库状态表也能做到，框架省下的是样板代码，不是能力。

</details>

## 延伸阅读

- Pydantic AI：<https://ai.pydantic.dev/>（`FunctionModel` / `TestModel` 见其 testing 文档）
- Vercel AI SDK：<https://ai-sdk.dev/>（`MockLanguageModelV4` 见其 testing 文档）
- LangChain / LangGraph / DeepAgents 的分层依据（官方 overview，本文仅核对文档，未新增本机 API 实验）：[LangChain · JS](https://docs.langchain.com/oss/javascript/langchain/overview) / [Python](https://docs.langchain.com/oss/python/langchain/overview)、[LangGraph · Python](https://docs.langchain.com/oss/python/langgraph/overview)、[Deep Agents · JS](https://docs.langchain.com/oss/javascript/deepagents/overview) / [Python](https://docs.langchain.com/oss/python/deepagents/overview)。用于核对抽象与组合关系，不作为具体版本默认配置或业务可靠性的保证。
- OpenAI Agents SDK：<https://openai.github.io/openai-agents-python/>（quickstart、handoffs）
- 本库：上一章 [用 Agent SDK 简化开发](./06-agent-sdk.md) · [Workflow 和 Agent](./05-workflow-vs-agent.md) · 下一章 [给 Agent 加上可观测性](./08-agent-observability.md)

回到开头的问题：它们解决的是同一个问题吗？是，都是那个循环。该挑哪个？挑那个恰好替你做了「你最不想自己写的那一块」的。
