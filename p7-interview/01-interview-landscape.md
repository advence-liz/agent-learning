# 岗位与备考地图：先确定深度，再沿六章建立证据

> 本章不对应原站文章，是知识库的补充章节（独立原创）

> **一句话结论**：Agent 工程师面试要贯通模型、Agent、产品与生产系统，并用项目和实验举证；不同岗位的差别在准备深度，不在于可以完全忽略其中一层。本部分按六个主题组织，题目、原理入口和练习都回到同一条路线。

## 「我做过 Agent，为什么还是答不上训练和全栈追问？」

因为 Agent Loop 只是系统的一层。模型为什么会调用工具，涉及训练；工具操作后怎么恢复，涉及后端；用户怎么知道正在发生什么，涉及产品与前端；怎样证明改进，涉及评测。

所以这里不按「面经」「高频题」「JD 补充」分类。**先补模型与训练，再讲 Agent 机制，接着把它交付成产品，最后练系统设计和项目面。** 各章都区分知识、实现和证据，没有做过的部分明确保留边界。

## 六章分别回答六个问题，不再维护一份并行大题库

| 章节 | 面试官真正想知道什么 | 读完应能交付什么 |
|---|---|---|
| 本章：岗位与备考地图 | 目标岗位要做到多深 | 一份按能力与证据分层的备考清单 |
| [模型原理与训练](02-model-fundamentals.md) | 模型怎么推理、怎么学，什么时候该训练 | 一次推理解释、一份训练方案、目标与数据选择依据 |
| [Agent 核心机制](03-agent-mechanisms.md) | 循环、工具、上下文、RAG、多 Agent 怎么取舍 | 一段可解释的循环、强弱回答对照、失败诊断 |
| [全栈与生产工程](04-production-engineering.md) | 如何让不确定的任务安全、可靠地交付 | 事件契约、恢复/取消/幂等设计、资源与质量门禁 |
| [系统设计](05-system-design.md) | 能否把前三层合成满足约束的系统 | 六步答题框架、两道完整方案与代价说明 |
| [项目深挖与模拟面试](06-project-and-mock.md) | 是否真的做过，能否现场证明 | 项目证据包、编码演练、45 分钟模拟和复盘 |

本章负责岗位判断与能力矩阵，不讲另一套答案。模型、Agent、生产三章负责主题原理与追问；系统设计负责组合；最后一章负责验收。原有面经题按主题归位，新增练习是教学推导，**不冒充企业真题，也不宣称统计意义上的“最高频”**。

## 不想只背答案，就沿一套 Node / TypeScript 项目亲手验证

配套的 [Research Desk 六阶实战](../code/interview-node/README.md)从最小工具循环开始，逐步增加错误恢复、检索引用、跨进程恢复、审批取消与评测，最后组装成完整的本地知识库研究服务。**同一套模块逐步加能力，不是六份互不相关的 Demo。**

原版保留用于手写机制；另有独立的 [Node 工程化版本](../code/interview-platform-node/README.md)，实际接入 Fastify/OpenAPI、LangChain/LangGraph、PostgreSQL checkpointer、统一模型网关、Langfuse 与 S3。先用原版理解循环，再用新版练组件集成、跨进程恢复和副作用收口；新版需要本机 Docker，默认不调用真实模型。

```sh
npm ci --prefix code/interview-node
npm run example:1 --prefix code/interview-node
npm run demo --prefix code/interview-node
```

需要 Node 24+。默认离线 fake 模型，显式 `--live` 才使用 DeepSeek。机制实操回到[Agent 核心机制](03-agent-mechanisms.md)，状态与故障回到[生产工程](04-production-engineering.md)，最终验收回到[项目与模拟](06-project-and-mock.md)。它覆盖应用/Harness 与服务工程，不替代模型训练或分布式推理实验。

## 同样叫 Agent，交付物可能是产品、Harness，也可能是模型

| 岗位方向 | 主要交付物 | 应准备的证据 |
|---|---|---|
| Agent 应用 / Harness | 工具、上下文、记忆、工作流、可靠任务执行 | 可运行系统、失败 trace、评测与安全边界；训练知识按 JD 要求补 |
| AI 全栈 / 产品工程 | 用户界面、服务、数据、业务闭环 | 流式交互、任务恢复、多租户、质量、灰度与运行指标 |
| Agent 算法 / 后训练 | 训练数据、模型行为改进、实验结论 | SFT / 偏好优化 / RL 实验、消融、泛化与回归；不能只展示 API Demo |
| 推理 / 训练平台 | GPU 服务、训练或评测基础设施 | 吞吐、尾延迟、显存、调度、恢复与资源效率 |

这四类是本书的备考分类，不是企业统一职级。有的职位同时跨两三类。尤其要区分：**「了解」是知识要求，「有经验」是经历要求，「参与建设」是入职职责，「优先」是加分项**。


## 三条备考路线按岗位取舍，不按章节一刀切

- **应用 / Harness**：重点读[Agent 核心机制](03-agent-mechanisms.md)和[系统设计](05-system-design.md)，把循环、工具、RAG、评测、安全讲深；模型章至少做到区分阶段与方案；后端与推理覆盖机制和项目故障。
- **AI 全栈**：在应用基础上重点做[全栈与部署](04-production-engineering.md)的故障表，补鉴权、数据库、流式状态、恢复和上线证据。传统算法、语言基础、网络、SQL、React 性能也不能省。
- **算法 / 后训练**：先补第 5、6 部分和[训练章](02-model-fundamentals.md)，再做真实数据、训练、消融和泛化实验；若 JD 要求分布式训练，继续专项实战，不能用终端 Agent 替代。

目录按 `0→1→2→3→4→5→6→7` 展示；应用主线仍可 `0→1→2→3→4→7`，不需要为了编号先学完所有机器学习内容。


## 能力矩阵要覆盖全链路，但深度随岗位变化

**读法**：「核心」= 要能设计、写代码或用项目举证；「理解」= 要能讲机制、选型与局限；「按 JD」= 不是默认豁免，看到相关职责就升级深度。它是本书的备考建议，不是招聘市场统计。

| 能力域 | 应用 / Harness | AI 全栈 | 算法 / 后训练 | 本库入口与覆盖边界 |
|---|---|---|---|---|
| LLM 基础：tokenizer、Transformer、attention、位置、采样、KV cache | 理解 | 理解 | 核心 | [模型基础与 KV](02-model-fundamentals.md)、[推理全流程](../p6-nn-llm/05-inference-process.md)；有机制说明，未手写完整 Transformer 训练 |
| 预训练、CPT、SFT、LoRA / QLoRA、蒸馏 | 理解 | 理解 / 按 JD | 核心 | [预训练与后训练](02-model-fundamentals.md)、[LoRA 实操](../p6-nn-llm/06-lora-fine-tuning.md)；QLoRA / 蒸馏只讲原理与选型 |
| 偏好对齐：奖励模型、RLHF / RLAIF / RLVR、DPO、PPO、GRPO | 理解 / 按 JD | 理解 / 按 JD | 核心 | [预训练与后训练](02-model-fundamentals.md)；有目标辨析和离线标量实验，**没有完整 RL 训练实跑** |
| Agent Loop、规划、停止、反思与错误恢复 | 核心 | 核心 | 核心 | [构建指南](../p3-agent-internals/13-agent-build-guide.md)、[范式题索引](03-agent-mechanisms.md)；Reflexion 等靠原论文补深，不冒充已有完整实现 |
| 提示词与结构化生成：指令层级、示例、schema、版本化与对照实验 | 核心 | 核心 | 理解 / 按 JD | [System Prompt](../p3-agent-internals/03-system-prompt.md)、[工具设计](../p2-agent-basics/12-tool-design.md)、[评测指南](../p3-agent-internals/14-agent-eval-guide.md)；提示词与约束解码都不能替代业务校验和权限 |
| 工具、结构化输出、schema、MCP、Skills | 核心 | 核心 | 核心 | [工具设计](../p2-agent-basics/12-tool-design.md)、[MCP 协议](../p2-agent-basics/11-mcp-protocol.md)；JSON 合法不等于业务正确 |
| 上下文、压缩、长期记忆 | 核心 | 核心 | 核心 | [上下文压缩](../p3-agent-internals/05-context-compaction.md)、[记忆](../p4-mini-cc/12-memory.md)；要说明丢信息、过期和跨用户污染 |
| 多 Agent、调度、A2A 与通信取舍 | 核心 / 按 JD | 理解 | 核心 / 按 JD | [子 agent 实现](../p4-mini-cc/17-subagent.md)、[A2A 概念](03-agent-mechanisms.md)；未实现分布式多 Agent 平台 |
| RAG：摄取、切块、embedding、混合检索、rerank、引用、更新 / ACL | 核心 | 核心 | 按 JD | [RAG 原理](../p2-agent-basics/04-rag-principles.md)、[RAG 评测](../p3-agent-internals/16-rag-eval.md)、[全栈与部署](04-production-engineering.md)；企业摄取与权限平台仍需项目实战 |
| 评测与实验：基线、数据切分、切片、评委校准、消融、置信度 | 核心 | 核心 | 核心 | [评测指南](../p3-agent-internals/14-agent-eval-guide.md)、[训练数据与泛化](02-model-fundamentals.md)；小样本结果不作强统计结论 |
| 数据闭环：轨迹、偏好、合成、去重、授权、版本与泄漏 | 核心 / 按 JD | 理解 | 核心 | [预训练与后训练](02-model-fundamentals.md)；覆盖设计与检查点，非完整标注平台 |
| Web：SSE / WebSocket、增量解析、断线恢复、取消、React 状态与性能 | 按 JD | 核心 | 按 JD | [流式响应](../p2-agent-basics/09-streaming-response.md)、[全栈与部署](04-production-engineering.md)；含本机 HTTP/SSE 实作与故障验收，尚无浏览器 UI |
| 后端：API、数据库 / 索引 / 事务、缓存、幂等、队列、并发与恢复 | 核心 | 核心 | 理解 / 按 JD | [错误重试](../p4-mini-cc/03-error-handling.md)、[全栈与部署](04-production-engineering.md)；数据库内核、语言运行时与网络基础须另按岗位补 |
| 生产：可观测、SLO、成本、CI/CD、灰度、容器、密钥与回滚 | 核心 | 核心 | 理解 / 按 JD | [可观测性](../p2-agent-basics/08-agent-observability.md)、[成本路由](../p3-agent-internals/17-cost-and-routing.md)、[全栈与部署](04-production-engineering.md)；未做完整云部署实验 |
| 推理：prefill / decode、TTFT / TPOT、量化、batch、vLLM 与 GPU 显存 | 理解 | 理解 / 按 JD | 核心 / 按 JD | [推理全流程](../p6-nn-llm/05-inference-process.md)、[全栈与部署](04-production-engineering.md)；多 GPU 调优需实测 |
| 训练系统：混合精度、累积、重计算、DDP、ZeRO / FSDP、张量 / 流水线并行 | 按 JD | 按 JD | 核心 / 按 JD | [训练系统辨析](02-model-fundamentals.md)；**只覆盖原理，没有分布式训练复现** |
| 安全：注入、沙箱、身份权限、租户隔离、SSRF、数据合规与审计 | 核心 | 核心 | 核心 | [Agent 安全](../p3-agent-internals/15-agent-security.md)、[全栈与部署](04-production-engineering.md)；训练数据也有许可和隐私边界 |
| 项目、系统设计、编程、产品指标与技术报告阅读 | 核心 | 核心 | 核心 | [项目证据包](06-project-and-mock.md)、[系统设计](05-system-design.md)、本章练习；复杂度、测试与真实取舍必须亲手准备 |

「有链接」不等于「已掌握」，「读过原理」也不等于「有训练经验」。这张矩阵的用途是**暴露边界**，不是宣称读完本书能胜任任何 Agent 岗。

### 专项 JD 还要开额外分支

| JD 出现这些词 | 至少补到能回答 | 本库边界与权威入口 |
|---|---|---|
| 多模态、VLM、文档理解 | OCR / 视觉模型怎么选；截图、表格、图片 token 的质量、成本与权限 | [图片输入](../p4-mini-cc/19-image.md)只覆盖输入能力；模型训练与图文评测另看 [Hugging Face 多模态课程](https://huggingface.co/learn/computer-vision-course) |
| 语音、实时 Agent | ASR → LLM → TTS，VAD、打断、端到端延迟、音频隐私 | 本库未做语音实战；可从 [WebRTC](https://webrtc.org/) 与所选 ASR / TTS 官方文档补 |
| Computer Use、浏览器 / 编码 Agent | 环境状态、动作空间、重置、沙箱、隐藏测试与最终状态验证 | [编码 Agent 系统设计](05-system-design.md)和[安全](../p3-agent-internals/15-agent-security.md)有基础，视觉控制专项未实作 |
| CUDA、Triton、Megatron、MoE、大规模预训练 | 算子、通信、负载均衡、数据混合与训练稳定性 | 属模型 / 系统专项，不能凭本书几页原理应付；从 [Ultrascale Playbook](https://huggingface.co/spaces/nanotron/ultrascale-playbook)继续 |

## 用同一把尺子决定自己要补到哪一层

每个能力域分别记录三格：**能解释机制、能展示实现、能提供效果证据**。读完一章只填第一格；跑通离线 fake 测试只能证明工程行为，不能证明真实模型质量。训练岗需要真实实验，平台岗需要真实资源与负载测量。

你常用的 hooks、skills、MCP 可以成为项目线索，但不能直接当作“实现过 Agent 系统”的证据。选一个自己真正做过的改动，沿后面五章逐层追问，最后汇成[项目证据包](06-project-and-mock.md)。

## 常见坑

- **按岗位名猜要求。** 逐句区分知识、经历、入职职责与加分项。
- **背完名词就说覆盖。** 机制、代码、测量是不同层级的证据。
- **把选修当永久豁免。** 应用岗也可能要求懂训练；不要求做过大规模训练，不等于不问训练原理。
- **用少量 JD 推断招聘市场。** 样本证明存在某种要求，不证明频率、薪酬或实际轮次。

## 练习

**1.** 选一条目标 JD，把要求标成“知识 / 经历 / 职责 / 加分”，再选择备考路线。

<details><summary>提示</summary>

保留原句、URL 和日期。“了解后训练”不要升级成“必须有训练经历”；“负责后训练实验”也不能只准备名词解释。

</details>

**2.** 按能力矩阵写出三个缺口，每项分别说明机制、实现、证据缺哪一格。

<details><summary>提示</summary>

选一个能在自己的项目里验证的缺口。比如不会恢复流式任务，需要的不只是读 SSE 定义，还要模拟断线、重复事件和取消竞争。

</details>

**3.** 开放题：只有一周，如何安排准备而不制造“全会了”的错觉？

<details><summary>提示</summary>

按目标岗位的交付物排序，保留横向知识和安全底线，集中完成一条可证明的闭环；把暂不覆盖的专项写出来，最后用模拟面试验证，而不是以读完页数验收。

</details>

回到主线：模型根据上下文决定下一步；工程师既要理解这个决策如何形成，也要控制它在真实系统里的后果。接下来先从[模型原理与训练](02-model-fundamentals.md)建立底座。

<details>
<summary>参考依据：招聘 JD 样本与核验边界</summary>

### JD 样本：保留出处与状态，不把转载当官方

核验日期：**2026-11-17**。以下是目的性样本，不是随机抽样，不推导「多少比例岗位必考某题」。官方正文证明写了什么，不证明面试实际一定会问；页面能打开也不等于仍有 HC。

| 来源与岗位 | 正文中可核查的要求 / 职责（摘意） | 对备考的意义 | 核验状态 |
|---|---|---|---|
| [小米 · Agent Harness 研发工程师](https://xiaomi.jobs.f.mioffice.cn/campus/position/7671284471720020243/detail)，官方校招 | 核心职责含 Agent Loop、工具、上下文、记忆与状态；必须项要求了解预训练/后训练，熟悉开源模型技术报告的模型与训练细节；至少精通 Python / TypeScript / Go 一种 | Harness 工程岗也不能只学框架；须能读懂模型训练过程，但不能升级成「必须训练过大模型」 | 浏览器读取官方正文；展示投递入口，未提交验证 |
| [小米 · AI Agent算法实习生](https://xiaomi.jobs.f.mioffice.cn/internship/position/7687596167350061355/detail)，官方实习 | 职责包含 Harness、评估器、Agentic 模型精调、数据合成，以及预训练、后训练（SFT / RL）技术路径；任职要求含相关硕博与研究 / 项目经历 | 既做系统也探索模型，训练不只是背景名词；职责不能全改写为入职前硬经历 | 浏览器读取官方正文；展示投递入口，未提交验证 |
| [美团 · AI应用全栈开发工程师](https://zhaopin.meituan.com/web/position/detail?highlightType=social&jobUnionId=3332788599)，官方社招 | RAG、Agentic Workflow、前后端交付、可用性与响应速度；要求全栈、数据库与生成式 AI / LangChain 经验；正文未明确列预训练或 SFT 实操门槛 | 不能把「全栈」收缩成聊天 UI，也不能自行增加模型训练门槛 | 浏览器读取官方正文，页面更新于 2026-05-27；明确显示「当前职位无法投递」，仅作历史样本 |
| [Anthropic · Senior Software Engineer, Full-stack](https://job-boards.greenhouse.io/anthropic/jobs/5174743008)，官方招聘 | 端到端前后端与产品体验，React / TypeScript，性能、可访问性、可靠性、可扩展性，企业身份、权限与合规 | 传统全栈交付能力不会因产品用了 LLM 而消失 | 读取官方 JD 正文；未验证投递或剩余 HC |
| [Anthropic · Staff Software Engineer, Claude Code](https://job-boards.greenhouse.io/anthropic/jobs/5383610008)，官方招聘 | Agentic coding 工具、工具使用与编排、与研究团队合作做评测，以及基础设施、性能、安全与合规；主资格强调 React、组件架构和 UX 工程，扩展 TypeScript 项目的经验列为强候选人的加分经历 | 工具编排之外，还要能讲评测和软件工程；该样本是资深岗，不套作初级统一门槛 | 读取官方 JD 正文；未验证投递或剩余 HC |
| [Shopee · AI-Agent后训练算法工程师](https://jy.scu.edu.cn/index/index/employjobdetail.html?data=MDAwMDAwMDAwMJG6n3_Ed6imi4qQtLh4Y9yKk7a-sobddricp9CWi5qikaeWacSdqLqGfaK2w4iil5C4zNbGiL-E)，高校就业网转载 | SFT、偏好与评测数据；SFT / DPO / KTO / RLAIF 实验，清洗、训练配置、bad case 和消融；相关训练项目经验部分列为加分项 | 后训练岗要把线上轨迹变成训练样本并做实验；不要把加分项当所有候选人的硬门槛 | 读取四川大学就业网正文，发布于 2026-08-20；转载有效期至 2026-11-29，未核实企业端当前可投状态 |

搜索中还有只返回标题的动态招聘页、失效链接和聚合摘要，没有纳入要求证据。这个样本支持「存在这些能力要求」，不支持行业频率、薪酬或公司实际面试轮次的结论。


</details>
