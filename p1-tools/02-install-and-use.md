# 安装使用 Claude Code

> 原文（免费）：[安装使用 Claude Code](https://labuladong.online/zh/ai-coding/claude-code/install-and-use/) —— 建议先读原文，本页是我的笔记

**一句话结论**：Claude Code 只是一个「把请求发给 Anthropic Messages 接口」的终端 Harness；装好之后真正要配的只有一件事——**请求发到哪（base URL / 云渠道）、用谁的凭证、默认哪个模型**，而这三项都能通过 `settings.json` 的 `env` 持久化。

> 你早已装好并重度使用，本页压缩为「速查 + 你机器上的对应位置」，不写安装教程。

## 核心要点

1. **Claude Code ≠ Claude 模型**。前者是 Agent 工具，后者是它默认调用的 LLM。只要服务端兼容 Anthropic 的 API 格式，就能把别家模型接进 Claude Code（原文就用中转站跑 GPT）。
2. **安装渠道**：官方原生安装脚本（推荐，自动后台更新）、Homebrew、WinGet、Linux 包管理器、npm。装完用 `claude --version` 验证，`claude doctor` 做体检。
3. **请求路由靠三个环境变量**：`ANTHROPIC_BASE_URL`（发到哪）、`ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`（凭证）、`ANTHROPIC_MODEL`（默认模型）。中转站本质是一个转发代理。
4. **持久化**：`export` 只对当前终端生效；写进 `~/.claude/settings.json` 的 `env` 字段，每次启动自动注入。原文提醒：如果文件里已有别的 base URL / token，要一起替换，否则请求会发错地方。
5. **进会话后核对**：`/status` 看当前 base URL 与账号，`/model` 切模型。
6. **IDE 里用**：作者首推「在编辑器内置终端里跑 `claude`」，它能感知打开的文件；VS Code / JetBrains 插件是更集成的选项，插件改配置后要**完全重启编辑器**。

```d2
direction: down
u: 你在终端输入
cc: "Claude Code\nHarness"
s: "~/.claude/settings.json\nenv 字段" {shape: cylinder}
a: "Anthropic 官方 API\n需登录 / API key"
p: 中转站代理
a2: Claude 或兼容格式的其它模型
v: Google Cloud Vertex 上的 Claude
u -> cc
s -> cc: 启动时注入
cc -> a: "ANTHROPIC_BASE_URL 未设"
cc -> p: "ANTHROPIC_BASE_URL=中转站"
p -> a2
cc -> v: "CLAUDE_CODE_USE_VERTEX=1"
```

### 📝 作者是怎么讲的

- **开头先摆立场，再讲内容。** 第一段就说明「上一篇我推荐的是 Codex」，这篇只服务于「还想试试 Claude Code」的读者。先把读者的预期放对，写操作手册时值得照做。
- **从一个现实痛点推出方案。** 他先解释 Sonnet 和 Opus 是「标准版 / 专业版」（用了产品分档的类比），接着抛出问题：Claude 模型最贵，非专业用户怎么办？答案是：只要接口格式兼容，就能换别的模型。这样一来，中转站和 `ANTHROPIC_BASE_URL` 是作为「解决方案」出场的，不是凭空冒出来的一项配置。
- **按「临时 → 持久」的顺序讲配置。** 先用 `export` 让读者马上跑起来，再点出「关掉终端就失效」这个痛点，然后引出 settings.json 的 `env` 字段。先让读者有收获，再处理麻烦，这是教程类文章的节奏。
- **每一步都给验证方法。** 配完立刻用 `/status` 核对 base URL，不对就说明环境变量没生效。每一步配完都能自检，读者不会走到最后才发现第一步就错了。
- **有观点，并把坑说出来。** 他明说 CLI 最顺手，「强烈推荐」在编辑器内置终端里直接跑 claude，插件只是给实在想要集成体验的人用的。VS Code 一节专门指出「改完必须完全重启」这个多数人会踩的坑。你写 skill 或 README 时也可以这样：先推荐一条路，再把最常见的失败原因单独写出来。

## 速查

| 想做的事 | 命令 / 位置 |
|---|---|
| 看版本 | `claude --version`（本机：`2.1.306 (Claude Code)`） |
| 体检安装与配置 | `claude doctor` |
| 升级 | `claude update`（别名 `upgrade`） |
| 迁到原生安装 | `claude install [target]` |
| 继续上一次会话 / 选会话恢复 | `claude -c` / `claude -r` |
| 非交互输出 | `claude -p "..."` |
| 当前会话改模型 / 推理强度 | `--model` / `--effort`，会话内 `/model` |
| 用户级配置 | `~/.claude/settings.json`（另有 `settings.local.json`） |
| VS Code 插件 ID | `anthropic.claude-code` |

> ⚠️ 勘误/补充
> - **npm 安装要求 Node.js 22+**，不是原文的 18+（官方 [Advanced setup](https://code.claude.com/docs/en/setup) 写明「requires Node.js 22 or later」；旧版本只会打印 `EBADENGINE` 警告，因为 npm 包实际下载的是原生二进制）。
> - 原文的 `curl ... | bash -s stable` 装的是 **stable 渠道**（约晚一周、跳过有严重回归的版本），官方默认命令是不带参数的 `curl -fsSL https://claude.ai/install.sh | bash`（latest 渠道）。两者都对，但要知道差别；渠道也可以用 settings 里的 `autoUpdatesChannel` 改。
> - 官方支持系统比原文多了 Windows Server 2019+、Alpine Linux 3.19+。
> - VS Code 插件设置项的前缀是 **`claudeCode.`**，不是原文的 `claude-code.`：应写 `claudeCode.environmentVariables`、`claudeCode.disableLoginPrompt`（见官方 [VS Code 文档](https://code.claude.com/docs/en/vs-code) 的 Extension settings 一节）。
> - 原文的模型名（Sonnet 4.6 / Opus 4.7、`gpt-6-astra`）随时间和中转站变化；本机当前用 `claude-opus-5-5` / `claude-sonnet-5-5` / `claude-haiku-5-5`。

## 回到主线

本章没讲任何「上下文工程」，但它定义了上下文最终被送到哪里。`ANTHROPIC_BASE_URL` 能被替换，说明 Claude Code 和模型之间只是一条 HTTP 协议——这也是后面 [Claude Code 抓包分析工具](../p3-agent-internals/01-http-analyzer.md) 能把整个 messages 数组看得一清二楚的前提：把 base URL 指向你自己的代理，就能看到 Harness 每一轮往上下文里放了什么。

## 对照你的环境

- **安装方式**：`which claude` 指向 `~/.nvm/versions/node/v24.14.1/bin/claude`，是 **npm 全局安装**（包内是原生 `claude.exe`），不是原生安装器的 `~/.local/bin/claude`。所以官方说的「原生安装自动后台更新」对你不完全适用；npm 全局目录不可写时，启动会提示，`claude doctor` 会列修复方法。
- **请求路由**：你的 `settings.json` 的 `env` 里没有走中转站，而是 `CLAUDE_CODE_USE_VERTEX` + `ANTHROPIC_VERTEX_PROJECT_ID` 等 Vertex 相关变量——这是原文没讲的第三条路（云厂商渠道），等价于把「中转站」换成了 Google Cloud。（具体值属于凭证/内部地址，本笔记不抄。）
- **默认值**：`settings.json` 里 `model: "sonnet"`、`effortLevel: "high"`、`permissions.defaultMode: "bypassPermissions"`，另外 `modelSettings` 为 `claude-sonnet-5-5` / `claude-haiku-5-5` 单独设了 effort。
- **原文没提但你在用的 settings 字段**：`hooks`（10 类事件）、`statusLine`（指向 `~/.claude/statusline.sh`）、`enabledPlugins` / `extraKnownMarketplaces`（插件市场）。这些在 [Hooks](./08-hooks.md)、[Skills](./12-skills.md) 里展开。

## 自测题

1. 你在一台新机器上 `export ANTHROPIC_BASE_URL=...` 后能用了，第二天新开终端又要登录。为什么？给出两种持久化方法，并说出哪种对 VS Code 插件面板也生效。
2. `ANTHROPIC_MODEL` 设成一个 GPT 模型 ID，Claude Code 为什么还能跑起来？这对中转站提出了什么要求？
3. 你的机器上 `claude update` 后发现版本没变，可能是什么原因？怎么排查？

<details>
<summary>参考答案</summary>

1. `export` 只对当前 shell 进程及其子进程有效。持久化方法：写进 shell 配置（`~/.zshrc`），或写进 `~/.claude/settings.json` 的 `env`。后者是 Claude Code 自己读的，插件面板捆绑的 CLI 也会读 `~/.claude/`；而插件进程不一定继承你的 shell 环境，所以对插件更可靠的是 settings.json，或者插件自己的 `claudeCode.environmentVariables`。
2. Claude Code 只认 Anthropic Messages 格式的请求和响应，并不关心背后是什么模型。中转站必须把 Anthropic 格式翻译成目标模型的接口（包括 tool_use 等块），再把响应翻译回来。
3. 你是 npm 全局安装，更新受 npm 全局目录权限、`npm update -g` 的 semver 范围影响。先跑 `claude doctor` 看安装类型和上一次更新结果，必要时 `npm install -g @anthropic-ai/claude-code@latest`，或者 `claude install` 迁到原生安装。

</details>

## 相关章节

- [用 Codex 还是 Claude Code？](./01-tools-landscape.md) · [安装使用 Codex](./03-install-and-use.md)
- [Claude Code 的常用技巧](./06-useful-tips.md) · [你的聊天记录存在哪](./07-session-storage.md)
- [如何调用 LLM 接口](../p0-core/02-api-and-apikey.md)
- [Claude Code 抓包分析工具](../p3-agent-internals/01-http-analyzer.md)
- [用 Hooks 给 Claude Code 加规矩](./08-hooks.md)
