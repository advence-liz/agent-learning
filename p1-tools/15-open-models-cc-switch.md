# 用 CC Switch 和 cc-connect 让 Claude Code 跑开源模型

> 本章不对应原站文章，是知识库的补充章节（独立原创）：整理我在本机用 CC Switch 切换模型供应商、用 cc-connect 从 IM 驱动 Claude Code 的实际配置，换上 GLM / Kimi / DeepSeek 这类开源模型时踩过的点。

> **一句话结论**：换模型只是改环境变量。Claude Code 只会说 Anthropic Messages 协议，网关负责翻译，CC Switch 和 cc-connect 只是把「改哪几个变量」做成了一键切换。真正要配对的是几个容易漏的变量：后台模型、上下文窗口、auto 模式审查。漏了它们，不会报错，只会悄悄变慢、变贵，或者偷偷走回官方模型。

## 改一个 ANTHROPIC_BASE_URL 就够了吗？

想让 Claude Code 跑在开源模型上，网上的教程大多只有两行：把 `ANTHROPIC_BASE_URL` 指向一个兼容 Anthropic 协议的网关，再填一个 key。

这样确实能对话。但我本机能长期用的那份配置里，除了这两行，还多了六七项。每一项都对应一个只改两行时会出的问题：

- 子 agent、会话标题这类后台请求，还在发 Claude 的模型名，网关不认识。
- Claude Code 不认识这个模型 ID，按默认窗口估算上下文，自动压缩的时机不对。
- auto 模式的服务端审查依赖 Anthropic，走网关时用不了。

本章把这份配置拆开讲，再讲两个工具各自管哪一段。

先说清楚官方立场：Claude Code 文档写明，Anthropic 不支持通过任何网关把 Claude Code 接到非 Claude 模型上。下面所有内容都是「能跑」，不是「官方支持」。工具调用格式、思考块、缓存这些行为，开源模型和 Claude 不完全一样，遇到问题只能自己排查。

## 三层：Claude Code、网关、模型

Claude Code 是 harness，它只管循环、工具和上下文，模型是可以换的。这一点在[用 Codex 还是 Claude Code](01-tools-landscape.md)里讲过。换模型时，链路上有三层：

```d2
direction: down

im: "IM 里发消息\n（Slack 线程 / 飞书）"
desk: "终端里直接用 claude"

connect: "cc-connect\n按项目起 claude 子进程\n把 provider 映射成环境变量"
sw: "CC Switch\n把 provider 写进\n~/.claude/settings.json 的 env"

cc: "Claude Code\n只会发 Anthropic Messages 请求"
gw: "模型网关\n兼容 /v1/messages\n（团队网关、OpenRouter 类聚合服务、厂商官方兼容端点）"
models: "GLM / Kimi / DeepSeek …"

im -> connect
desk -> sw: "切换 provider" {style.stroke-dash: 3}
connect -> cc: "子进程 env"
sw -> cc: "热加载 settings.json"
cc -> gw: "ANTHROPIC_BASE_URL"
gw -> models: "按模型名转发"
```

图注：CC Switch 和 cc-connect 管的是同一件事，即「这次启动 Claude Code 时带哪组环境变量」，只是入口不同。一个面向桌面和终端，一个面向聊天软件。网关负责把 Anthropic 格式的请求转给真正的模型。

你可能会问：那网关不兼容 Anthropic 协议，只有 OpenAI 格式怎么办？CC Switch 有一个本地路由（默认监听 `127.0.0.1:15721`），能把 OpenAI Chat Completions、OpenAI Responses、Gemini 格式转换成 Anthropic 格式。代价是 CC Switch 必须一直开着，退出后会切回直连。

## 一份能长期用的 provider 配置

下面是我在 CC Switch 里给开源模型网关配的 provider，`~/.claude/settings.json` 里最终写入的就是这段 `env`。地址和 key 换成了占位符：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://<你的模型网关>",
    "ANTHROPIC_AUTH_TOKEN": "<网关 token>",
    "ANTHROPIC_MODEL": "glm-5.3-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.3-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.3-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.3-flash",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "glm-5.3-flash",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "<模型真实的上下文窗口>",
    "CLAUDE_CODE_AUTO_MODE_SERVER": "0"
  },
  "modelPicker": {
    "replaceBuiltInOptions": true,
    "options": [
      { "model": "glm-5.3-flash", "label": "glm-5.3-flash (vision)" },
      { "model": "glm-5.3", "label": "glm-5.3" },
      { "model": "deepseek-v4.1-flash-1017", "label": "deepseek-v4.1-flash-1017 (vision)" },
      { "model": "kimi-k3.1-pro", "label": "kimi-k3.1-pro" }
    ]
  }
}
```

逐项说为什么要配（字段含义都对过 Claude Code 官方的 env-vars、model-config、settings 文档）：

| 配置 | 作用 | 漏了会怎样 |
|---|---|---|
| `ANTHROPIC_AUTH_TOKEN` | 放进 `Authorization: Bearer` 头 | 网关要 Bearer 时，填成 `ANTHROPIC_API_KEY`（走 `x-api-key` 头）会 401 |
| `ANTHROPIC_MODEL` | 主会话用哪个模型 | 继续发 Claude 的模型名，网关不认 |
| 四个 `ANTHROPIC_DEFAULT_*_MODEL` | `opus` / `sonnet` / `haiku` / `fable` 这些别名解析成什么；`haiku` 那个还用于会话标题等后台任务 | 子 agent 写 `model: haiku`、后台任务，仍发 Claude 模型名 |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | 告诉 Claude Code 这个模型的窗口多大 | 不认识的模型 ID 默认按 200K 算，自动压缩的时机全错 |
| `CLAUDE_CODE_AUTO_MODE_SERVER=0` | auto 模式改用 Claude Code 自己发的分类器请求，不让服务端审查 | 服务端审查是 Anthropic 那边的能力，开源模型网关后面没有 |
| `modelPicker` | 定制 `/model` 里的列表；`replaceBuiltInOptions: true` 时只显示这些行 | 列表里全是 Claude 模型，选了也用不了 |

两条经验：

- **四个别名全指向开源模型。** 只设 `ANTHROPIC_MODEL` 的话，子 agent 写 `model: haiku`、后台任务用的 haiku 别名，都还会解析成 Claude 的模型名。说白了，Claude Code 里「用哪个模型」不止一个入口，要把每个入口都堵上。
- **label 里标能力。** 开源模型有的能看图、有的不能。我在 label 上写 `(vision)`，贴截图前先看一眼 `/model`。

网关如果拒绝 Claude Code 带的 beta 字段（报 `Unexpected value(s)` 或 `Extra inputs are not permitted`），再加 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`。它会去掉 beta 请求头和对应的字段，代价是 MCP 工具搜索也一起关掉。

## CC Switch：一键切换写的是 settings.json

CC Switch 是一个桌面 App（我用的是 4.0.6），统一管理 Claude Code、Codex、Gemini CLI 等工具的模型供应商，顺带管 MCP、Skills 和 prompt。

切换 Claude Code 的 provider 时，它只改 `~/.claude/settings.json` 里的关键字段：`ANTHROPIC_*`、`model` 等。permissions、hooks、statusLine 这些不动。第一次改写前，它会把原文件备份到 `~/.cc-switch/backups/`。Claude Code 支持热加载，所以切完不用重启。

我的 provider 列表大致是这几类：

- **官方订阅**：平时的主力，切回它就是清空自定义 env。
- **开源模型网关**：上面那份配置，用来试开源模型、对比不同模型。
- **OpenAI 格式的模型**：provider 的 API 格式选 `openai_responses`，要开本地路由做格式转换。

另外两个功能值得知道：

- **聚合模式**：一个 provider 挂多个模型，按 `/model` 选的模型把请求分到不同供应商。它不做故障转移，要求 Claude Code 2.1.243 以上。
- **用量统计**：本地路由关着也能统计。CC Switch 会读各工具的本地会话日志，按请求写进自己的 SQLite 库 `~/.cc-switch/cc-switch.db`。下面「动手」就用这个库。

## cc-connect：在聊天软件里驱动本机的 Claude Code

cc-connect 是一个开源的桥接程序：一头接 Slack、飞书、Telegram 等聊天软件，一头在本机起 Claude Code、Codex 等 agent 的子进程。大多数平台不需要公网 IP。它和 [OpenClaw](04-install-and-use.md) 解决的是同一个问题，即离开电脑也能派活，但 cc-connect 驱动的就是你本机的 Claude Code，配置、skill、hook 全部沿用。

它的 provider 和 CC Switch 是两套各自独立的配置，不过思路一样：全局定义一次，项目按名字引用。下面是我的配置骨架（`~/.cc-connect/config.toml`，项目名、路径、ID、token 都换成了占位符）：

```toml
[[providers]]
name = "open"                       # 开源模型网关
api_key = "${OPEN_GATEWAY_TOKEN}"   # 支持从环境变量读，不要明文写进文件
base_url = "https://<你的模型网关>"
model = "glm-5.3-flash"
agent_types = ["claudecode"]

[[providers]]
name = "official"                   # 不填 key：沿用本机 Claude Code 自己的登录
agent_types = ["claudecode"]

[[projects]]
name = "webapp"
admin_from = "<你自己的用户 ID>"     # 只给自己 /shell、/dir 这类特权命令

[projects.agent]
type = "claudecode"
provider_refs = ["open", "official"]

[projects.agent.options]
work_dir = "~/work/webapp"
provider = "official"               # 默认用哪个
model = "haiku"
mode = "default"                    # 每次工具调用都在聊天里问你

[[projects.platforms]]
type = "slack"

[projects.platforms.options]
allow_from = "<你自己的用户 ID>"
session_scope = "thread"            # 一个线程一个会话
```

几个设计点：

- **provider 怎么生效。** 对 Claude Code，`api_key` 映射成 `ANTHROPIC_API_KEY`，`base_url` 映射成 `ANTHROPIC_BASE_URL`，注入子进程环境。上一节那些「别名、窗口、auto 审查」变量，全局 `[[providers]]` 的字段里没有。要补的话，按文档改用项目级的 `[[projects.agent.providers]]`，它支持 `env` 字段。别写进 `~/.claude/settings.json`：那里的 env 对所有会话生效，切回官方模型时也会带着。
- **聊天里随时切。** 发 `/provider switch open` 就把当前项目切到开源模型，`/provider list` 看有哪些。我的配置是默认官方模型加 `haiku`，开源模型挂在 `provider_refs` 里备用，需要时在线程里切过去。
- **一个线程一个会话。** `session_scope = "thread"` 时，Slack 里每开一个线程就是一个独立的 Claude Code 会话，互不串上下文。
- **权限从紧。** `allow_from` 只放自己；`admin_from` 绝不写 `"*"`。官方配置示例原话是：这会让所有被允许的用户拿到这台机器的完整 shell。`mode` 也别图省事设成 `yolo`：聊天消息、网页内容都可能带注入，后果见 [Agent 安全](../p3-agent-internals/15-agent-security.md)的「致命三要素」。

如果两边都用，`cc-connect provider import` 可以从 CC Switch 导入 provider，省得配两遍。

## 动手：开源模型的缓存命中率真的低吗？

换模型后，最先想知道的是：便宜了多少，缓存还管不管用。CC Switch 的库里每条请求都有 token 拆分，用 `sqlite3` 只读查一下就行（`-readonly`，不会改库）：

```sql
-- sqlite3 -readonly -header -column ~/.cc-switch/cc-switch.db < usage.sql
SELECT CASE WHEN model LIKE 'claude%'   THEN 'claude'
            WHEN model LIKE '%glm%'      THEN 'glm'
            WHEN model LIKE '%deepseek%' THEN 'deepseek'
            WHEN model LIKE '%kimi%'     THEN 'kimi'
            ELSE 'other' END AS family,
       COUNT(*) AS requests,
       ROUND(100.0 * SUM(cache_read_tokens)
             / SUM(input_tokens + cache_read_tokens + cache_creation_tokens), 1) AS hit_pct,
       SUM(cache_creation_tokens) > 0 AS reports_write,
       ROUND(1.0 * SUM(output_tokens) / COUNT(*)) AS out_per_req
FROM proxy_request_logs
WHERE data_source = 'session_log'
  AND created_at BETWEEN strftime('%s','2026-10-30') AND strftime('%s','2026-11-06')
GROUP BY family ORDER BY requests DESC;
```

我本机 2026-10-30 到 11-05 这一周的结果（只有聚合数字，没有会话内容）：

```text
family    requests  hit_pct  reports_write  out_per_req
--------  --------  -------  -------------  -----------
glm       13733     90.3     0              999.0
deepseek  6181      90.4     0              2987.0
claude    3291      98.8     1              627.0
kimi      2065      90.5     0              596.0
```

读出来三件事：

- **缓存还在起作用，但命中率低一截。** 开源模型都在 90% 左右，Claude 是 98.8%。原因我没有逐条核对，是**推测**：Claude Code 的 `cache_control` 断点是按 Anthropic 的缓存规则放的，网关后面的模型用的是各自的自动前缀缓存，前缀匹配的粒度和保留时间都不一样。
- **开源模型的「缓存写入」都是 0。** 不是没写，是上游不单独报告写入，没命中的部分直接算进普通输入。所以对比成本时，按「输入 + 缓存读」算，别指望从写入那一列看出什么。
- **DeepSeek 平均每次输出约 3000 token，是别家的 3–5 倍。** 我的**推测**是思考内容计入了输出。按输出计费时，这一点比单价差异更影响账单。

这份统计只说明我这一周的用法，任务类型不同，数字会差很多。它的价值是给你一个现成的办法：换模型以后，用同一个查询看自己的数据。

回到主线：换模型没有改变「上下文怎么组织」，Claude Code 照样追加 messages、照样放缓存断点、照样压缩。变的是另一端怎么计价、怎么缓存。所以换模型以后，要重新核对的是压缩时机（窗口变量）和缓存命中率这两件事，而不是 prompt 本身。

## 常见坑

1. **只改了 `ANTHROPIC_MODEL`**。子 agent、后台任务走别名，四个 `ANTHROPIC_DEFAULT_*_MODEL` 要一起改。
2. **`ANTHROPIC_API_KEY` 和 `ANTHROPIC_AUTH_TOKEN` 填反**。前者走 `x-api-key` 头，后者走 `Authorization: Bearer`，看网关要哪个。设了其中任何一个，它都会优先于你本机保存的 claude.ai 登录。
3. **没设上下文窗口**。不认识的模型 ID 按 200K 算；模型实际只有 128K 时，压缩来不及触发，请求直接被拒。
4. **key 明文写进 cc-connect 的 config.toml**。这个文件常被备份、拷贝；用 `${VAR}` 从环境变量读。CC Switch 的 provider 存在本地数据库里，同样别把整个 `~/.cc-switch` 目录同步到公开的地方。
5. **把聊天软件当成可信输入**。cc-connect 让任何能给 bot 发消息的人驱动你的机器，`allow_from`、`admin_from`、`mode` 三项一起收紧。

## 练习

**1.** 在 CC Switch 里新建一个 provider，只设 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL` 三项，开一个新会话，跑一个会派子 agent 的任务。然后查 `~/.claude/projects/` 下这次会话的 jsonl，看 `message.model` 字段里出现了哪些模型名。

<details>
<summary>提示</summary>

预期会看到不止一种模型名：主会话是你设的开源模型，子 agent 或会话标题之类的后台请求可能是别名解析出来的 Claude 模型名，并且这些请求在网关那头报错或被拒。把四个 `ANTHROPIC_DEFAULT_*_MODEL` 补上后再跑一次，模型名应该只剩一种。jsonl 的结构见[你的聊天记录存在哪](07-session-storage.md)，统计时只读 `message.model`，不要打印正文。

</details>

**2.** 把「动手」里的查询改成按天统计，看开源模型的缓存命中率在一天之内的不同时段有没有差别；再加一列，按 CC Switch 库里 `model_pricing` 表的单价估算每个模型族的花费。

<details>
<summary>提示</summary>

按天用 `date(created_at, 'unixepoch')` 分组；按小时用 `strftime('%H', created_at, 'unixepoch')`。花费可以直接用 `proxy_request_logs` 里现成的 `total_cost_usd` 求和，也可以 `JOIN model_pricing ON model_pricing.model_id = proxy_request_logs.model` 自己算，两种结果对一下。注意开源模型没有写入那一列，计费口径以网关的账单为准，库里的单价只是 CC Switch 的估算。

</details>

**3.** 开放题：你想在手机上通过 Slack 让家里电脑上的 Claude Code 帮你跑 webapp 的单测并汇总失败用例，平时用开源模型省钱，遇到改代码再切回官方模型。设计一下 cc-connect 的配置和使用约定：provider 怎么配、谁能发消息、默认什么权限模式、哪些命令绝不能放开。

<details>
<summary>提示</summary>

判断方向：两个 provider 用 `provider_refs` 挂在同一个项目上，默认开源模型加 `mode = "default"`，只读的跑测试、汇总不需要放宽权限；要改代码时在线程里 `/provider switch` 切到官方模型，并且每次改动都在聊天里批准。`allow_from`、`admin_from` 只写自己的 ID，`/shell` 这类特权命令不开给别人。再想一层：测试输出、依赖的 README 都是不可信内容，结合[Agent 安全](../p3-agent-internals/15-agent-security.md)的三要素，想清楚这台机器上有哪些私有数据、能不能对外发消息。

</details>

## 延伸阅读

- Claude Code 官方：[环境变量](https://code.claude.com/docs/en/env-vars)、[模型配置](https://code.claude.com/docs/en/model-config)、[LLM gateway](https://code.claude.com/docs/en/llm-gateway)、[通过网关时的缓存](https://code.claude.com/docs/en/prompt-caching)
- [CC Switch](https://github.com/farion1231/cc-switch)（用户手册在仓库的 `docs/user-manual/` 下）
- [cc-connect](https://github.com/chenhg5/cc-connect)（`INSTALL.md`、`docs/usage.md`、`config.example.toml`）
- 本库：[用 Ollama 在本地运行大模型](13-local-llm-ollama.md)（同一个机制，换成本机模型）、[上下文和 token 计费](../p0-core/03-messages-and-tokens.md)、[成本控制与模型路由](../p3-agent-internals/17-cost-and-routing.md)、[安装使用 OpenClaw](04-install-and-use.md)
- 上一章：[看懂 Hugging Face 和模型文件](./14-hugging-face-model-files.md)
- 下一部分：[第 2 部分 · Agent 开发基础](../p2-agent-basics/01-ai-chatbot.md)，从动手写一个聊天机器人开始
