# Research Desk：用六阶 TypeScript 实战准备 Agent 面试

**先运行六个小例子，再把同一套内核组装成可恢复、可取消、要审批的知识库研究 Agent。** Node 24 直接运行 TypeScript；默认离线，显式启用才调用真实 DeepSeek。

| 你要验证什么 | 从哪里开始 | 能拿来面试的证据 |
|---|---|---|
| 模型如何驱动工具循环 | [六阶路线](#六阶路线每次只增加一个需要解释的机制) | messages、tool_call_id、错误回填 |
| Agent 怎么交付成服务 | [完整项目](#完整项目让研究审批与报告成为一条可恢复链路) | SQLite 检查点、HTTP/SSE、取消、幂等 |
| 怎么证明不是假跑 | [验证与边界](#验证分开报告工程正确性与模型质量) | 自动测试、跨进程恢复、真实 API smoke |

## 三分钟先看到闭环，不需要密钥

需要 **Node.js 24+、npm**，不需要全局安装 ts-node / tsx，也不需要数据库服务。以下命令在仓库根目录执行：

```sh
npm ci --prefix code/interview-node
npm run demo --prefix code/interview-node
npm test --prefix code/interview-node
npm run typecheck --prefix code/interview-node
npm run lint --prefix code/interview-node
```

`demo` 的真实离线输出节选（省略随机 UUID 和重复的报告正文）：

```text
离线 fake 模型，执行真实工具与 SQLite 事务。
"status": "waiting_approval"
"kind": "grounded"
"steps": 3
教学 demo 显式模拟用户点击批准；HTTP 服务与普通 create 不会自动批准。
"status": "completed"
"reportCount": 1
```

**假的是模型推理，不是宿主行为。** `FakeModel` 根据工具结果走确定性分支；检索、校验、数据库事务、API、事件流都是真实实现。`ReplayModel` 直接回放构造响应，用来稳定制造错误，不把回放纠错当成真实模型能力。

真实调用只需让当前 shell 已有 `DEEPSEEK_API_KEY`，不要把真实密钥贴进源码或命令历史：

```sh
npm run demo --prefix code/interview-node -- --live
# 更严格：通过 HTTP 创建、SSE 读取、审批接口、报告接口验收
npm run live:smoke --prefix code/interview-node -- --allow-live
```

默认模型 `deepseek-flash`，官方地址 `https://api.deepseek.com`，通过 OpenAI 官方 Node SDK 的兼容接口访问。普通 live 模式可用 `DEEPSEEK_MODEL`、`DEEPSEEK_BASE_URL` 覆盖；smoke 刻意固定官方端点、模型及 10 次 HTTP 请求上限。**改 base URL 意味着把密钥和问题交给那个端点，只有信任时才改。**

## 六阶路线：每次只增加一个需要解释的机制

所有示例默认离线，命令从仓库根执行。先读每个入口，再沿链接看其复用的内核；不必第一次就读完服务端。

| 阶段 | 运行命令 | 本阶新增与源码 | 面试官会追问什么 |
|---|---|---|---|
| 1. 最小循环 | `npm run example:1 --prefix code/interview-node` | [01-loop.ts](examples/01-loop.ts)：显式写出 model → tool → messages 循环 | 为什么 tool_call 不是模型自己执行了函数？ |
| 2. 校验与纠错 | `npm run example:2 --prefix code/interview-node` | [02-errors.ts](examples/02-errors.ts)、[advance](src/agent.ts)：错误变成下一轮可见的 observation | schema 合法就等于有权限吗？坏 JSON 怎么办？ |
| 3. 检索与引用 | `npm run example:3 --prefix code/interview-node` | [03-grounding.ts](examples/03-grounding.ts)、[KnowledgeTools](src/tools.ts)：先过滤租户，再搜索、读取和提交引用 | 引用存在能否证明答案正确？ |
| 4. 持久化与恢复 | `npm run example:4 --prefix code/interview-node` | [04-recovery.ts](examples/04-recovery.ts)、[Store](src/store.ts)：两个真实子进程接续同一 SQLite 检查点 | 崩在模型响应回来、检查点没提交之间呢？ |
| 5. 审批与取消 | `npm run example:5 --prefix code/interview-node` | [05-approval-cancel.ts](examples/05-approval-cancel.ts)、[Runtime](src/runtime.ts)：草稿与副作用分离 | 用户点取消时旧 worker 刚好返回怎么办？ |
| 6. 评测回归 | `npm run example:6 --prefix code/interview-node` | [06-evaluation.ts](examples/06-evaluation.ts)、[evaluate](src/eval.ts)：6 项可解释的协议与权限回归 | fake 全绿为何不能写“模型准确率 100%”？ |

### 先看见循环，再理解宿主如何控制它

第一阶的真实输出：

```text
tool: search
tool: read_document
tool: submit_answer
answer: 订单付款后七天内，未使用的服务可以申请退款。退款需核验订单与付款人身份，不能绕过审批。
模式：离线 fake 模型；循环内的工具是真实 TypeScript 函数。
```

关键是 `state.messages.push({ role: 'tool', tool_call_id, content })`：模型下一轮不是“记得刚才执行过”，而是重新读到了你回填的结果。把这条消息删掉，循环就失去了工具反馈。

第一阶刻意没有完整的停止原因校验、瞬时故障重试和持久化；后面切到同一个 `advance` 内核。工具模块从一开始就校验参数，不需要为了教学先做一个越权版本。

第二阶回放 `query: 12`，宿主返回 `INVALID_ARGUMENT`，下一轮才换成字符串。它说明**系统提供了纠错通道**，不是证明任意模型都能纠错。第三阶再把 schema 校验与业务校验分开：文档存在、属于租户、已被读取、摘录在正文中，四件事不能互相替代。

### 恢复不是“再跑一遍”，副作用也不交给模型决定

第四阶实际启动两个 Node 子进程：第一个完成 search 后提交检查点并退出；第二个读取同一数据库，继续 read、submit。强杀发生在一轮中途时，要等租约过期接管；未提交的一轮可能重复调用模型并再次计费，**不是模型请求 exactly-once**。

第五阶中 `submit_answer` 只写草稿，不提供 `publish` 工具。`publish: true` 表示“需要审批后保存报告”，不是“自动发布”。审批事务同时插入报告、写终态、记事件，报告主键防重复；取消先写终态，旧 owner 的提交会被拒绝。

回到主线：循环补充上下文，校验限制上下文之外的权限，检查点保存恢复所需的上下文；这三层不能靠一段提示词代替。

## 完整项目：让研究、审批与报告成为一条可恢复链路

项目边界是**本地知识库研究服务**，不是通用编码助手。它实现这条纵向业务闭环：创建任务 → 检索授权文档 → 读取证据 → 生成带引用草稿 → 人工审批 → 保存报告。也可以取消任务、断线重放事件。

| 层 | 关键文件 | 职责与不能越过的边界 |
|---|---|---|
| 协议 | [types.ts](src/types.ts)、[model.ts](src/model.ts) | fake / replay / DeepSeek 共用 Model 接口；保留完整 assistant/tool 消息 |
| 决策循环 | [agent.ts](src/agent.ts) | 单轮推进、最多 8 轮、累计 usage 12,000 tokens、上下文 40KB、每轮 30 秒；只重试瞬时错误一次 |
| 工具 | [tools.ts](src/tools.ts) | 固定三工具；租户身份来自宿主；不接受任意路径、URL、shell |
| 任务系统 | [store.ts](src/store.ts)、[runtime.ts](src/runtime.ts) | SQLite 原子 claim、租约、owner fencing、每轮检查点、120 秒任务 deadline |
| 产品接口 | [server.ts](src/server.ts)、[cli.ts](src/cli.ts) | HTTP/SSE、幂等接单、事件重放、审批取消；CLI 可跨进程操作 |
| 证据 | [tests](tests)、[live-smoke.ts](scripts/live-smoke.ts) | 权限、失败态、恢复、HTTP E2E、真实 DeepSeek 验证 |

token 上限依据模型返回的 usage，检查发生在响应回来后；单次请求可能使累计值超过阈值并随后失败，不能当成绝不超支的账单硬限额。单次输出另有限制 1,536 tokens。超出上下文直接失败，尚未实现自动压缩。

### 先用 CLI 手动审批，再换 HTTP

以下命令在 `code/interview-node` 目录中执行，共用 `.data/agent.db`；替换 `<id>` 为 create 返回的 ID：

```sh
node src/cli.ts create "差旅报销需要什么条件？"
node src/cli.ts work
node src/cli.ts list
node src/cli.ts status <id>
node src/cli.ts events <id>
node src/cli.ts approve <id>
```

`work --live` 使用真实模型，`work` 默认 fake。单批默认最多 1,152 轮（128 个任务 × 每任务最多 8 轮加一次超限收尾），覆盖一个满队列快照；输出 `batch.reason`，没有可抢占任务时是 `no_claimable_work`，批次预算用完是 `batch_limit`，后者不是任务失败，再次运行 `work` 可接续。持续接单请用 HTTP 服务中的常驻 worker。不要在同一任务中途混用 fake 与真实模型来做质量实验；用新的数据库或新任务分开。`cancel <id>` 可以取消尚未完成的任务。`AGENT_DB` 控制数据库位置；`demo` 特意用内存库，适合反复练习，不保存历史。

启动 HTTP 服务：

```sh
npm start --prefix code/interview-node
# 真实模型：npm start --prefix code/interview-node -- --live
```

服务只监听 `127.0.0.1:8787`，`PORT` 可改端口。在另一个终端发出请求（示例 token 是公开的教学身份，不是秘密）：

```sh
curl -s http://127.0.0.1:8787/api/runs \
  -H 'Authorization: Bearer demo-alpha' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-first-research' \
  -d '{"prompt":"退款政策是什么？","publish":true}'
```

返回 `202` 后使用响应的 `<id>`：

```sh
curl -N http://127.0.0.1:8787/api/runs/<id>/stream \
  -H 'Authorization: Bearer demo-alpha'
# 草稿就绪后流关闭，人工审核，再明确审批：
curl -s -X POST http://127.0.0.1:8787/api/runs/<id>/approve \
  -H 'Authorization: Bearer demo-alpha'
curl -s http://127.0.0.1:8787/api/reports/<id> \
  -H 'Authorization: Bearer demo-alpha'
```

同一身份和幂等键重复创建返回同一个任务；相同键换问题或 publish 值返回 `409`。测试另一个问题时换一个键。`demo-beta` 无权读取 alpha 的任务、事件或报告；服务不接受 body 指定 tenant。

<details>
<summary>API、事件重放和背压的具体契约</summary>

| 方法与路径 | 行为 |
|---|---|
| `GET /health` | 无鉴权健康检查 |
| `POST /api/runs` | 必填 Idempotency-Key；body 为 prompt、可选 publish |
| `GET /api/runs` | 当前租户最近 20 个任务 |
| `GET /api/runs/:id` | 安全快照，不返回完整 messages/evidence |
| `GET /api/runs/:id/events?after=0` | seq 严格递增，单页最多 256 条 |
| `GET /api/runs/:id/stream?after=0` | SSE，支持 Last-Event-ID，业务事件而非模型 token 流 |
| `POST /api/runs/:id/cancel` | 写取消终态，本进程同时中断请求 |
| `POST /api/runs/:id/approve` | 等待审批 → 保存报告 → completed；重复审批幂等 |
| `GET /api/reports/:id` | 只返回当前租户已保存的报告 |

每条 SSE 带 `id: seq`，重连用最后成功处理的 seq（`after` 优先于 header）。客户端仍应按 seq 去重；不是网络 exactly-once。断流不等于取消，达到待审批或终态时流主动关闭。慢客户端写缓冲饱和时断开，由 cursor 恢复，不无限堆内存。

默认全局有效租约并发 2，每租户 queued/running 上限 32、总上限 128；超量接单 `429`。所有进程须使用相同并发配置；这是共享同一 SQLite 文件的本机并发教学，不是跨 pod 的共享文件方案。

</details>

## 验证：分开报告工程正确性与模型质量

```sh
npm run eval --prefix code/interview-node
npm test --prefix code/interview-node
npm run typecheck --prefix code/interview-node
npm run lint --prefix code/interview-node
```

`eval` 当前输出 `passed: 6, total: 6`，测试入口还覆盖坏参数、伪造引用、越权、超时、取消竞争、租约接管、HTTP/SSE、DeepSeek 错误协议等。**这些证明工程不变量，不代表真实模型准确率。** lint 使用原生支持 TypeScript 的 Oxlint，独立于 TypeScript 类型检查；两项都要运行。

真实 DeepSeek 验证记录（2026-11-18）：

| 验证路径 | 请求数 | 输入 tokens | 输出 tokens | 验证结果 |
|---|---:|---:|---:|---|
| Runtime → 真实模型 → 审批事务 | 3 | 2,370 | 331 | grounded、refund 引用、审批前无报告、重复审批仅一份 |
| HTTP 创建 → SSE → 审批接口 → 报告接口 | 3 | 2,355 | 325 | completed、引用可校验、重复审批仅一份 |

这是两个单题 smoke，不是统计评测。检索中包含明确标识的教学恶意文档；这次模型没有执行其要求，但更关键的是宿主根本没有 shell 工具。它不能证明所有 prompt injection 都被识别或答案语义永远正确。

### 要拿它面试，自己补出三份证据

1. **扩充至少 20 道真实任务评测**，包括无法回答、冲突证据、跨租户、注入、长上下文。记录人工标准答案、引用支持性、任务成功、成本和延迟，别只检查“有引用”。

   <details><summary>提示</summary>先拆出 fixture 与判分函数；同一批输入比较修改前后，失败保留 trace。fake 仅验证机制，真实模型实验另列 token 预算和标注来源。</details>

2. **给取消竞争和恢复各加一个故障实验**。在模型返回后、保存前制造中断，解释哪段工作重跑、为什么不会重复保存报告。

   <details><summary>提示</summary>从 runtime.test.ts 的过期 owner、晚到 commit 用例开始。模型调用允许重复，副作用只在宿主审批事务里发生；外部发信不能直接套用同库原子性的结论。</details>

3. **选一个扩展做真实对照，而不是堆名词**：词法检索换 hybrid retrieval、增加浏览器 UI、接真实身份，或把 SQLite 队列迁移到 PostgreSQL。

   <details><summary>提示</summary>先列必须保持的接口与测试，再只替换一层。衡量收益及代价；不要宣称本项目已实现向量库、MCP、多 Agent、后训练或分布式部署。</details>

## 已知边界：能完整演示，不等于已经生产就绪

- **身份**：demo-alpha/beta 是公开映射，不是 JWT/session、RBAC、审批人分权。不要绑定公网或放真实业务数据。
- **检索**：内置四篇教学文档，词法匹配，不是向量 RAG、联网搜索、上传解析或真实知识平台。
- **引用**：验证授权、已读和逐字存在；尚未验证答案与证据的语义支持、证据时效与冲突。
- **恢复**：按模型轮次提交；崩溃时可能重付一次模型费用。SQLite 共享文件只用于本机，多 pod 需要外置数据库/队列与统一并发策略。
- **副作用**：“发布”只是在同一 SQLite 写报告，不发邮件、不实际退款；外部系统需要幂等键、outbox 或补偿。
- **取消**：本进程立即 AbortSignal；其他进程最多等心跳发现租约/状态失效后停止，已消耗的模型 token 无法撤销。
- **界面与运维**：CLI + HTTP/SSE，没有浏览器 UI、OpenTelemetry、生产告警、数据保留清理、完善的连接级限流；本机长期运行也要管理数据库大小。
- **能力范围**：这是 Agent 应用/Harness 与服务工程实战，不是训练、微调、推理加速或多 Agent 实验。

课程关联：[岗位地图](../../p7-interview/01-interview-landscape.md) · [Agent 机制](../../p7-interview/03-agent-mechanisms.md) · [生产工程](../../p7-interview/04-production-engineering.md) · [系统设计](../../p7-interview/05-system-design.md) · [项目与模拟](../../p7-interview/06-project-and-mock.md)。

官方参考：[DeepSeek 首次调用](https://api-docs.deepseek.com/) · [Function Calling](https://api-docs.deepseek.com/guides/function_calling) · [OpenAI Node SDK](https://github.com/openai/openai-node) · [Node TypeScript](https://nodejs.org/api/typescript.html) · [Node SQLite](https://nodejs.org/api/sqlite.html)。
