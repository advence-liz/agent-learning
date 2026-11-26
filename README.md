# 开发学习知识库

> **三条独立学习路线**：Agent 研发练应用交付，数据结构与算法练解题，后端系统练故障追问与系统设计。按目标选自己的导读。

- **[Agent 研发 →](p0-core/00-guide.md)**：从上下文与工具调用入门，拆解工业级实现，手写自己的 Agent，再准备研发面试。
- **[数据结构与算法 →](p9-algorithms/00-guide.md)**：用 TypeScript 练搜索、遍历和动态规划，最后实现任务依赖规划器。不需要模型或 API key。
- **[后端系统 →](p10-backend-systems/00-guide.md)**：围绕 SQL、缓存、MQ 和稳定性，拿同一条订单链路练首问、故障追问和限时设计。

## Agent 研发：先跑通，再拆解，最后自己做

第 0–1 部分打地基，第 2 部分亲手写聊天机器人、Coding Agent、RAG、MCP，第 3 部分拆工业级实现及生产工程，第 4 部分逐步实现 mini Claude Code，最后到第 7 部分准备面试。第 5–6 部分的机器学习和训练按需选修，第 8 部分的技术讲义可独立阅读。

骨架借鉴 [labuladong 的 AI 开发教程](https://labuladong.online/zh/ai-coding/ai-guide/)。下方 📖 是读书笔记，✍️ 是独立原创课文。勾选框可跟踪进度（编辑 `[ ]` → `[x]`）。

| 部分 | 讲什么 | 建议 |
|---|---|---|
| [第 0 部分 · 核心概念](#p0-core) | 主线的起点：token、上下文、API，所有后续章节的地基 | ⭐ 必读，1 天 |
| [第 1 部分 · AI 工具使用技巧](#p1-tools) | 你天天在用的 Claude Code 能力：hooks、subagent、skills；末三章是本地模型和开源模型接入（选读） | ⭐ 08–12 五篇原创必读，01–07 笔记速读（07 必读），13–15 选读；2 天 |
| [第 2 部分 · Agent 开发基础](#p2-agent-basics) | 从聊天机器人到 Coding Agent、RAG、可观测性、MCP、工具设计，亲手写一遍 | ⭐⭐ 重点，1 周 |
| [第 3 部分 · 工业级 Agent：拆解与生产工程](#p3-agent-internals) | 抓包拆 Claude Code / Codex 的 prompt、压缩、记忆、权限；最后五章讲构建、评测、安全、RAG 评测、成本 | ⭐⭐ 重点，1 周 |
| [第 4 部分 · 手搓 mini Claude Code](#p4-mini-cc) | 一个工程从 0 长到 21 个能力，每章一次增量 | ⭐⭐⭐ 核心项目，2–3 周 |
| [第 5 部分 · 机器学习基础 + 经典算法](#p5-ml) | 想看懂 LLM 训练再来，从拟合、梯度下降讲起 | 选修 |
| [第 6 部分 · 神经网络 + LLM 开发基础](#p6-nn-llm) | 手写自动求导、优化器、推理全流程、LoRA 微调 | 选修 |
| [第 7 部分 · Agent 研发面试](#p7-interview) | 岗位地图 → 模型与训练 → Agent 机制 → 生产工程 → 系统设计 → 项目与模拟 | 主线学完后按目标岗位准备 |
| [第 8 部分 · 技术讲义与科普](#p8-technical-lectures) | 三条选读路线：历史与概念、Agent 工程、行业证据与业务落地 | 组内递进，组间可跳读 |

<a id="p0-core"></a>
### 第 0 部分 · 核心概念

主线的起点：token、上下文、API，所有后续章节的地基。

- [ ] [本章导读](p0-core/00-guide.md) · 📖 笔记 · [原文](https://labuladong.online/zh/ai-coding/ai-guide/)
- [ ] [LLM 和 Agent 的核心术语和原理](p0-core/01-llm-and-agent.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/llm-and-agent/)
- [ ] [如何调用 LLM 接口](p0-core/02-api-and-apikey.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/api-and-apikey/)
- [ ] [上下文是什么？token 怎么计费？](p0-core/03-messages-and-tokens.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/messages-and-tokens/)
- [ ] [LLM 是怎么预测下一个 token 的](p0-core/04-llm-token-prediction.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/llm-token-prediction/)

<a id="p1-tools"></a>
### 第 1 部分 · AI 工具使用技巧

你天天在用的 Claude Code 能力：hooks、subagent、skills；末三章是本地模型和开源模型接入（选读）。

- [ ] [用 Codex 还是 Claude Code？](p1-tools/01-tools-landscape.md) · 📖 笔记 · [原文](https://labuladong.online/zh/ai-coding/basics/tools-landscape/)
- [ ] [安装使用 Claude Code](p1-tools/02-install-and-use.md) · 📖 笔记 · [原文](https://labuladong.online/zh/ai-coding/claude-code/install-and-use/)
- [ ] [安装使用 Codex](p1-tools/03-install-and-use.md) · 📖 笔记 · [原文](https://labuladong.online/zh/ai-coding/codex/install-and-use/)
- [ ] [安装使用 OpenClaw](p1-tools/04-install-and-use.md) · 📖 笔记 · [原文](https://labuladong.online/zh/ai-coding/openclaw/install-and-use/)
- [ ] [AI 编程的基本常识](p1-tools/05-ai-tips.md) · 📖 笔记 · [原文](https://labuladong.online/zh/ai-coding/basics/ai-tips/)
- [ ] [Claude Code 的常用技巧](p1-tools/06-useful-tips.md) · 📖 笔记 · [原文](https://labuladong.online/zh/ai-coding/claude-code/useful-tips/)
- [ ] [你的聊天记录存在哪](p1-tools/07-session-storage.md) · 📖 笔记 · [原文](https://labuladong.online/zh/ai-coding/claude-code/session-storage/)
- [ ] [用 Hooks 给 Claude Code 加规矩](p1-tools/08-hooks.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/claude-code/hooks/)
- [ ] [/goal 命令：给 Agent 设定目标](p1-tools/09-goal-command.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/claude-code/goal-command/)
- [ ] [Sub Agent：上下文管理的艺术](p1-tools/10-sub-agent.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/sub-agent/)
- [ ] [Fork Agent：共享上下文的艺术](p1-tools/11-fork-agent.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/fork-agent/)
- [ ] [用 Skills 定制你的 AI 工作流](p1-tools/12-skills.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/claude-code/skills/)
- [ ] [用 Ollama 在本地运行大模型](p1-tools/13-local-llm-ollama.md) · 📖 笔记 · [原文](https://labuladong.online/zh/ai-coding/basics/local-llm-ollama/)
- [ ] [看懂 Hugging Face 和模型文件](p1-tools/14-hugging-face-model-files.md) · 📖 笔记 · [原文](https://labuladong.online/zh/ai-coding/basics/hugging-face-model-files/)
- [ ] [用 CC Switch 和 cc-connect 让 Claude Code 跑开源模型](p1-tools/15-open-models-cc-switch.md) · ✍️ 原创

<a id="p2-agent-basics"></a>
### 第 2 部分 · Agent 开发基础

从聊天机器人到 Coding Agent、RAG、可观测性、MCP、工具设计，亲手写一遍。

- [ ] [动手实现一个 AI 聊天机器人](p2-agent-basics/01-ai-chatbot.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/ai-chatbot/)
- [ ] [动手实现一个 Coding Agent](p2-agent-basics/02-coding-agent.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/coding-agent/)
- [ ] [动手实现一个 RAG 问答机器人](p2-agent-basics/03-rag-qa-bot.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/rag-qa-bot/)
- [ ] [RAG 原理和使用场景](p2-agent-basics/04-rag-principles.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/rag-principles/)
- [ ] [Workflow 和 Agent](p2-agent-basics/05-workflow-vs-agent.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/workflow-vs-agent/)
- [ ] [用 Agent SDK 简化开发](p2-agent-basics/06-agent-sdk.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/agent-sdk/)
- [ ] [其他主流 Agent SDK 对比](p2-agent-basics/07-agent-sdk-comparison.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/agent-sdk-comparison/)
- [ ] [给 Agent 加上可观测性](p2-agent-basics/08-agent-observability.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/agent-observability/)
- [ ] [详解 LLM API 的流式响应模式](p2-agent-basics/09-streaming-response.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/streaming-response/)
- [ ] [动手开发 MCP 工具](p2-agent-basics/10-mcp-tool.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/mcp-tool/)
- [ ] [拆解 MCP 通信协议](p2-agent-basics/11-mcp-protocol.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/mcp-protocol/)
- [ ] [工具设计：写给模型用的接口](p2-agent-basics/12-tool-design.md) · ✍️ 原创

<a id="p3-agent-internals"></a>
### 第 3 部分 · 工业级 Agent：拆解与生产工程

抓包拆 Claude Code / Codex 的 prompt、压缩、记忆、权限；最后五章讲构建、评测、安全、RAG 评测、成本。

- [ ] [Claude Code 抓包分析工具](p3-agent-internals/01-http-analyzer.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/claude-code/http-analyzer/)
- [ ] [给 Claude Code 发一句 Hi 会发生什么](p3-agent-internals/02-hi-request.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/claude-code/hi-request/)
- [ ] [System Prompt 应该怎么写](p3-agent-internals/03-system-prompt.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/claude-code/system-prompt/)
- [ ] [文件读写是怎么实现的](p3-agent-internals/04-file-read-write.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/claude-code/file-read-write/)
- [ ] [如何实现上下文压缩](p3-agent-internals/05-context-compaction.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/claude-code/context-compaction/)
- [ ] [Claude Code 自动记忆系统](p3-agent-internals/06-auto-memory.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/claude-code/auto-memory/)
- [ ] [Codex 自动记忆系统](p3-agent-internals/07-auto-memory.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/codex/auto-memory/)
- [ ] [mem0 记忆库的实现思路](p3-agent-internals/08-mem0-memory.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/mem0-memory/)
- [ ] [Zep 记忆系统的实现思路](p3-agent-internals/09-zep-memory.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/zep-memory/)
- [ ] [Claude Code 的权限检查是怎么实现的](p3-agent-internals/10-permission-check.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/claude-code/permission-check/)
- [ ] [Plan Mode 是怎么实现的](p3-agent-internals/11-plan-mode.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/claude-code/plan-mode/)
- [ ] [Harness Engineering 是什么](p3-agent-internals/12-harness-engineering.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/basics/harness-engineering/)
- [ ] [Agent 构建指南：研发要素全景](p3-agent-internals/13-agent-build-guide.md) · ✍️ 原创
- [ ] [Agent 评测实践指南](p3-agent-internals/14-agent-eval-guide.md) · ✍️ 原创
- [ ] [Agent 安全：提示词注入与「致命三要素」](p3-agent-internals/15-agent-security.md) · ✍️ 原创
- [ ] [RAG 评测：检索找没找到，回答有没有编](p3-agent-internals/16-rag-eval.md) · ✍️ 原创
- [ ] [成本控制与模型路由](p3-agent-internals/17-cost-and-routing.md) · ✍️ 原创

<a id="p4-mini-cc"></a>
### 第 4 部分 · 手搓 mini Claude Code

一个工程从 0 长到 21 个能力，每章一次增量。

- [ ] [Coding Agent 的命令系统](p4-mini-cc/01-cli.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/cli/)
- [ ] [Agent 循环的逐步输出](p4-mini-cc/02-realtime-output.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/realtime-output/)
- [ ] [Agent 的错误处理与重试](p4-mini-cc/03-error-handling.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/error-handling/)
- [ ] [持久化聊天记录](p4-mini-cc/04-resume.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/resume/)
- [ ] [对工具调用进行权限审批](p4-mini-cc/05-permission.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/permission/)
- [ ] [auto 模式自动进行权限审批](p4-mini-cc/06-auto-mode.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/auto-mode/)
- [ ] [可靠的文件编辑工具](p4-mini-cc/07-file-edit.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/file-edit/)
- [ ] [用 @ 引用文件](p4-mini-cc/08-file-mention.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/file-mention/)
- [ ] [更灵活的上下文注入机制](p4-mini-cc/09-context-injection.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/context-injection/)
- [ ] [让 Agent 主动向你提问](p4-mini-cc/10-ask-user-question.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/ask-user-question/)
- [ ] [让 Agent 跟踪多步任务](p4-mini-cc/11-task-management.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/task-management/)
- [ ] [给 Agent 加上长期记忆](p4-mini-cc/12-memory.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/memory/)
- [ ] [支持 rewind 回退对话和代码](p4-mini-cc/13-rewind.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/rewind/)
- [ ] [支持 compact 压缩上下文](p4-mini-cc/14-compact.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/compact/)
- [ ] [给 Agent 注册 MCP server](p4-mini-cc/15-mcp.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/mcp/)
- [ ] [让 Agent 在后台运行命令](p4-mini-cc/16-background.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/background/)
- [ ] [实现 Sub Agent 机制](p4-mini-cc/17-subagent.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/subagent/)
- [ ] [让 Agent 监听外部事件](p4-mini-cc/18-monitor.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/monitor/)
- [ ] [支持图片输入](p4-mini-cc/19-image.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/image/)
- [ ] [渐进式加载 Skills](p4-mini-cc/20-skill.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/skill/)
- [ ] [让 Agent 先规划再动手](p4-mini-cc/21-plan.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/coding-agent/plan/)

<a id="p5-ml"></a>
### 第 5 部分 · 机器学习基础 + 经典算法

想看懂 LLM 训练再来，从拟合、梯度下降讲起。

- [ ] [Tensor 的常用操作](p5-ml/01-pytorch-basics.md) · 📖 笔记 · [原文](https://labuladong.online/zh/ai-coding/basics/pytorch-basics/)
- [ ] [机器学习的基本概念](p5-ml/02-ml-basics.md) · 📖 笔记 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-basics/)
- [ ] [什么是拟合](p5-ml/03-ml-fitting.md) · 📖 笔记 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-fitting/)
- [ ] [最小二乘法](p5-ml/04-ml-least-squares.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-least-squares/)
- [ ] [梯度下降](p5-ml/05-ml-gradient-descent.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-gradient-descent/)
- [ ] [局部最优与全局最优](p5-ml/06-ml-local-global-optima.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-local-global-optima/)
- [ ] [过拟合与泛化](p5-ml/07-ml-overfitting.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-overfitting/)
- [ ] [二分类问题：逻辑回归](p5-ml/08-ml-logistic-regression.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-logistic-regression/)
- [ ] [实战：逻辑回归识别涂鸦](p5-ml/09-ml-logistic-regression-doodles.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-logistic-regression-doodles/)
- [ ] [分类模型的评估](p5-ml/10-ml-classification-metrics.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-classification-metrics/)
- [ ] [多分类问题：Softmax 回归](p5-ml/11-ml-softmax.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-softmax/)
- [ ] [K 近邻算法](p5-ml/12-ml-knn.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-knn/)
- [ ] [实战：KNN 识别手写数字](p5-ml/13-ml-knn-digits.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-knn-digits/)
- [ ] [决策树：用一连串问题做分类](p5-ml/14-ml-decision-tree.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-decision-tree/)
- [ ] [随机森林算法及实战](p5-ml/15-ml-random-forest.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-random-forest/)
- [ ] [K-Means 聚类算法](p5-ml/16-ml-kmeans.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-kmeans/)
- [ ] [实战：K-Means 颜色量化](p5-ml/17-ml-kmeans-color-quantization.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-kmeans-color-quantization/)
- [ ] [模拟退火算法](p5-ml/18-ml-simulated-annealing.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-simulated-annealing/)

<a id="p6-nn-llm"></a>
### 第 6 部分 · 神经网络 + LLM 开发基础

手写自动求导、优化器、推理全流程、LoRA 微调。

- [ ] [手写神经网络：让模型自己学会特征](p6-nn-llm/01-ml-neural-network.md) · 📖 笔记 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-neural-network/)
- [ ] [实战：神经网络识别人体动作](p6-nn-llm/02-ml-activity-recognition.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-activity-recognition/)
- [ ] [反向传播：手写自动求导引擎](p6-nn-llm/03-ml-backpropagation.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-backpropagation/)
- [ ] [优化器：Momentum 和 Adam](p6-nn-llm/04-ml-optimizers.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/machine-learning/ml-optimizers/)
- [ ] [动手跑通 LLM 推理的全流程](p6-nn-llm/05-inference-process.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/llm/inference-process/)
- [ ] [动手用 LoRA 微调模型](p6-nn-llm/06-lora-fine-tuning.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/ai-coding/llm/lora-fine-tuning/)

<a id="p7-interview"></a>
### 第 7 部分 · Agent 研发面试

岗位地图 → 模型与训练 → Agent 机制 → 生产工程 → 系统设计 → 项目与模拟。

- [ ] [岗位与备考地图：先确定深度，再沿六章建立证据](p7-interview/01-interview-landscape.md) · ✍️ 原创
- [ ] [模型原理与训练：从 token 预测到预训练、后训练](p7-interview/02-model-fundamentals.md) · ✍️ 原创
- [ ] [Agent 核心机制：从循环、工具到 RAG、评测与安全](p7-interview/03-agent-mechanisms.md) · ✍️ 原创
- [ ] [全栈与生产工程：把 Agent 交付成可靠产品](p7-interview/04-production-engineering.md) · ✍️ 原创
- [ ] [系统设计：把模型、Agent 与生产约束组合成方案](p7-interview/05-system-design.md) · ✍️ 原创
- [ ] [项目深挖与模拟面试：把知识变成可核查的证据](p7-interview/06-project-and-mock.md) · ✍️ 原创

<a id="p8-technical-lectures"></a>
### 第 8 部分 · 技术讲义与科普

三条选读路线：历史与概念、Agent 工程、行业证据与业务落地。

- [ ] [科普导读：按你想回答的问题选读](p8-technical-lectures/00-reading-guide.md) · ✍️ 原创

#### 认识 AI 与 Agent

- [ ] [AI 发展简史：从手写规则到能调用工具的系统](p8-technical-lectures/08-ai-history.md) · ✍️ 原创
- [ ] [LLM 发展过程中的质疑与成长](p8-technical-lectures/04-llm-development.md) · ✍️ 原创
- [ ] [Agent 的前世今生：自己行动，还是替人行动？](p8-technical-lectures/05-agent-etymology.md) · ✍️ 原创

#### 拆开 Agent 看它怎么工作

- [ ] [Agent 运行线路图](p8-technical-lectures/01-agent-runtime-map.md) · ✍️ 原创
- [ ] [代码库检索：向量检索、RepoMap 与 Agentic Search](p8-technical-lectures/02-codebase-search.md) · ✍️ 原创
- [ ] [Claude Code Harness 搭建指南（详实版）](p8-technical-lectures/07-claude-code-harness-guide.md) · ✍️ 原创

#### 判断进展和落地价值

- [ ] [大模型的能力边界：论文、评测与现实各能说明什么？](p8-technical-lectures/06-llm-capability-boundaries.md) · ✍️ 原创
- [ ] [AI 行业进展与代表应用：2026 年 11 月观察](p8-technical-lectures/10-ai-industry-watch.md) · ✍️ 原创
- [ ] [AI 怎么从试用走到业务流程：验效果、算成本、管执行](p8-technical-lectures/09-ai-business-adoption.md) · ✍️ 原创

<a id="p9-algorithms"></a>
## 数据结构与算法

按专题学习数据结构、搜索、图论、动态规划和数学，用 TypeScript 实验与综合练习自检。

- [ ] [算法导读：先说清状态，再背模板](p9-algorithms/00-guide.md) · ✍️ 原创 · [原文](https://labuladong.online/zh/algo/home/)
- [ ] [从数组到图：数据怎么存，决定你怎么找](p9-algorithms/81-storage-and-traversal.md) · ✍️ 原创
- [ ] [核心算法框架：先辨认题目的信号，再挑模板](p9-algorithms/79-core-frameworks.md) · ✍️ 原创
- [ ] [五道混合题：题目不告诉你该用哪种算法](p9-algorithms/82-mixed-practice.md) · ✍️ 原创

### 准备与解题框架

- [ ] [复杂度：先数操作，再决定要不要优化](p9-algorithms/08-complexity.md) · ✍️ 原创
- [ ] [不变量与对拍：用小输入找出大算法的边界](p9-algorithms/09-proof-and-oracles.md) · ✍️ 原创
- [ ] [递归与显式栈：区分参数、返回值和回到父层的时机](p9-algorithms/10-recursion.md) · ✍️ 原创

### 数组、容器与有序结构

- [ ] [动态数组和环形队列：把移动成本留给扩容](p9-algorithms/44-dynamic-array-and-deque.md) · ✍️ 原创
- [ ] [数组、哈希与前缀和：把重复计算变成查表](p9-algorithms/01-arrays-and-hash.md) · ✍️ 原创
- [ ] [前缀频次：有负数的子数组和为什么改成查表](p9-algorithms/42-prefix-frequency.md) · ✍️ 原创
- [ ] [差分数组：批量修改只记开始和结束](p9-algorithms/11-difference-array.md) · ✍️ 原创
- [ ] [二维矩阵：用四个角回答矩形范围和](p9-algorithms/12-matrix-prefix.md) · ✍️ 原创
- [ ] [二维遍历：转置、旋转与螺旋走的是不同下标](p9-algorithms/45-matrix-traversal.md) · ✍️ 原创
- [ ] [双指针、滑动窗口与二分：每一步都要说明排除了什么](p9-algorithms/02-pointers-and-search.md) · ✍️ 原创
- [ ] [滑动窗口三练：长度变了，哪条规则也要跟着变？](p9-algorithms/80-sliding-window-practice.md) · ✍️ 原创
- [ ] [原地覆盖：读指针审阅输入，写指针只填合法前缀](p9-algorithms/46-slow-fast-in-place.md) · ✍️ 原创
- [ ] [二分答案：当可行性从假变真，就搜索第一个真](p9-algorithms/17-binary-search-answer.md) · ✍️ 原创
- [ ] [链表、栈与队列：结构决定下一步处理谁](p9-algorithms/03-linear-structures.md) · ✍️ 原创
- [ ] [链表进阶：快慢指针、虚拟头与分段翻转](p9-algorithms/15-linked-list-patterns.md) · ✍️ 原创
- [ ] [哈希表实现：桶内碰撞和扩容是性能账的两半](p9-algorithms/43-hash-table.md) · ✍️ 原创
- [ ] [哈希与 LRU：按键定位和按顺序淘汰是两种操作](p9-algorithms/16-hash-lru.md) · ✍️ 原创
- [ ] [单调栈与单调队列：候选被支配就不再保留](p9-algorithms/14-monotonic.md) · ✍️ 原创
- [ ] [雨水与边界：水位由两侧较矮的挡板限制](p9-algorithms/73-trapping-water.md) · ✍️ 原创
- [ ] [排序基础：用同一组记录看插入、选择、冒泡和堆排序](p9-algorithms/47-sorting-basics.md) · ✍️ 原创
- [ ] [排序与堆：只要 Top K，就不用给所有元素排序](p9-algorithms/06-sorting-and-heap.md) · ✍️ 原创
- [ ] [堆的线性建造与 K 路归并：只比较每路当前头部](p9-algorithms/48-heap-build-and-merge.md) · ✍️ 原创
- [ ] [排序与选择：稳定性、划分和平均复杂度不能混为一谈](p9-algorithms/18-sort-and-select.md) · ✍️ 原创
- [ ] [扫描线：不用枚举真实时间，枚举事件就够](p9-algorithms/49-sweep-line.md) · ✍️ 原创
- [ ] [树状数组与线段树：边更新边查询时选择什么结构](p9-algorithms/13-range-structures.md) · ✍️ 原创

### 树、图与路径

- [ ] [树与图：DFS 汇总子树，BFS 按距离扩散](p9-algorithms/04-tree-and-graph.md) · ✍️ 原创
- [ ] [搜索树：局部左右关系不足以证明整棵树合法](p9-algorithms/19-bst.md) · ✍️ 原创
- [ ] [字典树：前缀存在不等于完整词已添加](p9-algorithms/20-trie.md) · ✍️ 原创
- [ ] [树的重建、序列化与公共祖先：先说清信息够不够](p9-algorithms/21-tree-construction.md) · ✍️ 原创
- [ ] [树上距离与重根 DP](p9-algorithms/67-tree-distance-rerooting.md) · ✍️ 原创
- [ ] [连通性与并查集：只问是否同组，不必保存整条路径](p9-algorithms/22-graph-connectivity.md) · ✍️ 原创
- [ ] [二分图染色与奇环](p9-algorithms/65-bipartite-odd-cycle.md) · ✍️ 原创
- [ ] [加权最短路：首次发现不是最短，弹出有效最小项才是](p9-algorithms/23-dijkstra.md) · ✍️ 原创
- [ ] [Bellman–Ford 与负环](p9-algorithms/63-bellman-ford.md) · ✍️ 原创
- [ ] [Floyd–Warshall 全源最短路](p9-algorithms/64-floyd-warshall.md) · ✍️ 原创
- [ ] [最小生成树：连通全图最省钱，不等于从某点出发最短](p9-algorithms/24-mst.md) · ✍️ 原创
- [ ] [有向图结构：拓扑、环与强连通各回答不同问题](p9-algorithms/25-directed-graphs.md) · ✍️ 原创
- [ ] [DAG DP 与关键路径](p9-algorithms/62-dag-critical-path.md) · ✍️ 原创
- [ ] [桥与割点：用边编号处理多重边](p9-algorithms/66-bridges-and-articulation-points.md) · ✍️ 原创

### 搜索、分治与贪心

- [ ] [回溯、动态规划与贪心：先判断哪些分支可以不算](p9-algorithms/05-backtracking-dp-greedy.md) · ✍️ 原创
- [ ] [回溯去重：只剪掉同层的等价选择](p9-algorithms/26-backtracking-duplicates.md) · ✍️ 原创
- [ ] [带约束回溯：先确定剪掉的分支确实不可能完成](p9-algorithms/50-backtracking-constraints.md) · ✍️ 原创
- [ ] [状态空间搜索：从格子、单词到双向 BFS](p9-algorithms/27-state-search.md) · ✍️ 原创
- [ ] [岛屿搜索：面积、周长和连通数要分别记账](p9-algorithms/74-islands.md) · ✍️ 原创
- [ ] [分治：先确认左右独立，再设计跨边界合并](p9-algorithms/28-divide-and-conquer.md) · ✍️ 原创
- [ ] [折半枚举：指数搜索太大时，把独立选择分成两半](p9-algorithms/52-meet-in-middle.md) · ✍️ 原创
- [ ] [区间与贪心：先区分选最多、合并和数资源](p9-algorithms/29-intervals-and-greedy.md) · ✍️ 原创
- [ ] [优先队列贪心：最便宜的两项为什么可以先合并](p9-algorithms/51-priority-greedy.md) · ✍️ 原创

### 动态规划专项

- [ ] [动态规划方法：状态、转移、顺序与答案位置](p9-algorithms/30-dp-method.md) · ✍️ 原创
- [ ] [网格 DP：障碍与最小代价](p9-algorithms/55-grid-dp.md) · ✍️ 原创
- [ ] [背包：同一个状态维度，遍历方向决定能不能复用物品](p9-algorithms/31-knapsack.md) · ✍️ 原创
- [ ] [二维 0/1 背包](p9-algorithms/60-two-dimensional-knapsack.md) · ✍️ 原创
- [ ] [序列 DP：最长上升子序列不是最长连续片段](p9-algorithms/32-sequence-dp.md) · ✍️ 原创
- [ ] [字符串 DP：从两个前缀的末尾推转移](p9-algorithms/33-string-dp.md) · ✍️ 原创
- [ ] [模式匹配与分词：扫描位置相同，转移方向却不同](p9-algorithms/71-pattern-matching-dp.md) · ✍️ 原创
- [ ] [区间 DP：第一次做会改变邻居，试着改枚举最后一次](p9-algorithms/34-interval-dp.md) · ✍️ 原创
- [ ] [最长回文子序列](p9-algorithms/56-longest-palindromic-subsequence.md) · ✍️ 原创
- [ ] [树与状态机 DP：有限状态承载未来需要的历史](p9-algorithms/35-tree-and-state-dp.md) · ✍️ 原创
- [ ] [股票 DP：次数与手续费](p9-algorithms/57-stock-dp.md) · ✍️ 原创
- [ ] [带权区间调度](p9-algorithms/61-weighted-interval-scheduling.md) · ✍️ 原创
- [ ] [最小初始资源：逆推每个格子进入前最低需要多少](p9-algorithms/72-minimum-start-budget.md) · ✍️ 原创
- [ ] [博弈 DP：轮到谁就站在谁一边](p9-algorithms/59-game-dp.md) · ✍️ 原创
- [ ] [概率 DP：先到哪一边](p9-algorithms/58-probability-dp.md) · ✍️ 原创
- [ ] [数位与状压 DP：压缩的是重复状态，不是随意减维](p9-algorithms/36-digit-and-bitmask-dp.md) · ✍️ 原创
- [ ] [扔鸡蛋：反过来问给定次数最多能覆盖多少层](p9-algorithms/70-egg-drop.md) · ✍️ 原创

### 字符串、数学与随机化

- [ ] [KMP：失配时复用已经匹配的前后缀](p9-algorithms/37-kmp.md) · ✍️ 原创
- [ ] [滚动哈希：快速筛选相同子串，但碰撞后还要验证](p9-algorithms/53-rolling-hash.md) · ✍️ 原创
- [ ] [字符串乘法：位权对齐以后再进位](p9-algorithms/76-decimal-arithmetic.md) · ✍️ 原创
- [ ] [整数运算：从最大公约数、筛法到快速幂](p9-algorithms/38-number-theory.md) · ✍️ 原创
- [ ] [模运算中的除法：逆元要存在，才能换成乘法](p9-algorithms/54-modular-inverse.md) · ✍️ 原创
- [ ] [位运算与组合计数：先定义编码与重复规则](p9-algorithms/39-bit-and-combinatorics.md) · ✍️ 原创
- [ ] [随机算法：洗牌、抽样和期望时间各保证什么](p9-algorithms/40-randomization.md) · ✍️ 原创
- [ ] [带权随机：用前缀权重划出等概率的整数格](p9-algorithms/75-weighted-sampling.md) · ✍️ 原创

### 综合练习与复盘

- [ ] [11 道经典算法面试题：把解法讲清楚，再写代码](p9-algorithms/83-interview-classics.md) · ✍️ 原创
- [ ] [综合项目：用拓扑排序和堆规划任务依赖](p9-algorithms/07-task-planner.md) · ✍️ 原创
- [ ] [第二实战：给日程服务做可验证的区间查询](p9-algorithms/68-scheduling-project.md) · ✍️ 原创
- [ ] [第三实战：把路径查询拆成建模、选算法和校验结果](p9-algorithms/69-routing-project.md) · ✍️ 原创
- [ ] [解析器实战：表达式优先级不是边扫描边求值就能解决](p9-algorithms/77-parser-project.md) · ✍️ 原创
- [ ] [有序流实战：把多个来源的最新记录合成一页](p9-algorithms/78-stream-feed-project.md) · ✍️ 原创
- [ ] [综合练习：先交付可验证的答案，再追求题数](p9-algorithms/41-practice-checkpoints.md) · ✍️ 原创

<a id="p10-backend-systems"></a>
## 后端系统

用订单链路练 SQL、缓存、消息可靠性、过载保护和系统设计。

- [ ] [后端面试导读：先练核心追问，再补组件细节](p10-backend-systems/00-guide.md) · ✍️ 原创
- [ ] [网络与运行时：从请求超时反推连接、线程和 I/O](p10-backend-systems/06-foundations.md) · ✍️ 原创
- [ ] [请求入口与稳定性：请求变慢时，先找到在哪排队](p10-backend-systems/01-traffic.md) · ✍️ 原创
- [ ] [数据库：先缩小扫描和锁范围，再谈读写分离与分片](p10-backend-systems/02-database.md) · ✍️ 原创
- [ ] [缓存：减少回源，但别把缓存当成事实来源](p10-backend-systems/03-cache.md) · ✍️ 原创
- [ ] [消息队列：允许重复投递，但不能重复产生业务效果](p10-backend-systems/04-queues.md) · ✍️ 原创
- [ ] [系统设计实战：用一条订单链路验证取舍](p10-backend-systems/05-system-design.md) · ✍️ 原创

## 配套代码

第 0–4 部分的代码有 Node（TypeScript）和 Python 两版，逻辑一一对应，正文默认展示 Node 版，代码块上方的标签页可以切到 Python。
第 5–6 部分是 PyTorch 训练，只有 Python 版。

| 目录 | 内容 | 运行 |
|---|---|---|
| `code/agent-node/` | 第 0–3 部分的示例（Node 版）：hook 演示、chatbot、RAG、MCP server、抓包代理 | `cd code/agent-node && npm ci && npm test` |
| `code/mini_cc-node/` | 第 4 部分的 mini Claude Code（Node 版） | `cd code/mini_cc-node && npm ci && node mini_cc/cli.ts` |
| `code/agent/` | 同上，Python 版 | `cd code/agent && uv run pytest -q` |
| `code/mini_cc/` | 同上，Python 版；`CHANGELOG.md` 记录每章增量 | `cd code/mini_cc && uv run python -m mini_cc` |
| `code/ml/` | 第 5–6 部分的手写算法，均与 sklearn / torch 对拍 | `cd code/ml && uv run pytest -q` |
| `code/algorithm-node/` | 算法栏目的 TypeScript 示例、边界测试与任务依赖规划器 | `cd code/algorithm-node && npm test` |

Node 版需要 Node 24 以上，直接运行 `.ts` 文件，没有构建步骤。

Agent 相关测试使用离线 fake 模型；算法示例和测试不使用模型。要连真实模型，设置 `ANTHROPIC_API_KEY`（可选 `ANTHROPIC_BASE_URL`）。

## 维护

- 网页版预览：`cd .site && uv run mkdocs serve`，打开 http://127.0.0.1:8000（导航按 `curriculum.json` 自动生成，新章节写出来刷新就有；新增**部分目录**时先跑 `python3 tools/build_site.py`）
- 章节清单的唯一来源是 `curriculum.json`，「部分」的顺序、标题、简介在 `tools/parts.py`；改完重跑 `python3 tools/build_readme.py`，再跑 `python3 tools/check_path.py` 检查章间衔接
- 写作规范：`STYLE.md`
- 原站更新了新章节：重新抓 sitemap（`/sitemap.xml` 里 `/zh/ai-coding/` 开头的地址），在 `curriculum.json` 里追加
