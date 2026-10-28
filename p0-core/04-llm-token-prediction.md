# LLM 是怎么预测下一个 token 的

> 对应原站：[LLM 是怎么预测下一个 token 的](https://labuladong.online/zh/ai-coding/basics/llm-token-prediction/)（免费文章，推荐配合阅读；本章为独立原创课文）

> **一句话结论**：模型把文本切成 token，再变成向量，用因果注意力让每个位置吸收前文，然后给整个词表打分、抽一个 token、拼回去，再来一轮。「前文 token 的 K/V 一旦算出就不会再变」这一条性质，同时解释了输出为什么比输入贵、KV cache 为什么省、Prompt Cache 为什么必须前缀一字不差。

## 价格表上的三个数字，背后是什么物理事实

上一章算账的时候，你可能注意到三个数字：

- `claude-opus-5-5` 输入 $4，输出 $20，**输出贵 5 倍**；
- 缓存读 $0.20，只有输入的 **1/20**；
- 缓存写入反而**比普通输入贵**（1.25× 或 2×）。

你可能会问：这些倍数是商业定价随手定的，还是有物理依据？

答案是有依据，而且都来自同一个机制。这一章先用 numpy 从零搭一个最小的「下一个 token 预测器」，再用一个单头注意力把 KV cache 的账算清楚。最后你会发现，这三个数字都能对上。

## 第一步：文字变成 token id

模型不认识字，只认识整数。**tokenizer**（分词器）负责把文本切成片段，每个片段在**词表**（vocabulary）里有一个编号。

主流模型用 **BPE**（Byte Pair Encoding，字节对编码）造词表。从单个字符（或字节）出发，统计语料里哪两个相邻片段一起出现得最多，就把它们合并成一个新片段，记下一条合并规则；然后用新片段继续统计、继续合并，直到词表达到预定大小。

切分新文本时，并不是拿词表去做字符串匹配。tokenizer 先把文本打散成字符，再按合并规则的**先后顺序**（越早学到的规则优先级越高）一条条往上套，直到没有规则可用。

你熟悉 TypeScript 的话，可以把它想成：拿着一张有优先级的 reduce 规则表，对字符数组反复折叠。

两个推论：

- **一个字算几个 token，看训练语料**。语料里常见的词会被合并成一个 token；少见的词会被拆成好几段。中文语料多的模型，一个汉字常常就是一个 token；中文语料少的模型，一个汉字可能占两三个。
- **不同模型的 token 数不能直接比**。连同一家的不同代模型都会换 tokenizer。按 `claude-api` skill 的记载，Haiku 5.5 的新 tokenizer 对同样的文本大约多数 30% 的 token；从 Opus 4.6 迁到 4.7 及以后，同样的文本约为原来的 1 到 1.35 倍。

我们的演示为了能手算，只用最简单的**字符级** tokenizer：一个字符就是一个 token。

## 第二步：给下一个 token 打分

有了 id，模型要回答的问题是：**下一个 id 是谁，各有多大可能？**

最朴素的回答方式是 **bigram**（二元模型）：只看前一个 token，数一数语料里它后面跟过谁、各跟过几次。把计数取对数当作分数（**logits**），用 **softmax** 归一化成概率，就得到了一个「下一个 token 预测器」。

真正的 LLM 做的是同一件事，只是「打分」这一步强大得多：它看的不只是前一个 token，而是前面所有 token。

做法分三步：

1. 每个 token id 先查 **embedding** 表，变成一个向量。
2. 再经过几十层 **因果注意力**（causal attention）。每个位置算出三个向量：Q（我在找什么）、K（我有什么特征）、V（我能提供什么内容）。用自己的 Q 去和自己及前文所有位置的 K 比对，按匹配程度加权汇总它们的 V。「因果」的意思是只能看前面，不能看后面。
3. 最后一个位置的向量和整个词表逐一算匹配分，得到 logits。

```d2
direction: down
t: 文本
tk: "tokenizer\n按合并规则切片"
ids: "token ids"
e: "embedding 查表\nid → 向量"
l: "N 层因果注意力 + FFN\n每个位置吸收前文"
kv: "KV cache\n前文每个位置的 K、V" {shape: cylinder}
lg: "最后位置 · 全词表\n→ logits"
sm: "÷ temperature → top-k / top-p\n→ softmax → 抽签"
t -> tk
tk -> ids
ids -> e
e -> l
kv <-> l
l -> lg
lg -> sm
sm -> ids: 新 token 拼回末尾
```

图注：右下那条回边就是**自回归**（autoregressive），生成一个，拼回去，再预测下一个。KV cache 挂在注意力层旁边，下面会讲它为什么能挂在那里。

## 第三步：从分数到选择

打完分，怎么选？

- **贪心**：永远选分最高的。稳定，但容易死板、复读。
- **采样**：按概率抽签。这里有两个旋钮：
  - **temperature**（温度）：softmax 之前把 logits 除以 T。T < 1 时高分的更突出，分布更尖；T > 1 时分差被抹平，冷门 token 更容易被抽中。T = 0 按惯例就是贪心。
  - **top-k / top-p**：先把长尾砍掉。top-k 只保留分数前 k 名；top-p 按概率从高到低累加，加到 p 为止。

打个比方，这就像 webapp 做 A/B 实验时按权重分桶：temperature 是把各桶权重的差距拉大或压平，top-k 是直接关掉排名靠后的几个桶。

类比不成立的地方在于：A/B 分桶每个用户只抽一次，而生成是一个 token 一个 token**连着抽**。前面一次抽歪了，后面就基于这个歪掉的前缀继续往下写。这也是 T 调高之后，模型会「越写越离谱」的原因。

## 第四步：prefill、decode 和 KV cache

现在回到价格表。

**prefill**（预填充）：你发过去的输入是现成的，所有位置可以拼成一个大矩阵一次算完。GPU 把权重从显存搬进计算单元一趟，就能服务成千上万个 token，算力吃得很满。

**decode**（解码）：输出只能一个一个生成，因为第 n 个 token 依赖第 n−1 个。每生成一个 token，都要把整套权重搬一趟，只为算这一个位置，GPU 大部分时间在等数据搬运。

用数据库打个比方：prefill 是一条批量 `INSERT` 写入一万行；decode 是一万条单行 `INSERT`，而且每一条都要先把整张权重表扫一遍。

这就是**输出比输入贵**的根源。

**KV cache** 是 decode 阶段的必备优化。关键是因果注意力的一条性质：一个位置的 K 和 V 只由它自己和它前面的 token 决定，后面来的 token 改变不了它。所以前文的 K/V 算一次就可以存起来，之后每一步只给新 token 算 Q/K/V，再拿新的 Q 去和缓存里的所有 K 比对。

你可能会问：为什么缓存 K 和 V，不缓存 Q？

因为 Q 只在「轮到这个位置去查询前文」的那一步用一次。而 K 和 V 会在之后每一步被新 token 反复查询，并且永远不变。

最后，**Prompt Cache = 跨请求保存的 KV cache**。前缀一字不差，K/V 就一模一样，可以直接复用，跳过前缀的 prefill。前缀中间改一个字，从那里往后的 K/V 全变，缓存作废。命中的部分把成本从「计算」换成了「存储 + 读取」，所以便宜；写入要占显存或内存、存得越久越贵，所以写入要加价，1 小时 TTL 比 5 分钟 TTL 更贵。

用前端的话说，KV cache 有点像列表渲染里的 `key + memo`：前面的 item 没变就不重新渲染，只渲染新 append 的那一个。

但它在一个关键地方和 memo 不同：memo 过的 item 之后完全不参与计算，而缓存的 K/V **每一步都要被新 token 读一遍**，参与注意力计算。所以说「命中缓存就不耗算力」并不准确。命中省掉的是前缀的 **prefill 投影计算**，decode 时对这些 K/V 做注意力的开销依然存在，只是小得多。长上下文吃内存，吃的也正是这些 K/V。

**回到主线**：这一章把主线的第一句话「根据已有 token 预测下一个 token」从口号变成了机制，也给后面所有的上下文工程找到了物理依据。上下文长度对应 KV cache 的内存，所以窗口有上限；输出比输入贵，对应 decode 是串行的，所以让模型「多看少说」在经济上是划算的；前缀必须稳定，对应因果注意力的性质，所以「只追加、不改前缀」不是代码风格偏好，而是 Transformer 结构决定的硬约束。

## 动手：用 numpy 走一遍

代码在 [`code/agent-node/core/next_token.ts`](../code/agent-node/core/next_token.ts)（Python 版 [`next_token.py`](../code/agent/core/next_token.py)）。Node 版不依赖 numpy，矩阵就是普通的二维数组。语料是 6 行自己编的 webapp 风格 commit message，小到可以手算。全部离线运行，不涉及任何模型 API。

=== "Node"

    ```text
    $ node core/next_token.ts
    词表大小 V=51（字符级），bigram 计数矩阵 (51, 51)，语料 146 个字符

    「修」后面出现过："复"×3
      T=0   topK=-     "复":1.000  "\n":0.000  " ":0.000   （其余 0.000）
      T=0.5 topK=-     "复":0.999  "\n":0.000  " ":0.000   （其余 0.001）
      T=1   topK=-     "复":0.858  "\n":0.003  " ":0.003   （其余 0.137）
      T=1.5 topK=-     "复":0.473  "\n":0.011  " ":0.011   （其余 0.506）
      T=1   topK=2     "复":0.997  "\n":0.003  " ":0.000   （其余 0.000）

    「录」后面出现过："列"×3  "页"×1
      T=0   topK=-     "列":1.000  "\n":0.000  " ":0.000   （其余 0.000）
      T=0.5 topK=-     "列":0.898  "页":0.101  "\n":0.000   （其余 0.000）
      T=1   topK=-     "列":0.667  "页":0.224  "\n":0.002   （其余 0.106）
      T=1.5 topK=-     "列":0.389  "页":0.188  "\n":0.009   （其余 0.415）
      T=1   topK=2     "列":0.749  "页":0.251  "\n":0.000   （其余 0.000）

    自回归生成（prompt="fix(webapp): "，每行一个随机种子）：
      T=0   topK=-    seed=1  fix(webapp): 修复导出进度条
      T=0   topK=-    seed=2  fix(webapp): 修复导出进度条
      T=0.7 topK=3    seed=1  fix(webapp): 拆分记录页按钮错位
      T=0.7 topK=3    seed=2  fix(webapp): 新增会员额度条
      T=1.5 topK=-    seed=1  fix(webapp): 拆
      T=1.5 topK=-    seed=2  fix(webapp): 新增会员额度提卡顿
    ```

=== "Python"

    ```text
    $ uv run python -m core.next_token
    词表大小 V=51（字符级），bigram 计数矩阵 (51, 51)，语料 146 个字符

    「修」后面出现过：'复'×3
      T=0   top_k=None  '复':1.000  '\n':0.000  '增':0.000   （其余 0.000）
      T=0.5 top_k=None  '复':0.999  '\n':0.000  '增':0.000   （其余 0.001）
      T=1.0 top_k=None  '复':0.858  '\n':0.003  '增':0.003   （其余 0.137）
      T=1.5 top_k=None  '复':0.473  '\n':0.011  '增':0.011   （其余 0.506）
      T=1.0 top_k=2     '复':0.997  '\n':0.003  '增':0.000   （其余 0.000）

    「录」后面出现过：'列'×3  '页'×1
      T=0   top_k=None  '列':1.000  '\n':0.000  '增':0.000   （其余 0.000）
      T=0.5 top_k=None  '列':0.898  '页':0.101  '\n':0.000   （其余 0.000）
      T=1.0 top_k=None  '列':0.667  '页':0.224  '\n':0.002   （其余 0.106）
      T=1.5 top_k=None  '列':0.389  '页':0.188  '\n':0.009   （其余 0.415）
      T=1.0 top_k=2     '列':0.749  '页':0.251  '\n':0.000   （其余 0.000）

    自回归生成（prompt='fix(webapp): '，每行一个随机种子）：
      T=0   top_k=None seed=1  fix(webapp): 修复导出进度条
      T=0   top_k=None seed=2  fix(webapp): 修复导出进度条
      T=0.7 top_k=3    seed=1  fix(webapp): 修复导出进度条
      T=0.7 top_k=3    seed=2  fix(webapp): 修复记录列表导出进度条
      T=1.5 top_k=None seed=1  fix(webapp): 拆闪i错位f卡导出(出进增记复度tfeb
      T=1.5 top_k=None seed=2  fix(webapp): 修复记eb会r(wfito增会员额度提r
    ```

几个现象，对着代码看：

- **logits 就是 `log(计数 + 0.01)`**。那个 0.01 是平滑项，让没见过的组合也有一点点概率。T=1.0 时「修」后面「其余」还占 0.137，就是 50 个没见过的字符各分到一点。T 越高，这部分长尾被放得越大。
- **top-k 先砍再归一化**。「录」在 T=1.0 时「列」只有 0.667；开了 top_k=2，只剩「列」「页」两个候选，重新归一化后变成 0.749 / 0.251。
- **T=0 换种子也一字不差**；T=0.7 加 top-k=3 能写出语料里没有的新组合，比如 Python 版的「修复记录列表导出进度条」，把两条 commit 拼成了一句，而且还算通顺；T=1.5 就开始乱码了。（Node 版用的是另一个随机数生成器，同一个 seed 抽到的是「拆分记录页按钮错位」「新增会员额度条」这类同样不在语料里的组合；概率表里并列的第三名也可能排成别的字。）
- **Node 版那句「拆分记录页按钮错位」暴露了 bigram 的根本缺陷**：它只看前一个字。「录」后面接「页」是合法的（来自「登录页」），但它不知道再往前是「记」，于是把「记录列表」和「登录页按钮」拼成了半通不通的句子。真正的模型用注意力看全部前文，正是为了解决这个问题。

接下来是 KV cache。`TinyAttention` 是一层单头、随机权重的因果注意力，只为对比计算量。同一段 prompt，分别用「不缓存（每步把整段重新投影成 K/V）」和「缓存（只投影新 token）」各生成一遍，并统计 K/V 投影的乘加次数：

=== "Node"

    ```ts
    generate(ids: number[], n: number, useCache: boolean): number[] {
      ids = [...ids];
      let K: Mat | null = null;
      let V: Mat | null = null;
      for (let step = 0; step < n; step++) {
        if (!useCache || K === null) {
          const x = ids.map((i) => this.emb[i]); // 不用缓存：每步把整段重新投影一遍
          [K, V] = this.kv(x); //                    用缓存时，这里只在第一步执行 = prefill
        } else {
          const xNew = [this.emb[ids.at(-1)!]]; //   用缓存：只投影新来的那个 token = decode
          const [k, v] = this.kv(xNew);
          [K, V] = [[...K, ...k], [...V!, ...v]];
        }
        const q = vecmat(this.emb[ids.at(-1)!], this.Wq);
        ids.push(argmax(this.logitsLast(q, K, V!)));
        if (!useCache) K = V = null;
      }
      return ids;
    }
    ```

=== "Python"

    ```python
    def generate(self, ids: list[int], n: int, use_cache: bool) -> list[int]:
        ids = list(ids)
        K = V = None
        for step in range(n):
            if not use_cache or K is None:
                x = self.emb[ids]                 # 不用缓存：每步把整段重新投影一遍
                K, V = self._kv(x)                # 用缓存时，这里只在第一步执行 = prefill
            else:
                x_new = self.emb[ids[-1:]]        # 用缓存：只投影新来的那个 token = decode
                k, v = self._kv(x_new)
                K, V = np.vstack([K, k]), np.vstack([V, v])
            q = self.emb[ids[-1]] @ self.Wq
            ids.append(int(np.argmax(self._logits_last(q, K, V))))
            if not use_cache:
                K = V = None
        return ids
    ```

跑出来的结果：

=== "Node"

    ```text
    TinyAttention(d=32)：prompt 40 个 token，生成 20 个
      两种方式生成的 token 完全一致：true
      K/V 投影乘加次数：不用缓存 2,027,520  用缓存 120,832（实测计数）
      与解析式一致：true

    同一次请求内（KV cache）：d=4096，生成 200 个 token，K/V 投影乘加次数
      P=  1,000  无缓存 7.38e+12 ████████████████████████████████████████
                 有缓存 4.02e+10 █  省 183 倍
      P= 10,000  无缓存 6.78e+13 ████████████████████████████████████████
                 有缓存 3.42e+11 █  省 198 倍
      P=100,000  无缓存 6.72e+14 ████████████████████████████████████████
                 有缓存 3.36e+12 █  省 200 倍

    跨请求（Prompt Cache）：第 2 轮请求复用前缀 P，只追加 Δ=2,000 个新 token，prefill 要投影的位置数
      前缀 P= 10,000  不命中   12,000 ████████████████████████████████████████
                       命中      2,000 ███████  只算 16.7%
      前缀 P=100,000  不命中  102,000 ████████████████████████████████████████
                       命中      2,000 █  只算 2.0%
      前缀 P=500,000  不命中  502,000 ████████████████████████████████████████
                       命中      2,000 █  只算 0.4%
    ```

=== "Python"

    ```text
    TinyAttention(d=32)：prompt 40 个 token，生成 20 个
      两种方式生成的 token 完全一致：True
      K/V 投影乘加次数：不用缓存 2,027,520  用缓存 120,832（实测计数）
      与解析式一致：True

    同一次请求内（KV cache）：d=4096，生成 200 个 token，K/V 投影乘加次数
      P=  1,000  无缓存 7.38e+12 ████████████████████████████████████████
                 有缓存 4.02e+10 █  省 183 倍
      P= 10,000  无缓存 6.78e+13 ████████████████████████████████████████
                 有缓存 3.42e+11 █  省 198 倍
      P=100,000  无缓存 6.72e+14 ████████████████████████████████████████
                 有缓存 3.36e+12 █  省 200 倍

    跨请求（Prompt Cache）：第 2 轮请求复用前缀 P，只追加 Δ=2,000 个新 token，prefill 要投影的位置数
      前缀 P= 10,000  不命中   12,000 ████████████████████████████████████████
                       命中      2,000 ███████  只算 16.7%
      前缀 P=100,000  不命中  102,000 ████████████████████████████████████████
                       命中      2,000 █  只算 2.0%
      前缀 P=500,000  不命中  502,000 ████████████████████████████████████████
                       命中      2,000 █  只算 0.4%
    ```

（d=4096 那两张表用的是和小模型同一个解析式 `kvMacs()`（Python 版 `kv_macs()`）。小模型那组数字既有实测计数，也用解析式核对过，两者一致。）

读这两张图：

- **两种方式输出完全一致**。KV cache 是纯粹的计算优化，不改变结果，测试里也断言了这一点。
- **同一次请求内，KV cache 省下的倍数约等于生成的 token 数**（200 个 token 就省约 200 倍）。不缓存时，第 i 步要重算 P+i 个位置；缓存时只算 1 个。
- **跨请求时，Prompt Cache 省下的是整段前缀**。前缀越长，命中省得越多，到 50 万 token 时只需要算 0.4%。上一章那个平均 46.8 万 token 的会话，就落在这张图的最后一行附近。

这里只统计了 K/V 投影这一项。新 token 的 Q 和缓存里所有 K 做点积的那部分，开销随前缀长度线性增长，缓存省不掉它。这正对应上面说的「命中不等于不耗算力」。

## 对照你的环境

- **「新会话第一句慢，后面快」**。首轮的系统提示、工具描述、CLAUDE.md 和 SessionStart 注入的护栏要做完整的 prefill 并写入缓存；之后每轮只 prefill 新追加的部分，首字就快了。上一章统计出的 98.9% 命中率，就是这套机制在账单上的样子。
- **`/compact` 的隐藏成本**。压缩把历史的前半段换成摘要，替换点之后的 K/V 全部失效，下一轮要重新 prefill 并写入缓存。省了窗口，但付了一次「缓存重建」的钱。
- **Claude 上调不了 temperature**。很多教程说「写代码把温度设成 0」，这在开源模型和本地推理上成立。但按 `claude-api` skill 的记载，`claude-opus-5-5` 传 `temperature` / `top_p` / `top_k` 会返回 400，Sonnet 5.5 和 Haiku 5.5 只接受默认值。在 Claude 上控制「稳不稳」的手段，换成了 effort 和提示词本身。
- **想看真实模型的这些数字**。后面 [看懂 Hugging Face 和模型文件](../p1-tools/14-hugging-face-model-files.md) 会下载 Qwen3-0.6B，到时可以打开它的 `config.json` 核对：词表 151,936、隐藏维度 1,024、28 层、8 组 KV 头（GQA，分组查询注意力）、每个头 128 维。按这些数字算，每个 token 的 KV cache 是 2（K 和 V）× 28 × 8 × 128 = 57,344 个数，按 2 字节存约 115 KB；32K 上下文约 3.76×10⁹ 字节（约 3.5 GiB）。这些参数目前来自公开资料，下载后以 `config.json` 为准。

## 常见坑

1. **以为模型「一次想好整句再输出」**。它是一个 token 一个 token 串行生成的，前面抽歪了，后面就跟着歪。
2. **跨模型比 token 数**。tokenizer 不同，同一段文本的 token 数可能差三成。
3. **以为 temperature=0 就绝对确定**。它在定义上是贪心，但服务端的浮点运算和批处理顺序仍可能带来细微差异。在 Claude 上，这个参数干脆不让传。
4. **以为缓存命中就免费**。它省掉的是前缀的 prefill；decode 时对缓存的 K/V 做注意力的开销还在，也照样计费（按命中价）。
5. **把 KV cache 和 Prompt Cache 当成两种东西**。后者就是前者跨请求的持久化版本。

## 练习

**1.** 从 GPU 的角度解释：同样 1000 个 token，为什么输出比输入贵？

<details>
<summary>参考答案</summary>

输入在 prefill 阶段是现成的，1000 个位置可以拼成一个大矩阵一次算完，搬一趟权重就服务了 1000 个 token，算力利用率高。输出在 decode 阶段只能一个一个生成，每生成一个 token 都要把整套权重从显存搬进计算单元一趟，GPU 大部分时间在等搬运。同样的 token 数，decode 占用 GPU 的时间远多于 prefill，所以单价更高。

</details>

**2.** Agent 在第 20 轮改了 system prompt 里的一行规则，会发生什么？如果改的是第 19 轮某个 `tool_result` 里的一个字呢？

<details>
<summary>参考答案</summary>

system 几乎在前缀最前面，改一行，从那里往后所有 token 的 K/V 都会变，20 轮历史要全部重新 prefill，并按写入价重新写缓存，费用和首字延迟都会大涨。改第 19 轮的 `tool_result`：改动点之前的前缀仍然能命中，只有改动点之后的部分失效，损失小得多，但依然违反了「只追加」原则。这也是为什么新模型提供了「在 messages 里追加 `role: "system"` 消息」的方式来中途下达指令，而不是去改顶层的 system。

</details>

**3.** 修改 `core/next_token.py`，加一个 `top_p` 参数：按概率从高到低累加，加到 p 为止，截断后重新归一化。写一个测试，断言对「录」取 `top_p=0.7` 时只保留「列」和「页」。

**4.**（开放题）把 bigram 换成 trigram（看前两个字），「拆分记录页按钮错位」这类半通不通的生成会减少吗？语料只有 6 行时，trigram 会遇到什么新问题？由此想一想：为什么真正的 LLM 不用「数 n-gram」，而是用注意力加海量语料？

## 延伸阅读

- 原站文章：[LLM 是怎么预测下一个 token 的](https://labuladong.online/zh/ai-coding/basics/llm-token-prediction/)
- Andrej Karpathy：[Let's build GPT: from scratch, in code](https://www.youtube.com/watch?v=kCc8FmEb1nY)、[minbpe](https://github.com/karpathy/minbpe)
- Vaswani et al., *Attention Is All You Need*（2017）
- Hugging Face：[Qwen/Qwen3-0.6B](https://huggingface.co/Qwen/Qwen3-0.6B)（`config.json` / `tokenizer.json`）
- Anthropic：[Prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)

## 相关章节

- 上一篇：[上下文是什么？token 怎么计费？](./03-messages-and-tokens.md)
- 下一篇：[用 Codex 还是 Claude Code？](../p1-tools/01-tools-landscape.md)
- [LLM 和 Agent 的核心术语和原理](./01-llm-and-agent.md)
- [用 Ollama 在本地运行大模型](../p1-tools/13-local-llm-ollama.md)
- [看懂 Hugging Face 和模型文件](../p1-tools/14-hugging-face-model-files.md)
- [Tensor 的常用操作](../p5-ml/01-pytorch-basics.md)
- [多分类问题：Softmax 回归](../p5-ml/11-ml-softmax.md)
- [动手跑通 LLM 推理的全流程](../p6-nn-llm/05-inference-process.md)
- [如何实现上下文压缩](../p3-agent-internals/05-context-compaction.md)
