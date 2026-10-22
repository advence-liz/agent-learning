# 写作规范（所有章节共用）

## 读者
Rason，前端工程师（TypeScript/React，公司的 webapp 项目），**Claude Code 重度用户**：
- 自建 40+ skill（`~/dotfiles/claude-skills`，`~/.claude/skills` 是指向它的 symlink），按 cwd 注入护栏的 SessionStart hook（`~/.claude/bin/inject-guardrails.sh`）
- 配了 10 类 hook：Notification / PermissionRequest / PreToolUse / PostToolUse / SessionStart / SessionEnd / Stop / StopFailure / SubagentStop / UserPromptSubmit
- 日常用 subagent、fork、workflow、codex 异源 review、MCP（Linear / Notion / 内部平台 / chrome-devtools）
- Python 会写但不是主力；ML 数学需要从直觉讲起

所以：**不讲「怎么点按钮」，讲「它内部怎么实现」+「你自己怎么写一个」**。能联系到他现有环境的就点名联系（例如「你的 inject-guardrails.sh 就是 SessionStart hook 的 additionalContext 用法」）。

## 定位与讲法（借鉴原站作者的构思）
这是 Rason 的**个人 AI 开发学习知识库**。借鉴 labuladong 的讲法：
- **一条主线贯穿全库**：LLM 的本质是「根据已有 token 预测下一个 token」的概率模型；Agent / Function Calling / MCP / Skills / 压缩 / 记忆 / Sub Agent / Harness 都是**在有限上下文里尽可能准确高效完成任务的工程方法**。每章「原理」一节结尾加一句「回到主线」：本章技术在上下文这件事上解决了什么（省 token？换取可靠性？扩展能力边界？）。
- **框架思维**：先抓本质，再看技巧，不被名词迷惑；遇到新名词先问「它往上下文里放了什么、拿走了什么」。
- **先用起来再讲原理**：先给现象 / 体验，再拆实现；原理落到「朴实无华」的代码。
- **可运行**：每个原理都配最小可跑代码，读者能亲手验证。
- 章节之间用相对链接互相引用（如 `[Sub Agent](../p1-tools/10-sub-agent.md)`），形成知识网络。

## 文风：学作者的写法，不抄作者的句子
从原站 18 篇免费文章里归纳出来的写法，全库照此写（只学方法，句子必须自己写）：
1. **用读者心里真实的疑问开场**，不写定义。例：「Cursor 里也能选 Claude 模型，为什么 Claude Code 配 Claude 效果最好？」→「有这个疑问，说明还没搞清 LLM 和 Agent 的关系」。我们的开场要换成 Rason 会遇到的疑问（例如「我的 Stop hook 为什么有时拦不住 Claude 说『已完成』？」）。
2. **用「你可能会问：……？」自问自答往前推**，一层一层追问下去，而不是罗列要点。
3. **一个核心概念配一个生活类比**（引擎和整车、背棋谱的人、读长书只记得开头结尾），类比之后马上说清它在哪里不成立。
4. **口语、短段落**：一段 1–3 句；可以用「说白了」「其实」「举个例子」；术语第一次出现给英文，接一句大白话解释。
5. **先跑起来看看，再拆代码**：动手章先给一段终端交互记录（`❯` 用户输入 / `⏺ tool_call` / `✔ tool_return` 的格式），让读者先看到效果，再逐段讲实现。
6. **有自己的观点并说明理由**：例如「说实话，hooks 大部分时候用不上」「我认可 plan 模式，因为……」；常把 Claude Code 和 Codex 的做法放在一起比，讲清两边各自的取舍。
7. **把复杂度降到「朴实无华」**：讲完机制后点一句「说穿了就是往 messages 数组里多塞了一条 / 多开了一个循环」。
8. **结尾回到开头的问题**，用本章学到的东西回答它（我们再加一句「回到主线」）。

结构上，前面「结构（每章）」那 10 节是**要包含的要素**，不是死板的小标题：小标题用概念短语（「Agent：给 LLM 套上循环」这种），读起来要像一篇连贯的讲解，而不是填表。「常见坑」「练习」「延伸阅读」可以保留为固定的结尾小节。

## 原创性（硬性）
- 这些章节对应 labuladong.online 的**付费文章**。我们只借用它的**选题与章节标题**，正文必须**完全原创**：不得抓取、复述或改写原站付费正文（我们也拿不到）。`src_preview` 字段仅为原站公开的开头几百字，用来理解该章的范围，不要照抄。
- 每章开头写一行：`> 对应原站：[标题](src)（会员内容；本章为独立原创重写）`

## 事实准确性（硬性）
- Claude Code / Codex / MCP / SDK 的行为：以官方文档、本机实测（`~/.claude/` 下的真实文件、`claude --help`、`~/.claude/projects/*/*.jsonl`）为准。查不到就写「推测」并说明依据，**不许编造**配置字段、命令、事件名。
- Claude 模型 ID：`claude-opus-5-5` / `claude-sonnet-5-5` / `claude-haiku-5-5`（写 Anthropic SDK 代码前先加载 `claude-api` skill 核对用法）。
- 代码必须能跑：写完在 `uv run` / `node` 下实跑（或至少不需要 API key 的单测 + Node 版 `npm run typecheck`），把真实输出贴进文中。需要 API key 的地方用 `ANTHROPIC_API_KEY` 环境变量，并支持 `ANTHROPIC_BASE_URL`（中转站）。

## 结构（每章）
1. `# 标题`
2. 对应原站一行
3. **一句话结论**（blockquote，1–2 句，读完全章要记住的那一件事）
4. 「为什么需要它」——从一个具体痛点切入
5. 「原理」——优先用 Mermaid 图（时序 / 流程 / 状态）讲清机制，文字做图注
6. 「动手」——最小可运行代码 / 可复现实验，带真实输出
7. 「对照你的环境」——联系 Rason 现有的 Claude Code 配置或 webapp 工作（没有就省略，别硬凑）
8. 「常见坑」——3–5 条
9. 「练习」——2–3 道，由易到难，最后一道是开放题
10. 「延伸阅读」——官方文档 / 源码链接

篇幅：概念章 1500–3000 字；动手章以代码为主，不设上限但不注水。中文写作，术语首次出现给英文。

## 代码目录
- Agent 相关代码：`/Users/liz/liz/agent-learn/code/`，用 uv 管理（`uv init` 后 `uv add anthropic` 等），Python 3.12（`uv python install 3.12`）。
- `p4-mini-cc` 的 mini Claude Code 在 `code/mini_cc/`，**每章是一次增量提交**：在 `code/mini_cc/CHANGELOG.md` 记录每章新增了什么，章节正文引用具体文件与函数。
- ML 代码：`code/ml/`，用 numpy / torch，数据用 sklearn 自带数据集或脚本生成，不依赖外网下载大文件。
- 第 0–4 部分的代码有 Node 版：`code/agent-node`、`code/mini_cc-node`（TypeScript，Node 24 直接跑 `.ts`），约定见 `code/agent-node/README.md`。正文里每段代码写成 `=== "Node"` / `=== "Python"` 两个标签页，Node 在前（默认展示），两版逻辑一致、输出都要实跑。
- 三个 uv 项目已建好：`code/agent`（anthropic 1.17 / mcp / httpx / rich / numpy）、`code/mini_cc`（anthropic / mcp / rich / prompt_toolkit / pytest）、`code/ml`（numpy / scikit-learn / matplotlib / torch / pytest）。缺包就在**自己负责的项目**里 `uv add`。
- **不要发起真实的 Anthropic API 调用**（用户规定不主动调用 Anthropic）。验证靠：可注入的 fake client / 录制好的响应 fixture + pytest。文中贴的「运行输出」必须是 fake 模式下的真实输出，并注明「离线 fake 模型」；真实模型输出只能写成「你本地设了 key 后会看到类似…」。
- 不要 `git commit`、不要 push、不要动 `code/` 和你负责目录之外的文件。
