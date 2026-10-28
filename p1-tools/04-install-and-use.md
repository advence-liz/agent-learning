# 安装使用 OpenClaw

> 原文（免费）：[安装使用 OpenClaw](https://labuladong.online/zh/ai-coding/openclaw/install-and-use/) —— 建议先读原文，本页是我的笔记

**一句话结论**：OpenClaw（「小龙虾」）不是更强的 Coding Agent，而是一个**自托管网关（Gateway）**：一头接飞书 / Telegram / Slack 等聊天软件，一头接模型或别的 Agent，让你离开电脑也能在手机上派活。它的价值在「交互通道」，风险也在这里——它常驻后台、带着整台机器的权限，你又看不到它每一步。

> 本机**未安装** OpenClaw（`which openclaw` 无结果），以下按原文整理 + npm 元数据核对，未实机跑通。

## 核心要点

1. **定位**：编程能力比不过 Claude Code / Codex；它解决的是「必须坐在终端前」这个限制。必要时它还能反过来调 Claude Code、Codex 干活，自己只当传声筒。
2. **架构**：本机常驻的 Gateway 进程 + 渠道插件（如 `@openclaw/feishu`）+ 你自己配的模型 API。数据和执行都在你的机器上。
3. **部署位置是第一安全决策**：作者不建议装在主力开发机上，应放到云服务器或闲置旧电脑，「把整台机器的权限都交给它」，再按需放凭证——用机器边界做隔离。
4. **安装**：`npm install -g openclaw@latest` → `openclaw onboard` 交互向导。
5. **模型配置**：向导里选 More… → Custom Provider（兼容 OpenAI 或 Anthropic 格式的任意端点）→ 填 Base URL、API key → 接口兼容性选 *OpenAI Responses-compatible*（与 Codex 的 `wire_api = "responses"` 同义）→ 填模型 ID → 自动验证。
6. **渠道配置（飞书为例）**：扫码在飞书开放平台自动建一个自建应用（bot）；域名选 feishu.cn / larksuite.com；群聊策略选 **Allowlist**，只在授权的会话里回复。
7. **其余项先跳过**：联网搜索可选免费的 Parallel Search；skills、语音 / 地理 API key、hooks（如 `session-memory`、`compaction-notifier`）都可以以后再开。
8. **启动**：选 *Hatch in Terminal*，同时拉起 Gateway；首次对话它会问你给它起名、定人设和语气——这些会被记下来成为长期设定。
9. **飞书里找不到 bot**：新 bot 没有会话记录，要用搜索框按名字搜出来。

```d2
shape: sequence_diagram
phone: 手机飞书
feishu: "飞书开放平台\n(自建应用 bot)"
gw: "OpenClaw Gateway\n(隔离机器上常驻)"
llm: "模型 API\n(Custom Provider)"
cc: "可选：Claude Code / Codex"
phone -> feishu: "发消息「帮我把 X 跑一下」"
feishu -> gw: "事件推送（仅 Allowlist 会话）"
gw -> llm: "messages + 工具定义"
llm -> gw: "tool_use / 文本" {style.stroke-dash: 3}
"opt：复杂编程任务": {
  gw -> cc: 委派子任务
  cc -> gw: 结果 {style.stroke-dash: 3}
}
gw -> feishu: 回复
feishu -> phone: 结果消息 {style.stroke-dash: 3}
```

### 📝 作者是怎么讲的

- **用读者的第一反应开场，然后先认输。** 开头抛出读者的疑问：又一个 Agent，编程能力比 Claude Code 强吗？他先坦白「比不过」，再把价值转到另一个维度：交互方式变了，Agent 被接进了聊天软件。先承认短板，后面讲长处时可信度更高。
- **一个类比讲清定位，再落回技术名词。** 「24 小时待命的远程实习生」，你在手机上派任务，它自己去执行。紧接着加一层：实习生能力不够也没关系，它可以把活转给 Claude Code。最后落回技术定义：自托管的网关（Gateway），一头连聊天软件，一头连 Agent。类比负责让人记住，技术定义负责准确，两者衔接得很紧。
- **由类比自然引出风险。** 既然是没人盯着的实习生，而且拿到了整台机器的权限，就不该装在主力开发机上，应该另找一台机器隔离运行。这个安全建议是从类比推出来的，不是单独加的一条注意事项。你写方案时也可以这样：用同一个心智模型同时解释价值和风险。
- **把向导的真实界面原样搬出来。** 每一步都贴终端里的选择框，再用一句话说明选哪个、为什么选（比如群聊选 Allowlist 是为了避免在所有群里乱说话）。读者对着屏幕就能操作。
- **主动说出读者马上会遇到的困惑。** 渠道配完后他立刻补一句：现在还不能在飞书里对话，要等 Gateway 启动。助手不在会话列表里，就用搜索找。这些都是读者照做时一定会冒出来的问题。
- **结尾回到开头的问题，并把流程归结为「三件事」。** 总结里再次回答开头那个区别问题，并把整个安装过程压缩成三步。读者读完带走的是一句结论加一个清单。

## 速查

| 项 | 内容 |
|---|---|
| 包名 / 命令 | `openclaw`（npm，`bin: openclaw`；2026-10-21 查询 latest 为 `2026.10.5`） |
| 首次配置 | `openclaw onboard`；之后改配置用 `openclaw configure`（向导里提示的命令） |
| 推荐模式 | QuickStart；导入已有配置可选 *Import from Claude* |
| 群聊策略 | Allowlist（推荐）/ Open（需 @）/ Disabled |
| 退出终端 | `/exit` |

> ⚠️ 勘误/补充
> - 原文说「官方推荐 Node 24」。`npm view openclaw engines` 实测（2026-10-21）为 **`node: '>=24.16.0 <25 || >=26.1.0'`**：Node 24 的早期小版本不满足，Node 25 也被排除。你本机 nvm 当前是 **v24.14.1**，低于下限，直接装会触发 engine 警告，可能跑不起来；装之前先 `nvm install 24` 升到 24.16+。
> - 原文示例的模型 ID（`gpt-5.5`）、Endpoint ID 都依赖中转站，按你实际的 provider 填。

## 回到主线

OpenClaw 在上下文这件事上做了两件事。一是**换输入通道**：聊天软件里的一条消息被包装成 user message 进入 messages 数组，Agent 本身没变。二是**把人设和偏好持久化**：首次「Wake up」对话问的名字、语气，会存成长期记忆，每次会话注入上下文开头，和 [Claude Code 自动记忆系统](../p3-agent-internals/06-auto-memory.md) 是同一类机制。它做不到的是「人在回路里实时盯着」——所以只能靠机器隔离 + Allowlist 这类外部边界来补可靠性，对应后面 [权限检查](../p3-agent-internals/10-permission-check.md) 要解决的问题。

## 对照你的环境

- **你已经有「远程派活」的等价能力**：`claude --bg` 后台会话（`claude agents / attach / logs / stop`）、`--remote-control`、`--cloud`，加上 `~/.claude/daemon*` 常驻进程。和 OpenClaw 的区别是你的入口仍是终端或 claude.ai，不是 IM。
- **隔离机器你也有**：你那台专用开发机（loop、心跳都跑在上面）正好符合原文「单独找一台机器」的建议。如果要试 OpenClaw，装在那里，别装主力机。
- **合规边界**：飞书扫码会在你登录的租户里建自建应用。用**个人**飞书团队试，不要接公司租户——那等于把公司 IM 消息流交给一个第三方自托管 Agent，和你 CLAUDE.md 里「不主动动 Slack」的出发点一样。
- 原文向导里的 hooks（`session-memory`、`command-logger`、`compaction-notifier`）可以对照你的 10 类 Claude Code hooks：比如你的 `SessionEnd` / `Stop` hook 就承担了类似的会话收尾职责。

## 自测题

1. 为什么说 OpenClaw 的核心能力是「通道」而不是「Agent」？用一句话描述它在请求链路中的位置。
2. 原文为什么建议把它装在单独的机器上？Allowlist 群聊策略又防的是什么？两者分别属于哪一层的防护？
3. 你想让手机飞书里发一句「跑一下 webapp 的单测并把失败用例发给我」。设计一个方案，说明 OpenClaw、Claude Code、隔离机器各自承担什么，以及凭证放在哪。

<details>
<summary>参考答案</summary>

1. 它把聊天软件的消息转换成 Agent 的输入、把 Agent 的输出发回聊天软件，模型和真正干活的 Agent 都可以替换。在链路中的位置是：IM 平台 ↔ Gateway ↔ 模型或下游 Agent。
2. 它常驻后台、拥有所在机器的权限、执行过程不受你实时监督，误操作的影响范围等于整台机器，用单独的机器把影响范围限定住，这是执行环境层的防护。Allowlist 防的是 bot 在所有群里被任意人触发、乱说话或泄露信息，这是输入入口层的防护。
3. OpenClaw 在隔离机器上常驻，只负责接飞书消息、回传结果；隔离机器上 clone 一份 webapp 仓库（只读 token 或部署 key），装 Claude Code；OpenClaw 收到指令后调用 `claude -p "跑 webapp 单测，汇总失败用例"`，把输出回发。凭证只放隔离机器，权限最小化；飞书用个人租户 + Allowlist 只放你自己的会话。

</details>

## 相关章节

- [用 Codex 还是 Claude Code？](./01-tools-landscape.md) · [安装使用 Claude Code](./02-install-and-use.md) · [安装使用 Codex](./03-install-and-use.md)
- [LLM 和 Agent 的核心术语和原理](../p0-core/01-llm-and-agent.md)（远程控制 Agent 的设计思路）
- [Claude Code 的权限检查是怎么实现的](../p3-agent-internals/10-permission-check.md)
- [Claude Code 自动记忆系统](../p3-agent-internals/06-auto-memory.md)
- [用 Hooks 给 Claude Code 加规矩](./08-hooks.md)
