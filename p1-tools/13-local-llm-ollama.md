# 用 Ollama 在本地运行大模型

> 原文（免费）：[用 Ollama 在本地运行大模型](https://labuladong.online/zh/ai-coding/basics/local-llm-ollama/) —— 建议先读原文，本页是我的笔记

**一句话结论**：Ollama 是一个**推理引擎加模型包管理器**，基于 llama.cpp。它把「模型文件」变成一个本机的 HTTP 服务，兼容 OpenAI 和 Anthropic 两种接口格式。所以对 Agent 来说，本地模型和云端模型只差一个 base_url。真正的门槛是两件事：**运行内存（KV cache 是大头）**和**模型能不能撑起 Agent 的长上下文和工具调用**。

## 核心要点

1. **推理引擎和模型是两个东西**，好比播放器和视频文件。服务端常用 vLLM、SGLang 扛高并发，个人电脑上常用 llama.cpp 及其上层封装（Ollama、LM Studio）。
2. **模型 ID 的写法是 `名字:标签`**，比如 `qwen3:0.6b`，可以按 Docker 镜像来理解。标签可以表示参数规模、量化版本或用途。`0.6b` 指的是约 6 亿参数，不是文件大小。省略标签时默认用 `latest`，建议写全。
3. **挑模型时先看能力，再看规模**：要不要看图、调工具、开思考模式、处理长上下文，取决于架构和训练方式，参数量决定不了。同一系列里先从小的试起，原则是选「电脑能从容运行的最大模型」，不要选勉强能加载的那个。
4. **常用命令和 Docker 的对应关系**：`pull`、`run`、`list`、`rm` 基本照搬 Docker；`show` 看模型结构和默认采样参数；`ps` 看当前加载在内存里的模型；`stop` 卸载模型但不删文件。本地存储也和 Docker 一个思路，是 manifest 加上按内容哈希命名的文件块。
5. **本地服务的地址是 `http://localhost:11434/v1`，兼容 OpenAI 格式**。请求和响应的字段（model、messages、choices、usage）都和云端一致，代码里换掉 base_url、key、model 就能切过去。默认没有鉴权，**不要把 11434 端口暴露出去**。
6. **磁盘上的 522MB 运行起来会占 4.4GB**。多出来的主要是 KV cache，32K 上下文约占 3.7GB，再加上权重和临时张量。`ollama show` 显示的 context length 是模型支持的上限，`ollama ps` 显示的 CONTEXT 是这次运行实际分配的长度。
7. **接入 Coding Agent 只需要协议兼容**：Ollama 实现了 Anthropic Messages 接口，把 Claude Code 的请求地址指过去就能用（App 里有 `ollama launch` 一键生成命令）。但这只是换了「大脑」，Claude 模型并没有被下载到本地。Ollama 文档建议上下文至少 64K，0.6B 这种小模型连门槛都达不到。

```d2
direction: down
client: 客户端 {
  cli: "ollama run\n（TUI）"
  app: 桌面 App
  curl: "curl /\nOpenAI SDK"
  cc: "Claude Code\n（Anthropic\nMessages 格式）"
}
ollama: "ollama serve :11434" {
  label.near: bottom-left
  api1: "/v1/chat/completions\nOpenAI 兼容"
  api2: Anthropic 兼容端点
  eng: "llama.cpp 推理\ntokenize → 前向 → 采样 → KV cache"
  api1 -> eng
  api2 -> eng
}
w: "~/.ollama/models\nmanifest + blobs (GGUF)" {shape: cylinder}
reg: "ollama.com 模型库\n/ hf.co/..."
client.cli -> ollama.api1
client.app -> ollama.api1
client.curl -> ollama.api1
client.cc -> ollama.api2: "ANTHROPIC_BASE_URL\n指向本机"
ollama.eng -> w
reg -> w: ollama pull
```

**运行内存怎么估算**。以 qwen3-0.6B 为例，它有 28 层、8 个 KV 头、head_dim 128，按 fp16 存储：

```
每 token KV = 2(K和V) × 28 层 × 8 头 × 128 × 2 byte ≈ 112 KB
32768 token × 112 KB ≈ 3.7 GB   ← 和原文 ollama ps 的 4.4GB 对得上（再加 ~0.5GB 权重）
```

这里的结构参数（层数、KV 头数、head_dim）是我按 Qwen3-0.6B 公开的 config 算的，不是原文给的数字。

### 📝 作者是怎么讲的

- **用上一篇收尾，引出这一篇的问题。** 开头一句话复述上一篇的推理链路，然后转问：那篇讲模型内部发生了什么，这篇讲「谁来执行这些计算」。为什么有效：系列文章之间形成问题链，读者知道这篇在整张图里补的是哪一块。借用：写系列文档时，每篇开头用一句「上回解决了 X，还剩 Y」接上。
- **用生活类比讲清两个东西缺一不可。** 播放器和视频文件对应 Ollama 和模型文件；名字加标签、pull / list / rm、manifest 加 blob，对应 Docker。为什么有效：读者已经熟悉 Docker，整套操作直接迁移过来。注意类比的局限：Docker 镜像拿来就能跑，模型还受内存和上下文长度限制，作者后面专门讲了运行时占用，算是补上了这个不成立的地方。
- **先跑起来看效果，再拆概念。** 安装、pull、对话、curl 调接口，每一步都贴本机实测输出，然后才解释思考模式标记、`stream` 和 `reasoning_effort` 字段、SIZE 与 CONTEXT 的含义。为什么有效：读者先看到真实效果，后面的解释才有对象。这正是 STYLE.md 第 5 条「先跑起来再拆」的样板。
- **用反直觉的数字制造疑问，再用前文的公式解答。** 磁盘上 522MB 的模型，运行时占 4.4GB，作者回扣上一篇算过的 KV cache 约 3.7GB，把差额拆清楚。为什么有效：数字对不上本身就是钩子，解答又顺便复习了旧知识。借用：讲性能或成本时，先摆一个对不上的数字，再拆账。
- **主动泼冷水，给出明确观点和理由。** 接 Claude Code 只是接口通了，0.6B 模型连官方建议的 64K 上下文门槛都不够，结论是笔记本上的本地模型「很难驾驭」Coding Agent。为什么有效：读者不会白折腾，而且理由是可验证的数字，不是凭感觉。
- **用对照说清本质差别。** 本地 API 和云端 API 字段一模一样，作者点明真正的差别在「推理跑在谁的机器上」。这其实是一句「说穿了」：接口是同一套，只是换了算力的提供方。

## ⚠️ 勘误 / 补充

- **本机没有装 Ollama**（`which ollama` 没有输出），所以原文的命令和输出这里都没有复现，只核对了数值是否自洽：522MB × 8 / 751.63M ≈ 5.56 bit/参数，和原文说的「约 5.6 bit」一致；KV cache 的估算见上面。
- **补充一条原文没展开的「上下文换内存」规律**：KV cache 和上下文长度成线性关系。把运行时的上下文开到模型支持的上限 40960，KV cache 会涨到约 4.6GB。所以本地跑 Agent 时，即使模型本身支持 128K，笔记本的内存也往往撑不住。

## 回到主线

这章把「预测下一个 token」从 API 后面拉到了你自己的机器上，于是能直接看到**上下文的物理成本**：每多一个 token 就多一份 KV cache，占的是实实在在的内存。云端 API 按 token 计费，本地则是按内存「付费」，本质是一回事。这也说明了为什么 Agent 要做 [上下文压缩](../p3-agent-internals/05-context-compaction.md) 和 [Sub Agent](./10-sub-agent.md)：上下文窗口不是免费的，越长越贵，越长越慢。

## 对照你的环境

- **你已经在用「换后端」这一套**：`~/.claude/settings.json` 的 `env` 里配了 `CLAUDE_CODE_USE_VERTEX` 等 Vertex 相关的变量，Claude Code 的请求走的是 Vertex 这条后端（具体值不在这里抄）。接 Ollama 是同一个机制，换成 `ANTHROPIC_BASE_URL` 指向 `http://localhost:11434` 即可。实测前先用 `claude --safe-mode` 或者单独的 settings 文件试，别直接改你的主配置。
- **Codex 也一样**：`~/.codex/config.toml` 里的 `[model_providers.llm_proxy]` 就是一个自定义 provider。想加一个本地 provider，再加一节 `[model_providers.ollama]` 并把 `base_url` 设成 `http://localhost:11434/v1` 就行。加的时候要注意 [会话按 provider 过滤](./07-session-storage.md) 那个坑。
- **在你这里最实际的用途**：Ollama 不适合当 Coding Agent 的主力模型，但很适合做**离线 fake 的升级版**。在 `code/agent` 里跑 Agent loop 的集成测试时，可以拿本地小模型代替 fake client，把真实的 tool_use 往返跑通，又不触碰「不主动调用 Anthropic」这条限制。

## 自测题

1. `ollama show` 显示 parameters 是 751.63M，`ollama list` 显示 522MB，`ollama ps` 显示 4.4GB。这三个数分别是什么？
2. 你的 Python 代码用 OpenAI SDK 调 DeepSeek，要改成调本地的 qwen3，最少改哪几处？
3. 为什么说「Claude Code 接上 Ollama」不等于在本地运行 Claude？如果要选一个本地模型给 Claude Code 用，最先要卡的两个条件是什么？

<details><summary>参考答案</summary>

1. 751.63M 是参数个数；522MB 是量化后（Q4_K_M）模型文件在磁盘上的大小；4.4GB 是运行时的内存占用，包括权重、按 32K 上下文分配的 KV cache 和临时计算缓冲。
2. 三处：`base_url` 改成 `http://localhost:11434/v1`，`api_key` 随便填一个非空字符串，`model` 改成 `qwen3:0.6b`。请求和响应的结构不用改。
3. Claude Code 只是一个按 Anthropic Messages 协议发请求的客户端，对面是谁它不关心，接上 Ollama 后跑的是你选的本地模型。最先要卡的两个条件：一是支持工具调用（在 Ollama 模型库里有 Tools 标签），二是上下文足够长（Ollama 建议至少 64K），而且你的内存要能撑住这么长上下文的 KV cache。

</details>

## 相关章节

- [LLM 是怎么预测下一个 token 的](../p0-core/04-llm-token-prediction.md)：KV cache 和采样参数的来历
- [如何调用 LLM 接口](../p0-core/02-api-and-apikey.md)：同一套 JSON 发给云端
- [看懂 Hugging Face 和模型文件](./14-hugging-face-model-files.md)：GGUF、Q4_K_M 是什么
- [安装使用 Claude Code](./02-install-and-use.md) · [安装使用 Codex](./03-install-and-use.md)
- [动手跑通 LLM 推理的全流程](../p6-nn-llm/05-inference-process.md)
