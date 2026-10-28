# 动手跑通 LLM 推理的全流程

> 对应原站：[动手跑通 LLM 推理的全流程](https://labuladong.online/zh/ai-coding/llm/inference-process/)（会员内容；本章为独立原创重写）

> **一句话结论**：LLM 推理就是一个循环——把文字变成 token，前向算出「下一个 token 的分数」，按温度 / top-k / top-p 抽一个，接到末尾再来一遍；KV cache 让每一轮只算新来的那一个 token。我们手写的循环和 `model.generate` 逐 token 完全一致，连随机采样都能对齐。

你每天都在用 Claude Code，可能也算过账：同一个会话里，第二轮请求的 `cache_read_input_tokens` 为什么会是前一轮的全部输入？「缓存」缓存的到底是什么？

还有一个更常见的疑问：同一个 prompt 发两次，Claude 为什么给出不一样的回答？

这两个问题的答案都藏在推理程序的最后几十行里。这一章我们不启动 Ollama、不调 API，直接在 Python 进程里加载一个小模型，把从「一句话」到「一段回答」的每一步都亲手写一遍。

## 先跑起来看看

模型选的是 `HuggingFaceTB/SmolLM2-135M-Instruct`：Llama 架构，1.35 亿参数，权重文件 `model.safetensors` 269 MB（下载前用 `HfApi().model_info(..., files_metadata=True)` 查过体积）。它足够小，在笔记本 CPU 上推理几乎是实时的；又足够完整，有 chat template、GQA、RoPE，和大模型的结构一模一样。

首次运行会下载约 270 MB。Hugging Face 默认缓存在 `~/.cache/huggingface`，本项目用 `llm/hf_env.py` 把 `HF_HOME` 固定到了 `code/ml/llm/.hf-cache/`（写这章时全局缓存被清理过一次，固定到项目内更可复现）。下载完之后加 `HF_HUB_OFFLINE=1` 就完全离线了：

```text
❯ cd code/ml && HF_HUB_OFFLINE=1 uv run python llm/infer.py
[0] 模型 HuggingFaceTB/SmolLM2-135M-Instruct: 134,515,008 参数, 30 层, hidden=576, heads=9 (kv_heads=3), vocab=49152

[1] chat template 展开后的字符串：
'<|im_start|>system\nYou are a helpful AI assistant named SmolLM, trained by Hugging Face<|im_end|>\n<|im_start|>user\nWhat is the capital of France?<|im_end|>\n<|im_start|>assistant\n'

[2] tokenize：37 个 token
    前 12 个: [(1, '<|im_start|>'), (9690, 'system'), (198, 'Ċ'), (2683, 'You'), (359, 'Ġare'), (253, 'Ġa'), (5356, 'Ġhelpful'), (5646, 'ĠAI'), (11173, 'Ġassistant'), (3365, 'Ġnamed'), (3511, 'ĠSm'), (308, 'ol')]

[3] forward：logits.shape = (1, 37, 49152)  (batch, seq_len, vocab)
    最后一个位置的 top-5 下一个 token：
             'The'  id=504    p=0.8312
           'Paris'  id=38634  p=0.0415
              'As'  id=1653   p=0.0183
             'Bon'  id=30904  p=0.0155
               'I'  id=57     p=0.0140

[4] 温度如何改变分布（最后一个位置，top-1 概率 / 有效候选数 exp(熵)）：
    T=0.3  top1_p=0.9999  有效候选数≈    1.00
    T=0.7  top1_p=0.9697  有效候选数≈    1.22
    T=1.0  top1_p=0.8312  有效候选数≈    2.82
    T=1.5  top1_p=0.3811  有效候选数≈   70.99

[5] greedy 解码，三种实现对比：
    无 cache    : 0.22s  'The capital of France is Paris.'
    有 KV cache : 0.11s  'The capital of France is Paris.'
    model.generate 一致: no_cache=True  kv_cache=True
    KV cache 最终长度=44，每层 key 形状=(1, 3, 44, 64) (batch, kv_heads, seq, head_dim)，总大小=1980 KiB

[5b] 生成更长时 KV cache 的收益（忽略 EOS，强制生成 N 个 token）：
    N=50   无 cache   1.98s   有 cache  0.47s   加速  4.2x
    N=100  无 cache   4.48s   有 cache  0.89s   加速  5.0x
    N=200  无 cache  10.93s   有 cache  1.86s   加速  5.9x

[6] 采样：temperature=0.8, top_k=50, top_p=0.9，同一种子 vs model.generate：
    seed=1 一致=True  'The capital of France is Paris. It is a city known for its rich history, cultural landmarks, and historical significance. Paris is often referred to as'
    seed=2 一致=True  'The capital of France is Paris. Paris is a city located in Western Europe, known for its historical landmarks, culture, and the famous landmarks of the'
    seed=3 一致=True  'The capital of France is Paris.'

[6b] 前缀复用（prompt caching 的本地版）：长 system prompt 只 prefill 一次
    前缀 486 token，prefill 一次 0.118s
    'How do I export a note?'    全量 502 tok 0.120s | 复用前缀只算 16 tok 0.027s | max|Δlogits|=3.91e-05
    'Why did my sync fail?'      全量 501 tok 0.122s | 复用前缀只算 15 tok 0.024s | max|Δlogits|=5.05e-05

[7] 拼成 OpenAI 格式的响应：
{
  "id": "chatcmpl-0368fb3b",
  "object": "chat.completion",
  "model": "HuggingFaceTB/SmolLM2-135M-Instruct",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The capital of France is Paris."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 37,
    "completion_tokens": 8,
    "total_tokens": 45
  }
}
```

（Apple M4 Pro，CPU，fp32。计时每次运行略有波动。）

一共 8 段输出，对应推理的 8 个环节。下面按顺序拆。

## 从一句话到一串数字

### chat template：对话其实是一段拼好的文本

我们传给模型的是 `[{"role": "user", "content": "What is the capital of France?"}]`，但模型只认识一条 token 序列，不认识 JSON。

`tok.apply_chat_template` 按模型仓库里 `tokenizer_config.json` 自带的模板，把消息数组拼成一段带特殊标记的字符串（第 [1] 段）。几个细节：

- 我们没传 system 消息，模板**自动补了一条默认的**「You are a helpful AI assistant named SmolLM...」。
- `<|im_start|>` / `<|im_end|>` 是角色边界。
- 结尾的 `<|im_start|>assistant\n` 是 `add_generation_prompt=True` 加的：它把「轮到助手说话了」写进了上下文，模型接下来预测的就是助手的第一个字。

你可能会问：那 Claude 的 `messages` 数组也是这样被拼起来的吗？

几乎可以肯定是类似的机制，但 Anthropic 没有公开 Claude 的模板格式（这里是推测，依据是所有开源对话模型都这么做，而模型本身只能处理一条 token 序列）。这也是 [给 Claude Code 发一句 Hi 会发生什么](../p3-agent-internals/02-hi-request.md) 里看到的那一大坨 system prompt、tools 定义最终的去处：**全部被拼成一条长序列，排在你那句 Hi 前面**。

### tokenize：文字变成整数

第 [2] 段：37 个 token。`Ġ` 是这个 BPE 分词器表示「前面有个空格」的方式，`Ċ` 是换行。`SmolLM` 被切成了 `ĠSm` + `ol` + ...，因为词表里没有这个词。

每个 token 就是词表里的一个下标，词表大小 49152。这就是 [上下文是什么？token 怎么计费？](../p0-core/03-messages-and-tokens.md) 里说的计费单位：**你为每个下标付钱**。

### forward：一次前向，每个位置都给出一张「下一个词」的分数表

```python
logits = model(input_ids).logits   # (1, 37, 49152)
```

形状是 `(batch, 序列长度, 词表大小)`。也就是说，模型对 **37 个位置中的每一个** 都输出了 49152 个分数，表示「如果下一个 token 是词表里的第 i 个，有多合理」。这些分数叫 logits，softmax 一下就是概率。

推理时我们只关心最后一个位置（第 37 个，也就是 `assistant\n` 之后），它预测的是回答的第一个 token。第 [3] 段：`The` 占 83%，`Paris` 只有 4%——模型更喜欢先说「The capital of France is...」而不是直接蹦出答案。

你可能会问：前面 36 个位置的分数算出来有什么用？

推理时确实用不上，白算了（下面的 KV cache 会解决「白算」的问题）。但训练时它们全都有用：每个位置都在预测自己的下一个 token，一条长度 37 的序列一次提供 36 个训练信号。这就是 [LLM 是怎么预测下一个 token 的](../p0-core/04-llm-token-prediction.md) 讲的 next-token prediction，第 6 章 LoRA 的 loss 就是这么算的。

## 从分数到一个 token：采样

拿到 49152 个分数，怎么决定输出哪个？`llm/sampling.py` 实现了四个纯函数。

**greedy**：直接取最大的。`logits.argmax(-1)`。确定、可复现，但容易陷入重复。

**temperature（温度）**：采样前把 logits 除以 $T$：

```python
def apply_temperature(logits, temperature):
    return logits / temperature
```

就这一行。$T<1$ 把分数之间的差距放大，分布变尖；$T>1$ 把差距缩小，分布变平。第 [4] 段量化了这件事：同一个位置，$T=0.3$ 时 `The` 的概率是 99.99%，有效候选数（$e^{\text{熵}}$）是 1；$T=1.5$ 时 `The` 只剩 38%，有效候选数涨到 71 个。

打个比方：温度像考试时的「自信程度」。$T$ 低，就是只写你最有把握的那个答案；$T$ 高，就是连只有三成把握的答案也愿意写上去碰运气。这个比方不成立的地方是，人的自信是对答案正确性的判断，而温度只是一个机械的缩放，不会让模型知道得更多或更少——它不改变排序，只改变排名靠后的选项有多大机会被抽中。

**top-k**：只保留分数最高的 k 个，其余设为 $-\infty$（softmax 后概率为 0）。

**top-p（nucleus 采样）**：按概率从高到低累加，保留累计概率刚好达到 p 的最小集合。和 top-k 的区别是候选数量随分布自适应：模型很确定时可能只留 1 个，很犹豫时可能留几百个。

```python
def sample_next(logits, temperature=1.0, top_k=0, top_p=1.0, generator=None):
    logits = apply_temperature(logits, temperature)
    logits = apply_top_k(logits, top_k)
    logits = apply_top_p(logits, top_p)
    probs = logits.softmax(dim=-1)
    return torch.multinomial(probs, num_samples=1, generator=generator).squeeze(-1)
```

顺序是 temperature → top-k → top-p → softmax → 抽签，和 transformers 的 `generate` 一致。`apply_top_p` 的实现也特意照着 transformers 的 `TopPLogitsWarper` 写（升序排序、去掉累计 ≤ $1-p$ 的尾部），`test_matches_transformers_logits_processors` 验证两者在 4×1000 的随机 logits 上保留的 token 集合完全相同。

正因为每一步都对齐了，第 [6] 段才能做到：**同一个随机种子下，我们的手写循环和 `model.generate(do_sample=True, ...)` 抽出了逐 token 相同的结果**。三个种子三段不同的回答，每段都完全一致。

这就回答了开头第二个问题：同一个 prompt 结果不同，是因为每一步都在掷骰子。种子不同，第一个分叉点抽到了不同的 token，后面的整段话就走向了不同的路。seed=3 那次在 `Paris.` 后面抽中了结束符，回答就只有一句。

## 循环与 KV cache

现在把上面的步骤串成循环。最朴素的写法（`generate_no_cache`）：

```python
for _ in range(max_new_tokens):
    logits = model(ids, use_cache=False).logits[:, -1, :]
    nxt = greedy_next(logits)
    ids = torch.cat([ids, nxt[:, None]], dim=1)
    if nxt.item() == eos_id:
        break
```

每一步都把**到目前为止的全部 token** 重新喂给模型。第 100 步要处理 100+ 个 token，可它们中的前 99+ 个和上一步一模一样。

你可能会问：既然一样，能不能把上一步的结果存下来？

能存的就是 KV cache。Transformer 每一层的注意力，要为每个 token 算出 key 和 value 两个向量；一个 token 的 K、V 只取决于它自己和它前面的 token，**后面来了新 token 也不会变**。所以算过一次就可以存起来，下一步新 token 只需要用自己的 query 去和所有历史的 K、V 做注意力。

```d2
shape: sequence_diagram
u: 调用方
m: 模型（30 层）
c: KV cache
u -> m: "prefill：一次喂入 prompt 的 37 个 token"
m -> c: 写入 37 个位置的 K、V（每层一份）
m -> u: "最后位置的 logits → 采样得 token₁" {style.stroke-dash: 3}
"loop：decode：每步只喂 1 个 token": {
  u -> m: token_t
  c -> m: 读出历史 K、V {style.stroke-dash: 3}
  m -> c: 追加 token_t 的 K、V
  m -> u: "logits → 采样得 token_{t+1}" {style.stroke-dash: 3}
}
u."遇到 <|im_end|>（eos）或达到 max_new_tokens 时停止"
```

图注：推理分两个阶段。prefill 一次性并行处理整个 prompt，算力密集；decode 每步只处理一个新 token，但要读取全部历史 K、V，访存密集。这也是 API 计费里「输入 token 便宜、输出 token 贵」的直觉来源之一：输出的每个 token 都要单独走一遍 30 层。

对应代码（`generate_with_cache`）：

```python
out = model(input_ids, use_cache=True)              # ① prefill
cache = out.past_key_values
nxt = sampler(out.logits[:, -1, :])
for _ in range(max_new_tokens - 1):
    if nxt.item() == eos_id:
        break
    out = model(nxt[:, None], past_key_values=cache, use_cache=True)  # ② decode：只喂一个 token
    cache = out.past_key_values
    nxt = sampler(out.logits[:, -1, :])
```

第 [5] 段验证了三种实现（无 cache、有 cache、`model.generate`）的 greedy 输出逐 token 相同。第 [5b] 段是收益：生成 200 个 token，无 cache 10.9 秒，有 cache 1.9 秒，快 5.9 倍，而且生成越长差距越大——无 cache 的总计算量随长度平方增长，有 cache 是线性的。

KV cache 的代价是内存。第 [5] 段：44 个 token 的 cache 占 1980 KiB，算一下就是 30 层 × (K+V) × 3 个 kv 头 × 64 维 × 4 字节 = 每个 token 45 KiB。这个模型用了 GQA（grouped-query attention）：9 个 query 头共享 3 组 K、V，cache 直接省了三分之二。上下文窗口做到 1M token 的模型，KV cache 是服务端最主要的显存开销之一。

### 前缀复用：本地版的 prompt caching

KV cache 只在一次生成内复用。再进一步：如果**很多请求共享同一个开头**呢？

第 [6b] 段做了这个实验。一个 486 token 的长 system prompt，先单独 prefill 一次，把 cache 存下来；之后每个不同的用户问题，复制一份前缀 cache，只算后面的 15、16 个 token：

```python
pcache = prefill_prefix(model, prefix_ids)                 # 只做一次
got = continue_from_prefix(model, pcache, suffix_ids)      # 每个问题只算后缀
```

0.12 秒变成 0.025 秒。`test_prefix_cache_reuse_gives_same_logits` 验证复用前缀得到的 logits 和全量计算一致，argmax 相同。

注意 `max|Δlogits|=3.91e-05`，不是 0。两条计算路径（一次算 502 个 token vs 先 486 再 16）走了不同的矩阵分块，浮点舍入顺序不同。这个误差在这里无害，但它说明了一件事：**即使温度为 0，换一种批处理方式也可能让两个分数非常接近的候选交换名次**。

最后第 [7] 段，推理程序自己把结果拼成 OpenAI 格式的 JSON：`finish_reason` 根据最后一个 token 是不是 eos 判断，`usage` 就是数了数两段 token 的长度。你平时调 API 拿到的那份 JSON，就是这么来的。

上面每一个「一致=True」都有对应的测试（`llm/test_sampling.py` 7 条、`llm/test_infer.py` 6 条）：采样函数与 transformers 的 logits processor 对齐、温度下的经验分布符合理论值、三种 greedy 循环与 `generate` 一致、同种子采样一致、KV cache 每步恰好 +1、前缀复用 logits 一致且原 cache 未被污染、OpenAI JSON 的 usage 计数正确：

```text
❯ uv run pytest -q llm/test_sampling.py llm/test_infer.py
.............                                                            [100%]
13 passed in 3.34s
```

`test_infer.py` 需要本地已有模型缓存，没有时自动 skip，测试里不会联网。

**回到主线**：这一章就是主线本身——「根据已有 token 预测下一个 token」被写成了一个 for 循环。KV cache 和前缀复用解决的是**同一段上下文不要重复算**：它们不改变模型看到什么，只省掉重复劳动。而采样参数决定的是「概率分布 → 一个确定的 token」这最后一步，那是所有随机性的来源。

## 对照你的环境

**KV cache ↔ prompt caching 的计费**。翻一下你本机的会话记录 `~/.claude/projects/-Users-me-work-webapp/<session-id>.jsonl`，前几轮 `usage` 是这样的：

```text
"input_tokens":2,"cache_creation_input_tokens":78033,"cache_read_input_tokens":0
"input_tokens":2,"cache_creation_input_tokens":733,"cache_read_input_tokens":78033
"input_tokens":2,"cache_creation_input_tokens":3056,"cache_read_input_tokens":78766
"input_tokens":2,"cache_creation_input_tokens":1048,"cache_read_input_tokens":81822
```

第一轮写入 78033 个 token 的前缀；之后每一轮都**读**回上一轮的全部前缀，只**写**新增的那一截（733、3056……）。这和第 [6b] 段的 `prefill_prefix` + `continue_from_prefix` 是同一个形状。

按 `claude-api` skill 里的计费规则：缓存写入是基础输入价的 1.25 倍（5 分钟 TTL）或 2 倍（1 小时 TTL），读取约 0.1 倍，Opus 5.5 上是 0.05 倍（$0.20/MTok）；Opus 5.5 / Sonnet 5.5 的最小可缓存前缀是 512 token。Anthropic 没有公开服务端缓存的具体内部结构，但从它的行为——**严格前缀匹配**、前缀任何一个字节变了后面全部失效——看，缓存的就是前缀算过一遍之后的中间状态，和我们本地复用 KV cache 是一回事（这是推测，依据是行为一致）。

这对你的配置有直接含义：渲染顺序是 tools → system → messages，`CLAUDE.md`、skill 列表、`inject-guardrails.sh` 通过 SessionStart 注入的护栏，都出现在会话很靠前的位置（具体落在 system 还是第一条 message 里，可以用 [抓包工具](../p3-agent-internals/01-http-analyzer.md) 自己看），后面每一轮都是在它们之上追加。**它们只要每次都一模一样，就只在第一轮付 1.25 倍，之后都是一折甚至更低**；如果哪天你在注入内容里加了时间戳或随机 ID，每一轮都会从那里开始重新写缓存。

**采样温度 ↔ 为什么同一个 prompt 结果不同**。在 Claude Opus 5.5 上，`temperature` / `top_p` / `top_k` 这几个参数已经被移除，传了会返回 400；Sonnet 5.5 上传非默认值也是 400（来源：`claude-api` skill 的模型参数表）。也就是说，你在 Claude Code 里根本没有「把温度调成 0」这个选项，服务端按自己的默认设置做第 [6] 段那样的抽签。所以：

- 同一个 prompt 两次结果不同，是设计如此，不是 bug。
- 想让结果稳定，靠的不是温度，而是**把上下文写得更确定**：更具体的指令、结构化输出（`output_config.format`）、用 hook 和测试兜底。你 CLAUDE.md 里「完成前跑命令贴真实输出」这条铁律、你配的 Stop hook，本质上就是在承认「采样是随机的」之后加的外部校验。

## 常见坑

1. **忘了 `add_generation_prompt=True`**。不加的话 prompt 以 `<|im_end|>\n` 结尾，模型可能接着续写一轮 user 消息，而不是作为助手回答。
2. **批量推理时 padding 放错边**。生成时要左侧 padding（`tok.padding_side = "left"`），否则短句的「最后一个位置」是 pad token，预测全乱。第 6 章的 `evaluate` 函数专门设了这一行。
3. **复用前缀 cache 时没有复制**。`DynamicCache` 是可变对象，直接在原 cache 上接着算，它就被污染了，下一个问题会接在上一个问题后面。`continue_from_prefix` 用了 `copy.deepcopy`，测试里断言了原 cache 长度不变。
4. **以为 temperature=0 就完全确定**。数学上 greedy 是确定的，但不同的批大小、不同的计算路径会带来 1e-5 量级的浮点差异（第 [6b] 段实测），候选分数接近时就可能翻转。
5. **前缀的分词边界**。前缀复用要求「全量 tokenize 结果的前 N 个」和「单独 tokenize 前缀」完全相同。BPE 在拼接处可能合并出不同的 token，代码里用 `assert torch.equal(full_ids[:, :n], prefix_ids)` 守住了这一点。

## 练习

1. 用 `sample_next` 对同一个 prompt 在 $T \in \{0.3, 0.7, 1.0, 1.5\}$ 下各生成 5 次，统计 5 次回答中有几种不同的文本。和第 [4] 段的「有效候选数」对照着看。
2. 改 `generate_with_cache`，让它在每一步打印 `cache.get_seq_length()` 和 `kv_cache_bytes(cache)`，画出「已生成 token 数 vs cache 字节数」的曲线，验证每个 token 45 KiB。
3. （开放）Claude Code 的一个会话里，主 agent 和它派出的 Sub Agent 能共享 prompt cache 吗？结合「严格前缀匹配」想一想：Sub Agent 的 system prompt、tools 列表和主 agent 相同吗？你可以用本机 `~/.claude/projects/` 下 subagent 的 jsonl 里 `cache_read_input_tokens` 的值来验证你的猜想。

## 延伸阅读

- Hugging Face 文本生成策略：<https://huggingface.co/docs/transformers/generation_strategies>
- KV cache 说明（transformers）：<https://huggingface.co/docs/transformers/kv_cache>
- Anthropic prompt caching 文档：<https://docs.claude.com/en/docs/build-with-claude/prompt-caching>
- 模型卡：<https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct>
- 本章代码：`code/ml/llm/sampling.py`、`code/ml/llm/infer.py`，测试 `code/ml/llm/test_sampling.py`、`code/ml/llm/test_infer.py`
- 相关章节：[用 Ollama 在本地运行大模型](../p1-tools/13-local-llm-ollama.md)、[看懂 Hugging Face 和模型文件](../p1-tools/14-hugging-face-model-files.md)
- 下一章 [动手用 LoRA 微调模型](06-lora-fine-tuning.md)：这一章只读了权重，下一章改它
