# 安装使用 Codex

> 原文（免费）：[安装使用 Codex](https://labuladong.online/zh/ai-coding/codex/install-and-use/) —— 建议先读原文，本页是我的笔记

**一句话结论**：Codex 的桌面端、CLI、VS Code 插件是**同一个 Agent 的三张皮**，共用 `~/.codex/` 这一份配置；配置的核心是 `config.toml` 里的 `model_provider` + `[model_providers.<name>]` 段（发到哪、走哪种接口）和凭证来源。

> 你早已装好并在用（codex-cli 0.153.4），本页压缩为「速查 + 你机器上的对应位置」。

## 核心要点

1. **三种入口共享一份状态**：Desktop（作者推荐，体验最好）、CLI（`npm install -g @openai/codex`）、VS Code 插件（扩展 ID `openai.chatgpt`）都读 `~/.codex/`，配一次三处生效。
2. **两个关键文件**：`config.toml` 管 provider、模型、推理强度；`auth.json` 管凭证。
3. **自定义 provider 的写法**：顶层 `model_provider = "<名字>"` 指向 `[model_providers.<名字>]` 表，表里给 `base_url`、`wire_api`（原文用 `"responses"`，即走 OpenAI Responses 接口）以及凭证方式。原文强调这几行要放在**文件顶部**——TOML 里一旦出现 `[表头]`，之后的裸键都属于那个表。
4. **验证闭环**：发一句 Hello 看能否回复，再去中转站用量页确认有请求记录；没记录说明 `config.toml` 没生效。
5. **常用斜杠命令**：`/compact` 手动压缩上下文；`/plan` 进入规划模式（不写文件，先探索、出计划、问澄清问题）；`/model` 切模型并调推理强度；`@` 引用文件。

```d2
direction: down
ent: 三个入口 {
  d: Codex Desktop
  c: Codex CLI
  v: "VS Code 插件 openai.chatgpt"
}
h: "~/.codex/" {shape: cylinder}
t: "config.toml\nmodel_provider → model_providers.X\nbase_url / wire_api / 凭证方式"
j: "auth.json\n登录态或 API key"
ss: "sessions/YYYY/MM/DD/rollout-*.jsonl\n会话记录"
api: "Responses 接口\n官方或中转站"
ent.d -> h
ent.c -> h
ent.v -> h
h -> t
h -> j
h -> ss
t -> api
```

### 📝 作者是怎么讲的

- **用一句话交代和上一篇的关系。** 开头直接说「上一篇已经论证过为什么选 Codex」，这里不重复。系列文章之间这样互相引用，能避免同一个论点在多处重复写。
- **先给全景，再收敛到「配置只有一份」。** 先列出 Desktop / CLI / VS Code 插件三种形态，并给出偏好（推荐 Desktop），紧接着点出关键事实：三者共用 `~/.codex/`，配置只需要做一次。读者不再纠结装哪个，因为选哪个都不影响后面的步骤。
- **照顾新手到「隐藏目录怎么显示」。** 在 macOS、Windows、Linux 三个平台上分别给出显示隐藏文件的方法。作者很清楚读者里有新手，宁可多写一行，也不让人卡在第一步。你写给 QA 或非前端同事的文档时，可以学这种「把门槛降到最低」的意识。
- **把配置拆成职责清楚的两份文件。** `config.toml` 管去哪（provider、模型），`auth.json` 管凭证。先讲每个文件的作用，再给内容，读者理解了结构，以后就能自己改。
- **验证要形成闭环，排错要有方向。** 发一句 Hello 之后，还要去中转站的用量页确认真的产生了请求。没响应的话，排查范围缩小到两处：`model_provider` 和 `base_url`。
- **常用命令只讲「什么时候用」。** `/plan` 一条给出了取舍：简单任务直接说，复杂任务先 plan 对齐思路。最后用「用多了就熟悉了」收尾，不罗列所有命令，因为输入 `/` 本来就能看到全部。

## 速查

| 想做的事 | 命令 / 位置 |
|---|---|
| 版本 | `codex --version`（本机 `codex-cli 0.153.4`） |
| 非交互执行 | `codex exec "..."`（别名 `e`） |
| 非交互代码审查 | `codex review` |
| 恢复 / 分叉会话 | `codex resume [--last]` / `codex fork [--last]` |
| 打开桌面端 | `codex app` |
| 体检 | `codex doctor` |
| 临时覆盖配置 | `codex -c key=value`（值按 TOML 解析） |
| 叠加 profile | `codex -p <name>` → 叠加 `$CODEX_HOME/<name>.config.toml` |
| 沙箱 / 审批策略 | `-s read-only\|workspace-write\|danger-full-access`，`-a on-request\|never` |
| 规划模式 | 会话内 `/plan` |

> ⚠️ 勘误/补充
> - 原文只给了 `requires_openai_auth = true` + `auth.json` 存 `OPENAI_API_KEY` 这一种凭证方式。自定义 provider 还可以用 **`env_key = "<环境变量名>"`**，让 Codex 从环境变量读 key、不落盘到 `auth.json`——你本机 `[model_providers.llm_proxy]` 段就是 `name / base_url / env_key / wire_api` 四个键。对「密钥不写文件」的要求，`env_key` 更合适。
> - 原文说 `/plan` 下「文件写入被禁用」。本机 0.153.4 二进制里确实有 `/plan` 和独立的「Plan mode reasoning effort」设置（规划模式可以单独设推理强度）。是否严格禁写是原文的说法，本机未逐项实测，按「推测：只读规划」理解即可。
> - 原文没提但 CLI 里有：`codex review`、`codex fork`、`/goal`、`codex mcp`、`codex plugin`。原文的模型名 `gpt-6.1-sol` 是中转站当时的命名，会变。

## 回到主线

`/compact` 和 `/plan` 是两种最朴素的上下文管理：前者在上下文快满时用摘要替换旧消息（拿走 token，代价是丢细节）；后者在动手前先把「需求 → 计划」这一段压成一份确认过的文档，后续执行就基于它，而不是基于一长串来回试错的对话。这两个机制在 [上下文压缩](../p3-agent-internals/05-context-compaction.md) 和 [让 Agent 先规划再动手](../p4-mini-cc/21-plan.md) 里拆实现。

## 对照你的环境

- `~/.codex/config.toml` 顶部是 `model` / `model_reasoning_effort` / `model_provider` 三个键，provider 指向 `[model_providers.llm_proxy]`，用 `env_key` 取凭证——结构与原文一致，只是凭证换成了环境变量方式（注释说明参照的是公司内部的 Codex Setup Guide）。
- 同一个文件里还有 `[mcp_servers.*]`（computer-use、node_repl）、`[plugins."...@openai-bundled"]`、`[projects."<路径>"]`（各目录的信任设置）和 `[hooks.state]`——Codex 也有 MCP、插件、hooks、按项目信任这一整套，和 Claude Code 的 `settings.json` 一一对应。
- 你的 `codex-review` / `codex-cross-review` skill 调的就是 `codex review`；Codex 会话落在 `~/.codex/sessions/2026/08/10/rollout-*.jsonl` 这类按日期分目录的文件里，对照 [你的聊天记录存在哪](./07-session-storage.md)。

## 自测题

1. 有人把 `model_provider = "aicode007"` 写在了 `[model_providers.aicode007]` 表的下面，Codex 仍然走官方登录。为什么？
2. `wire_api = "responses"` 和 `"chat"` 的差别对 Agent 意味着什么？（提示：想想推理内容、工具调用、服务端状态。）
3. 你想在 CI 里跑 `codex review`，又不想把 key 写进 `auth.json`。给出配置方案。

<details>
<summary>参考答案</summary>

1. TOML 中，`[表头]` 之后的键都归属于该表。写在表下面的 `model_provider` 变成了 `model_providers.aicode007.model_provider`，顶层没有 `model_provider`，于是用默认的 OpenAI provider。
2. 两者对应 OpenAI 的两代接口：Responses 接口原生支持推理条目、内置工具（如 web_search）和更结构化的输出项；Chat Completions 是旧的 messages 格式。Codex 新功能优先基于 Responses，中转站必须实现 `/responses` 才能完整支持。（细节以 OpenAI 官方文档为准。）
3. 在 `config.toml` 的自定义 provider 里用 `env_key = "MY_KEY"`，CI 里把 key 注入成环境变量 `MY_KEY`；或者用 `codex -c` 在命令行覆盖 provider 配置。凭证只存在于 CI 的 secret 和进程环境里。

</details>

## 相关章节

- [用 Codex 还是 Claude Code？](./01-tools-landscape.md) · [安装使用 Claude Code](./02-install-and-use.md) · [安装使用 OpenClaw](./04-install-and-use.md)
- [AI 编程的基本常识](./05-ai-tips.md) · [你的聊天记录存在哪](./07-session-storage.md)
- [Codex 自动记忆系统](../p3-agent-internals/07-auto-memory.md)
- [让 Agent 先规划再动手](../p4-mini-cc/21-plan.md)
- [详解 LLM API 的流式响应模式](../p2-agent-basics/09-streaming-response.md)
