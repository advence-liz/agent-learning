# Research Platform：Node 工程化 Agent 实战

**保留手写教学版，再用 Fastify、LangChain/LangGraph、PostgreSQL、Langfuse 和 S3 实现同一条研究业务闭环。** 这里不是替换旧版，而是让你对照理解：哪些机制交给框架，哪些权限、副作用与故障边界仍由应用负责。

| 学习目标 | 使用哪个版本 | 本版的增量 |
|---|---|---|
| 手写循环、拆协议、逐步练习 | [原六阶版本](../interview-node/README.md) | 原版保持不变，本版不导入其代码 |
| 练习主流组件的真实集成 | 本目录 | 框架 Agent、原生 PG checkpointer、独立网关、OpenAPI |
| 用运行结果而不是组件名举证 | [验收命令](#验证把模型替身组件实测和真实模型分开记录) | 真实 PG/S3、双进程恢复、Langfuse 回读、DeepSeek smoke |

## 先启动基础服务，再一条命令跑业务闭环

需要 **Node 24+、npm、Docker Engine/Compose**。默认只启动 PostgreSQL 与 S3 兼容存储，模型是明确标注的协议 fake；不需要真实 API key。

以下命令在仓库根执行：

```sh
npm ci --prefix code/interview-platform-node
npm run infra:up --prefix code/interview-platform-node
npm run demo --prefix code/interview-platform-node
```

`demo` 自动迁移、写入四篇虚构教学资料，临时启动 API/worker/网关，实际经过 **HTTP 创建 → SSE 等待 → 引用草稿 → 模拟人工批准 → S3 保存 → HTTP 下载 Markdown**，结束后关闭应用连接。它不停止 Docker 基础服务，也不删除报告。

真实运行输出节选（省略随机任务 ID 与引用原文）：

```json
{
  "mode": "离线协议模型 + 真实 PostgreSQL / S3",
  "status": "completed",
  "promptVersion": "builtin:research-system@1",
  "inputTokens": 90,
  "outputTokens": 30,
  "markdownBytes": 302,
  "artifactCount": 1
}
```

这些 tokens 是 fake 的固定用量，不是账单。受控启动器读取 `.env.example` 和可选 `.env` 的非敏感设置；缺少 `.env` 不影响默认运行。模板只有公开教学假值，文件中的非空模型密钥会被拒绝。

### 真实 DeepSeek 必须显式启用，密钥只从当前 shell 读取

当前 shell 已有 `DEEPSEEK_API_KEY` 后执行：

```sh
npm run demo --prefix code/interview-platform-node -- --live
```

本命令限定本次 demo 的任务，网关单次最多 10 个模型请求；不会消费其他排队任务。这是一题完整闭环 smoke，不是质量 benchmark；最新多场景真实验收见下方[验证记录](#验证把模型替身组件实测和真实模型分开记录)。

**不要把真实 key 写进源码、`.env`、截图或日志。** 继续用 shell 环境变量。`.env` 入口只用于本机非敏感配置或教学假值；`.env*` 已忽略，只允许 `.env.example` 入库。

## 对照目标标准，组件已经接到真实调用链上

| 用途 | Node 对应实现 | 已落地的边界 |
|---|---|---|
| API | Fastify + JSON Schema + OpenAPI | 参数校验、统一安全错误、幂等接单；`GET /openapi.json` |
| Agent | LangChain `createAgent` | 两个本地工具、`toolStrategy` 结构化输出、模型与工具中间件 |
| 状态 | LangGraph + `PostgresSaver` | 原生图检查点、独立 schema、静态断点与跨进程继续 |
| 模型 | LangChain `ChatOpenAI` → 本机 OpenAI 兼容网关 → DeepSeek | 上游 key 只在网关读取；白名单、认证、并发与输出上限；不是只有一个可改的 baseURL |
| 工具 | 本地 Zod 类型化工具 | 检索前租户过滤、按 ID 读取、已读引用校验；无实际跨服务需求，不硬加 MCP |
| Prompt / 追踪 | Langfuse Prompt API + OpenTelemetry/Langfuse SDK | 固定 Prompt 版本，模型 generation、工具 span、耗时/成败；默认不导出原始内容 |
| 测试 / 评测 | `node:test` + 固定场景集 | fake 协议单测与真实组件集成分开，另有真实模型 smoke |
| 文件产物 | S3 SDK + 本机 S3 兼容存储 | 确定性 key、条件写入、SHA256、授权后端下载、64KiB 限制 |
| 队列 / 沙箱 | PG 小型任务队列 + 审批 outbox；没有沙箱 | 不执行任意代码，无须先加沙箱；没有宣称已接 BullMQ 或大型任务平台 |

网关当前只允许 `deepseek-flash`，不宣称已实现多供应商故障转移或智能路由。知识库仍是四篇教学资料和 SQL 词法检索，不是企业级向量摄取平台。

## 顺着一次任务读源码，比一次读完所有依赖更有效

| 顺序 | 文件 | 重点问题 |
|---|---|---|
| 1 | [server.ts](src/server.ts) | 接单为何只返回任务？身份、幂等键、审批、下载分别在哪里校验？ |
| 2 | [gateway.ts](src/gateway.ts) | LangChain 怎么经过统一入口？fake 与 live 如何明确分开？ |
| 3 | [agent.ts](src/agent.ts) | 工具输出怎么进入框架循环？schema 校验后为什么还要校验引用？ |
| 4 | [repository.ts](src/repository.ts) | 状态和图检查点为何分开？数据库连接失效为什么不能继续写？ |
| 5 | [worker.ts](src/worker.ts) | 审批后上传为什么要用持久 outbox，而不是 HTTP 里直接 PUT？ |
| 6 | [artifacts.ts](src/artifacts.ts) | 上传成功、数据库确认前崩溃，为什么重复上传不覆盖别的内容？ |
| 7 | [prompts.ts](src/prompts.ts)、[observability.ts](src/observability.ts) | Prompt 版本怎么固定？追踪怎么在不上传问题原文的情况下保留调用链？ |

### 框架保存控制流，宿主仍然负责权限和副作用

Agent 只有 `search` 和 `read_document`，最终答案通过框架结构化响应工具形成。它没有 shell、任意路径、任意 URL，也没有“发布报告”工具。宿主随后检查：文档属于租户、该任务读过、摘录逐字存在、`not_found` 不伪装成有引用的回答。

宿主把任务中的已认证租户 ID 与教学名称加入系统级上下文，让模型明确“当前租户”是谁；用户和文档不能改变该身份，实际授权仍由工具 SQL 强制执行。

若模型只返回普通文本，或返回 `not_found` 却携带引用，宿主最多追加一次响应契约纠错消息，请模型重新调用 `research_answer`，不会自行补造答案。纠错消息随检查点持久化，恢复后不重置次数；仍共用原有的 8 次模型调用、token 和超时预算。未读/越权文档、伪造摘录、传输错误不进入此纠错分支；纠错后仍不合规就失败关闭。

这仍然**不能证明答案与引用的语义一致**；错误结论也可能附上真实摘录，需要评测或人工审核。

研究完成进入 `waiting_approval`，审批事务把任务改成 `publishing`——这就是持久 outbox。worker 上传成功后再原子写 manifest 与 `completed`；上传后崩溃则重试同一 key，校验实际内容哈希后收口。审批之后不能取消发布；审批之前取消会阻止后续提交。

### 检查点不是手写快照，恢复也不是把问题再发一次

使用 `PostgresSaver` 的独立 `agent_graph` schema，thread ID 由服务端的 tenant 和 run ID 组合，客户端不能指定。恢复时向 LangGraph 传 `null`，不是追加一条相同 user 消息。

两个容易忽略的框架事实，已经写成集成回归：

- **静态暂停使用 `interruptAfter`**，关闭 stream iterator 不是可靠的持久暂停契约。
- **当前 LangChain 的 `structuredResponse` 是非持久输出通道**。正常路径读取 invoke 返回值；图已结束但业务状态没提交时，从持久化的结构化 ToolMessage 恢复，并重新校验权限和引用。

PostgreSQL 会话 advisory lock 同时限制全局并发和单任务互斥；图检查点固定走**持锁的同一条数据库连接**。连接终止后，旧 client 不会自动换连接继续写；业务终态另有 owner/status 条件更新。这个适配依赖锁定的 checkpointer 公共构造接口及实际查询行为，升级依赖必须重跑连接终止与接管测试。

回到主线：框架负责保存“模型接下来看到什么、从哪一步继续”；应用仍然负责“它能访问什么、哪些后果必须先由人批准”。

## 需要独立服务时，API、worker、网关分开启动

先完成迁移和种子数据：

```sh
npm run migrate --prefix code/interview-platform-node
npm run seed --prefix code/interview-platform-node
```

然后在三个终端分别执行：

```sh
# 网关：默认 fake。真实模型须显式设置 MODEL_MODE=live、ALLOW_LIVE_MODEL=true，
# 且当前进程已有 DEEPSEEK_API_KEY。
npm run gateway --prefix code/interview-platform-node

# API/worker 不需要 DeepSeek key；显式从它们的环境中去掉。
env -u DEEPSEEK_API_KEY npm start --prefix code/interview-platform-node
env -u DEEPSEEK_API_KEY npm run worker --prefix code/interview-platform-node
```

默认 loopback 端口：API `58787`、网关 `58080`、业务 PostgreSQL `55432`、S3 `59000`、S3 控制台 `59001`。真实与 fake 实验应分开数据库/队列，不要让不同模型配置的 worker 混消费同一批任务。一键 demo 已按 run ID 隔离。

<details>
<summary>API 手动验收与 SSE 恢复</summary>

公开教学身份是 `Bearer demo-alpha` / `Bearer demo-beta`，不是生产凭证。

```sh
curl -s http://127.0.0.1:58787/api/runs \
  -H 'Authorization: Bearer demo-alpha' \
  -H 'Idempotency-Key: first-refund' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"退款政策是什么？"}'
```

将响应的 ID 替换下面的 `<id>`：

```sh
curl -N http://127.0.0.1:58787/api/runs/<id>/stream \
  -H 'Authorization: Bearer demo-alpha'
curl -s -X POST http://127.0.0.1:58787/api/runs/<id>/approve \
  -H 'Authorization: Bearer demo-alpha'
curl -s http://127.0.0.1:58787/api/runs/<id>/artifact \
  -H 'Authorization: Bearer demo-alpha'
```

- `GET /api/runs/:id`：状态、草稿、Prompt 版本、用量，不回传原始 messages。
- `GET /api/runs/:id/events?after=N`：单页最多 128 个事件。
- `GET /api/runs/:id/stream?after=N`：支持 Last-Event-ID；传最后成功处理的 seq，客户端按 seq 去重。
- `POST /api/runs/:id/cancel`：审批前取消；SSE 断开本身不取消任务。
- `POST /api/runs/:id/approve`：幂等批准，异步发布；重复调用不会再建一份产物。
- `GET /api/runs/:id/artifact`：仅租户任务完成后允许下载，后端校验 SHA256，不暴露任意存储路径。

seq 是数据库全局递增序号，同一任务的序号允许有间隔，不代表丢事件。SSE 是业务事件流，不是模型 token 流；待审批与终态会关闭连接，批准后重新连接查看发布事件。慢客户端断开后重放，不无限缓冲。

</details>

## Langfuse 是可选的真实组件，不是默认外传数据

默认关闭追踪，使用内置版本 `builtin:research-system@1`。需要验证时启动独立 profile：

```sh
npm run infra:observability --prefix code/interview-platform-node
npm run prompt:seed --prefix code/interview-platform-node
```

Langfuse UI 在 `http://127.0.0.1:53000`。Compose 的 `local-demo-*` 身份、邮箱和 keys 全是公开的教学假值，**只能用于 loopback**。`prompt:seed` 对相同内容复用最新版本，内容变化才创建新版本，并输出实际版本号；不能假定永远为 1。

显式设置本机教学配置再运行（`PROMPT_VERSION` 用 seed 输出）：

```sh
LANGFUSE_BASE_URL=http://127.0.0.1:53000 \
LANGFUSE_PUBLIC_KEY=pk-lf-local-demo \
LANGFUSE_SECRET_KEY=sk-lf-local-demo \
PROMPT_VERSION=1 \
npm run demo --prefix code/interview-platform-node
```

修复后真实模型联合验收已有回读证据：`promptVersion=langfuse:research-system@1`；研究 trace 包含 **3 个 generation、3 个工具 span 加根 span，共 7 个 observations**。原始 input/output 均未导出。工具次数由模型选择，不承诺和 fake 的固定路径完全相同。

隐私默认：启动器及 Agent 禁用所有 LangSmith/LangChain 自动追踪别名和 verbose，不使用自动捕获原文的 LangChain callback；手动 middleware 记录 generation/工具 span，导出边界只保留成败、耗时、校验后的 run ID 和 tenant 哈希，清掉原始输入、输出、异常文本和任意 metadata。Prompt 拉取只发送部署指定的名字与版本，不发送问题。原始问题和工具历史仍在本机 PostgreSQL 检查点中，**不等于数据库已匿名化**。

设置了 Langfuse 却缺 key、缺固定版本或拉取失败，Prompt 会失败关闭，不悄悄切换版本。外部遥测/存储/数据库默认拒绝，需要分别显式放行；不要用真实用户内容试验外部配置。用量记录在业务数据库，当前没有 Langfuse 价格表、账单归因或标注工作台的自动化。

## 验证：把模型替身、组件实测和真实模型分开记录

```sh
npm test --prefix code/interview-platform-node
npm run test:integration --prefix code/interview-platform-node
npm run typecheck --prefix code/interview-platform-node
npm run lint --prefix code/interview-platform-node
npm run eval --prefix code/interview-platform-node
```

集成测试与 eval 需要先 `infra:up`；单元测试不依赖 Docker，不调用真实模型。测试目标是这个独立教学数据库，**不要指向生产数据库**。

| 证据 | 当前结果 | 证明边界 |
|---|---|---|
| 单元测试 | 32 项通过 | 网关协议/响应流限制、S3 条件写/冲突/超时、Prompt 版本/seed、配置密钥边界、所有追踪别名禁用与脱敏 |
| 真实组件集成 | 11 项通过 | 真实 PG/S3、双进程恢复、连接终止接管、审批限额、发布对账；新增可信身份、普通文本/矛盾结果的一次纠错、恢复不重置纠错预算、越权引用不重试 |
| 固定场景集 | 6/6 | 两租户、退款/报销/预算、无答案；fake 分数不能称为模型准确率 |
| 真实 DeepSeek | 最新一轮 7/7 | 退款、报销、无答案、双向租户隔离、合法预算、恶意文档拒答；三项正例均通过重复审批与 S3 下载，非统计质量结论 |
| Langfuse | 真实 Prompt 读取、OTel 导出与 HTTP 回读通过 | 模型/工具调用链和隐私默认，不等于完善的线上监控 |
| 类型、lint、依赖 | TypeScript / Oxlint 通过，npm audit 无告警 | 不等于完成所有安全测试 |

2026-11-18 多场景真实验收：修复可信租户上下文与响应契约处理后，原七场景从 5/7 变为 7/7。最新一轮经过真实 HTTP/SSE，读取 `langfuse:research-system@1`，调用 DeepSeek **20 次**，输入 **18,748 tokens**、输出 **2,222 tokens**，合计 **20,970 tokens**。三份报告分别为 770、694、253 字节，每个任务仅一份产物；其余四项在草稿校验通过后由验收脚本取消，不发布报告。本轮没有改用 fake，也没有通过放宽引用或租户授权来通过测试；小样本单轮成功不保证所有模型输出稳定。响应纠错的强制故障与恢复路径见 [response-contract.test.ts](integration/response-contract.test.ts)，其中模型是构造的协议响应，不是真实质量评测。

### 面试时至少能解释这三种中断

1. **图节点执行中断**：从最后提交的节点恢复，未提交的模型请求可能重复并再次计费；不是模型请求 exactly-once。
2. **图完成、业务 finish 前中断**：从已保存的结构化工具消息恢复，重新校验引用，不再次调用模型。
3. **S3 上传成功、manifest 提交前中断**：`publishing` outbox 仍在；重试遇到条件写冲突后比较实际哈希，相同内容可确认，不同内容拒绝覆盖。

对应测试在 [checkpoint.test.ts](integration/checkpoint.test.ts)、[locking.test.ts](integration/locking.test.ts)、[workflow.test.ts](integration/workflow.test.ts)。把这些失败窗口讲清，比只说“用了 LangGraph，可以恢复”更有说服力。

## 已实现工程骨架，仍不冒充生产平台

- **鉴权**：教学 Bearer 映射，没有 OIDC、生产 RBAC、独立审批人或完整审计合规。
- **并发与超时**：数据库全局并发 2，每租户待执行上限 32、总上限 128；研究任务 deadline 120 秒、模型请求 30 秒、最多 8 次模型调用、40KB 消息预算。累计 token 按响应 usage 计量，不能承诺绝不超出账单阈值。
- **连接**：API 连接上限 64、SSE 上限 32；这不是生产速率限制或租户公平调度。
- **队列与发布**：PostgreSQL 小型队列，不是完整长任务平台；创建与审批都受同一准入锁/容量检查。发布最多 3 次上传 worker claim（SDK 自身另有最多 3 次请求尝试及超时限制），崩溃恢复耗尽后只能 GET 核验既有对象，不再上传。没有自动死信管理、对象存储孤儿清理、保留策略和灾备。
- **资料**：SQL 词法检索，没有上传摄取、embedding、rerank、冲突证据裁决或模型训练。
- **安全执行**：不执行不可信代码，因此没有容器沙箱；以后加 shell/浏览器动作时必须重新设计隔离边界。
- **部署**：验证的是本机 Compose、多数据库连接与真实子进程；未做 Kubernetes、多机压测、生产网络隔离或 SLO 验收。
- **依赖兼容**：当前 Langfuse 6.1.1 依赖 OpenTelemetry 2.x 兼容组。安装时会看到部分 OTel 包的弃用提示；当前锁定组合已实测、`npm audit` 为零告警，不能直接强升不兼容的 OTel 3.x 来消掉提示。
- **界面**：有 CLI/API/OpenAPI、Langfuse 管理 UI，没有业务聊天前端。

基础服务容器内存上限合计 **896MiB**；加完整 Langfuse profile 上限合计 **6272MiB**，首次启动会拉取较大镜像。仅需业务演示时不要启用完整观测栈。停止额外观测服务、保留数据卷：

```sh
node code/interview-platform-node/scripts/infra.ts stop-observability
```

Docker project 是独立的 `interview-platform-jd-training-local`；基础脚本不会停止其他项目、删除其他项目数据或写入真实凭证。

官方依据：[LangChain JS Agents](https://docs.langchain.com/oss/javascript/langchain/agents) · [LangGraph Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) · [Langfuse TypeScript](https://langfuse.com/docs/observability/sdk/typescript/setup) · [Langfuse Self-hosting](https://langfuse.com/self-hosting) · [Fastify](https://fastify.dev/docs/latest/) · [AWS S3 条件写](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)。
