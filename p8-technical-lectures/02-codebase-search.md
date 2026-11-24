# 代码库检索：向量检索、RepoMap 与 Agentic Search

**在有限上下文里，向量检索按相似度找候选，RepoMap 用符号关系压缩全库，Agentic Search 在运行时沿线索查证。** 三者不是替代关系：可以先用一种找线索，再用另一种查证。

- [**先看问题缺哪种线索**](#_2)：业务描述适合找语义候选，仓库轮廓适合看符号图。
- [**再按实际任务选择组合**](#_5)：需要解释某次调用或定位改动时，沿源码验证，不把召回结果直接当答案。
- [**只在需要时深挖 RepoMap**](#repomap)：符号图能给地图，不是类型级调用图；手算、代码审查和练习留在进阶部分。

## 核心矛盾：仓库太大，窗口太小

Coding Agent 每次只能「看见」仓库里很小的一部分，代码库检索要解决的就是：看哪一部分。

```d2
warehouse: 全库约 500 万 Token（50 万行 × 约 10 Token/行）
budget: "单次留给代码的预算示例：2 万 Token"
context: "放入上下文的相关代码"
warehouse -> budget: "按任务筛选"
budget -> context: "预算约为全库的 0.4%"
```

**读图：** 500 万和 2 万是教学算例，不是通用窗口规格；在这个例子里，只能把全库约 0.4% 的代码放进去。

## 三种范式全景

**「候选怎么找」和「谁决定下一步」是两个问题。** 向量检索和 RepoMap 提供线索，Agentic Search 根据中间结果决定要不要继续查。

| 方法 | 提前可以准备什么 | 收到问题以后做什么 |
| --- | --- | --- |
| **向量检索** | 对源码分块、生成向量并建索引 | 计算查询向量，按相似度召回代码块 |
| **RepoMap** | 解析符号，构建或缓存符号关系图 | 按本轮关注点排序，在预算内提供文件和符号骨架 |
| **Agentic Search** | 不一定需要自己的索引 | 用搜索工具取线索，由模型结合结果决定是否再查 |

例如，可以先查向量索引找到退款相关文件，再让 Agent 沿定义和调用核实。

## 范式一：向量检索

把代码当成普通文档：切成块、转成向量存起来，提问时取最像的几块。

```d2
offline: 离线构建索引 {
  files: ① 读取源码 · 断点：索引可能落后于源码
  chunks: ② 切块 · 断点：可能切断定义与调用关系
  embed: ③ 计算块向量
  store: ④ 存入向量索引
  files -> chunks -> embed -> store
}
online: 在线回答问题 {
  question: ① 接收问题
  encode: ② 计算查询向量
  rank: ③ 召回相似块 · 断点：相似不等于有调用关系
  context: ④ 将候选块加入上下文
  question -> encode -> rank -> context
}
offline.store -> online.rank: 查询索引
```

向量检索能处理「哪里在做退款」这类缺少代码关键词的问题，但相似度不会直接告诉你谁调用谁。这正是下面 RepoMap 要解决的问题。

## 范式二 · 第一步：把仓库变成符号图

RepoMap 不切文本块。它用 tree-sitter 把每个文件解析成语法树，只抽两类信息：这个文件**定义**了哪些符号（def），**引用**了哪些符号（ref）。有了这两张表，就能连出下面这张图。

```d2
order: order_service.go
locker: inventory_locker.go
cache: redis_client.go
store: stock_store.go
log: logger.go
order -> locker: TryLock
order -> store: ReserveStock
order -> log: Log
locker -> cache: SetNX
locker -> log: Log
store -> log: Log
```

同一份语法树还能生成「骨架」：保留类型和函数签名，折叠函数体。最后放进上下文的就是这样的文本（│ 是保留的行，⋮ 是折叠掉的部分）：

```text
inventory_locker.go:
│type InventoryLocker struct {
│    rdb *RedisClient
⋮
│func (l *InventoryLocker) ReleaseLock(orderID string) error {
⋮
│func (l *InventoryLocker) TryLock(orderID string, ttl time.Duration) (bool, error) {
⋮
```

骨架只占原文件很小一部分 Token，却保留了模型最需要的两件事：有什么，以及怎么调用。

## 范式二 · 第二步：用个性化 PageRank 给文件排名

想象一个读代码的人从你正在改的文件出发，顺着引用边随机跳转：他长期停留最多的文件，就是最该放进上下文的文件。

```latex
r = (1-d)\,p + d\left(M^{\top} r + \Big(\sum_{u \in D} r_u\Big)\, p\right)
```

- **r**：每个文件的得分，和为 1。
- **p**：个性化向量，只有「种子」（正在编辑或被提到的文件）不为 0。普通 PageRank 就是 p 取均匀分布。
- **d**：阻尼，常取 0.85。每步 85% 顺边走，15% 跳回种子，所以结果始终围绕当前任务。
- **M**：按出边权重归一化的转移矩阵。
- **D**：没有出边的文件（如 logger），它们的得分按 p 回流，否则概率会漏掉。

看一个三文件手算例子：A→B 与 A→C 的权重为 2:1；B 只连 C；C 没有出边，概率回流给 A。阻尼取 0.85，从 `(1, 0, 0)` 开始：

| 轮次 | A：订单服务（种子） | B：库存 | C：日志 |
| --- | ---: | ---: | ---: |
| 0 | 1.000 | 0.000 | 0.000 |
| 1 | 0.150 | 0.567 | 0.283 |
| 2 | 0.391 | 0.085 | 0.524 |
| 3 | 0.596 | 0.221 | 0.183 |
| 4 | 0.306 | 0.337 | 0.357 |
| 5 | 0.453 | 0.173 | 0.373 |
| 6 | 0.467 | 0.257 | 0.276 |
| 7 | 0.384 | 0.265 | 0.351 |
| 8 | 0.448 | 0.218 | 0.334 |
| 9 | 0.434 | 0.254 | 0.312 |
| 10 | 0.415 | 0.246 | 0.339 |
| 稳态（解方程） | 0.429 | 0.243 | 0.328 |

从表中能读出三件事：种子自己得分最高（它本来就在上下文里，排地图时跳过）；人人引用的 logger 会「吸走」分数，所以要对泛滥符号降权；前几轮会振荡，应按「两轮差足够小」判断收敛，而不是固定跑几轮。

## 范式二 · 第三步：把排名装进 Token 预算

先用固定成本、硬上限的教学例子说明装箱，不把它当作 Aider 的实际停止条件。下面的示意数据里，前缀策略在第 4 名停止，跳过策略则能继续利用剩余 400 Token：

| 排名（示意） | 候选骨架 Token | 前缀策略（预算 2,000） | 放不下就跳过 |
| ---: | ---: | --- | --- |
| 1 | 700 | 放入 | 放入 |
| 2 | 500 | 放入 | 放入 |
| 3 | 400 | 放入 | 放入 |
| 4 | 600 | 放不下，停止 | 跳过 |
| 5 | 180 | 未考虑 | 放入 |
| 6 | 120 | 未考虑 | 放入 |
| 7 | 250 | 未考虑 | 跳过 |
| 8 | 60 | 未考虑 | 放入 |
| 9 | 100 | 未考虑 | 跳过 |
| 10 | 40 | 未考虑 | 放入 |
| **合计** | — | **1,600** | **2,000** |

前缀截断的最大 k 可以用二分查找求：取前 k 项的总 Token 随 k 单调增长。Aider 用二分，是因为它每试一个 k 都要真正渲染并用分词器计数，这一步很贵；如果只是把数字相加，从头累加一遍就够了。想装得更满，可以改用贪心跳过，或按「得分 ÷ Token」排序。

## 范式三：Agentic Search

让模型根据中间结果决定下一轮搜什么、读什么。它既可以调文本搜索，也可以把索引当作一个工具。

```d2
terms: ① 提炼关键词或符号
search: ② 用 grep / glob 找候选
read: ③ 读取定义与上下文
update: ④ 沿调用关系汇总线索
decide: 证据够了吗？ {
  shape: diamond
}
answer: 回答并给出代码依据
terms -> search -> read -> update -> decide
decide -> terms: 不够且仍有预算 · 换线索
decide -> answer: 足够
decide -> answer: 达到上限 · 说明缺口
```

它和 RepoMap 的本质区别是：RepoMap 用图算法替模型猜「哪些文件相关」，Agentic Search 让模型自己顺着线索一路查下去。后者不必预建索引，但多轮检索和推理会增加时延和 Token 成本。

## 先确认有权搜，再按线索选方法 { #_5 }

```d2
direction: down
scope: 已确认可读范围？ { shape: diamond }
stop: "停在边界\n请求授权或说明缺口"
hints: 手头有什么线索？ { shape: diamond }
semantic: "只有业务叫法\n先找语义候选"
lexical: "已知名字或路径\n先查对应源码"
map: "需要全库轮廓\n先看符号骨架"
scope -> stop: 未授权或不明确
scope -> hints: 已授权
hints -> semantic: 概念
hints -> lexical: 关键词
hints -> map: 结构
```

**读图：** 先限定仓库、路径和允许返回的内容，再选线索。向量块、符号名和源码都受同一权限边界约束；不能读的范围，不因换成 RepoMap 或文本搜索就变成可读。

选好线索，还要核对索引是否对应目标提交。索引过期时，可在**已授权且可读的目标版本**上直接查源码，或说明暂时无法核实；这和权限不明是两种情况。第一轮若已找到充分证据，不必启动循环；仍有疑问且有预算时，再多轮核实。例如先用「退款」召回候选，随后沿具体定义和调用点排除同名误匹配。

上线前，用同一批任务、同一提交和权限对比准确性、时延和总成本。除了找到文件，还要检查引用是否正确、改动后测试是否通过；检索不是交付成功。

## 一页小结

1. 代码库检索是在做减法：从百万级 Token 的仓库里，挑出放得进上下文的那一小部分。
2. 概念相似和调用关系是不同线索，适合互相补充。
3. RepoMap = 符号图 + 个性化 PageRank + 预算装箱；它的精度上限是「按名字连边」，泛滥符号必须降权。
4. Agentic Search 把「看什么」交给模型，换来新鲜和灵活，代价是多轮调用的 Token 与时间。
5. 三者可以组合；评价任何方案，都看新鲜度、找到对的文件的速度和总成本。

## 进阶：RepoMap 的符号图是近似，不是类型级调用图

这里用 [Aider 的 RepoMap](https://aider.chat/docs/repomap.html) 讲解符号提取、PageRank 和预算装箱，不代表所有 Coding Agent 都用这套实现。

- **解析语法不等于解析类型。** Tree-sitter 可提取定义和引用；按名称连边时，同名的 `Run` 仍可能产生假边。只匹配行首或数大括号更不可靠：多行签名、注释里的括号、Python 缩进都是反例。需要精确跳转时，可以结合语言服务或语义索引。
- **降权要检查归一化后的效果。** 上表的 B 只有一条出边；单独调低 B→C 的权重，归一化后它仍会把全部出边概率交给 C。应检查建图规则及相对权重，而不只看一个系数。
- **区分示意装箱与真实开销。** 固定的 Token 估算可以直接累加；实际工具可能必须渲染定义及外层作用域后再计数。比较性能时，应分别测首次构建、增量更新和请求时延，不把某一仓库的速度或压缩率当作通用承诺。

**动手练习：** 手算上表前三轮，再把阻尼改为 0.5；可用 `networkx.pagerank` 的 `personalization` 和 `dangling` 对拍。然后在公开示例仓库运行 `aider --show-repo-map`，对照地图和一次实际文本搜索，看看两者各自先提供什么证据。

### 延伸阅读

- [Aider：Repository map](https://aider.chat/docs/repomap.html)
- [repo-mapper：Aider 算法的 Rust 实现](https://docs.rs/repo-mapper)
- [Settling the RAG Debate：Claude Code 为何弃用向量 RAG](https://smartscope.blog/en/ai-development/practices/rag-debate-agentic-search-code-exploration/)
- [AI Engineer Europe 2026：RAG is dead, right?](https://www.ai.engineer/talks/UM6sFg_jdlE-rag-is-dead-right-kuba-rogut)

## 附录：RepoMap 进阶讲义全文

> 以下保留进阶稿的核查表、Go／Rust 代码审查、手算推导和练习。文中的「原文」指进阶稿当时评析的文章，并不是本章的入门部分。「Claude Code 弃用向量 RAG」是下列旧资料讨论过的产品设计取舍，不表示它的所有版本、功能和接入工具都没有索引，也不是向量检索已过时的证据。

<details markdown="1">
<summary>展开进阶讲义全文</summary>

### 导读：原文说了什么、可信度如何

**一句话总结**：原文主张用「AST 符号骨架 + 个性化 PageRank + Token 预算装箱」替代向量检索，给 Coding Agent 生成一份紧凑的全库代码地图（RepoMap）。

**总评：算法思路基本正确，但标题归属错误，数字和代码都有水分。**

- **归属错误（最大问题）**：AST + PageRank RepoMap 是 [Aider](https://aider.chat/docs/repomap.html) 的方案，不是 Claude Code 的。Claude Code 的创建者 Boris Cherny 公开说过：早期版本试过 RAG + 本地向量库，后来发现 agentic search（模型自己反复调 grep / glob / read）效果更好。Claude Code 并没有预先算 PageRank 地图。
- **算法部分基本可信**：tree-sitter 抽 def/ref、按符号引用建图、以当前文件为种子跑个性化 PageRank、二分查找卡 Token 预算，这些都与 Aider 实际做法一致。
- **水分**：「50ms」「压缩率 85%\~92%」「增量 < 30ms」均无测试依据；文中 Rust 代码标榜「AST」，实际是按行前缀匹配 + 数大括号，正是它自己批评的「脆弱启发式」。
- **对向量 RAG 的批评有一半是稻草人**：粗暴定长切块确实差，但 Cursor 等产品用的是按 AST 边界切块 + 增量同步，并非文中描述的「500 Token 滑窗」。

这份讲义保留原文正确的部分，纠正错误，并把第三种范式（Agentic Search）补上。

### 问题定义：Agent 怎么「看见」一个大仓库

核心矛盾只有一个：仓库有几百万 Token，上下文窗口只能放进其中很小一部分。所有方案都是在回答「放哪一部分、谁来决定、什么时候决定」。

| 范式 | 谁决定看什么 | 什么时候算 | 强项 | 弱项 | 代表 |
| --- | --- | --- | --- | --- | --- |
| 向量 RAG | 余弦相似度 | 预先建索引 | 概念模糊查询（「哪里处理退款」） | 索引陈旧、不懂调用链、代码外传的安全顾虑 | Cursor 代码库索引（AST 切块 + 增量同步） |
| 结构化 RepoMap | 符号引用图 + PageRank | 每轮请求前（本地、可缓存） | 全局鸟瞰、知道「谁调谁」、成本确定 | 只给签名不给实现；动态语言/反射/依赖注入时图不准 | Aider |
| Agentic Search | 模型自己（多轮 grep/glob/read） | 运行时按需 | 可以按需读取当前 checkout 的文件、精确匹配并沿线索深挖，也可借助索引 | 多轮调用费 Token 和时间；没有关键词时「不知道搜什么」 | Claude Code、Codex CLI |

三者不互斥。RepoMap 可以当 Agentic Search 的「开局地图」，向量检索可以当它的一个工具。实际工程里的取舍变量是：新鲜度、找到正确文件的速度、总成本（Token / 延迟 / 运维）。

### 原理一：从源码到符号图

RepoMap 的输入不是文本块，而是一张「哪个文件用了哪个文件定义的符号」的有向图。构建分四步：

1. **解析**：用 tree-sitter 把每个文件解析成具体语法树（CST）。tree-sitter 容错、增量、支持几十种语言，需要编译各语言的 C 解析器。
2. **抽 tags**：用每种语言的 `tags.scm` 查询，把节点标成 `definition.function` / `definition.class` / `reference.call` 等。得到每个文件的 defs 集合和 refs 集合。某些语言只有 def 查询时，Aider 用 Pygments 把所有标识符当 ref 兜底。
3. **按名字连边**：文件 A 的 refs 里有符号 s，而文件 B 定义了 s，就连一条 A → B。注意这是**按名字匹配**，不做类型解析，所以重名符号（`New`、`Run`、`get`）会制造假边。
4. **边权压噪**：给泛滥名字降权、给特征名字提权。原文用 IDF（定义该符号的文件越多，权重越低），思路合理。Aider 实际用的是一组经验乘子：用户消息里提到的标识符 ×10，较长的 snake/camel 名 ×10，`_` 开头的私有名 ×0.1，被超过 5 个文件定义的名 ×0.1，引用次数取平方根（以 Aider 源码 repomap.py 为准，版本间可能有差异）。

渲染时只输出「被选中的定义行 + 它的外层作用域行」，其余用 `⋮` 折叠。这一点和原文「折叠函数体」的思想一致，但 Aider 是在**定义粒度**排序和装箱，而不是原文的整文件粒度。

**关于「AST」这个词**：真正的价值在于用语法树定位声明边界，而非字符串匹配。字符串里的 `{`、多行签名、`pub(crate) async fn`、Python 缩进、装饰器，都会让「数大括号」方案出错。

### 原理二：个性化 PageRank（PPR）

PPR 回答的问题是：从「我现在正在改的文件」出发顺着引用边随机游走，长期停留在哪些文件上的概率最高。

```latex
r = (1-d)\,p + d\left(M^{\top} r + \Big(\sum_{u \in D} r_u\Big)\, p\right)
```

- r：每个文件的得分，和为 1。
- p：个性化向量。当前在编辑或被提到的文件分到概率，其余为 0。普通 PageRank 就是 p 取均匀分布的特例。
- d：阻尼，常取 0.85。每一步有 85% 概率顺边走，15% 概率跳回种子。d 越小，结果越「贴近种子」。
- M：按出边权归一化后的转移矩阵。
- D：悬挂节点（没有出边的文件）。它们的概率按 p 重新注入，保证总和不漏。Aider 调 networkx 时也是传 `dangling=personalization`。

**手算例子**（可用纸笔验证）：三个文件，A = order\_service（种子，p = 1, 0, 0），B = inventory，C = logger。A→B 权 2，A→C 权 1，B→C 权 1，C 无出边。

列方程：a = 0.15 + 0.85c（种子跳转 + C 的悬挂回流），b = 0.85 × a × 2/3，c = 0.85 × a × 1/3 + 0.85b。解得 **a ≈ 0.429，b ≈ 0.243，c ≈ 0.328**。

这个结果有三个教学点：

1. **种子自己得分最高**。种子文件通常已经全文在上下文里，渲染地图时应跳过。
2. **工具类文件会「吸能量」**。logger 得分高于真正相关的 inventory，因为所有人都引用它。这就是边权压噪必要的原因。
3. **归一化会抵消边权**。B 只有一条出边，不管权重多低，它的全部概率都会流向 C。所以要压低 logger，光靠降低单条边权不够，还得在全局层面处理（例如过滤高频符号、对结果做后置惩罚）。

迭代求解用幂迭代即可。原文固定跑 25 轮；更稳妥的做法是以「两轮差的 L1 范数 < 1e-6」为收敛条件。上面这个小图前几轮会明显振荡，可以自己算两轮看看。

### 原理三：Token 预算装箱

二分查找成立的前提是单调性：取排名前 k 项渲染出的 Token 数随 k 单调不减，所以可以二分出满足预算的最大 k。

**为什么 Aider 用二分而不是累加**：渲染出的树会合并同一文件的作用域行，整体 Token 数不等于各项之和，要按渲染后的内容计数。以 [Aider 固定版本源码](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py)为例，尝试候选前缀时使用二分，较长内容会采样估算；差距小于目标预算的 15% 就可能接受，不是硬上限。

**原文版本的问题**：它的 measureTokens 只是把每个文件的预估 Token 加起来。既然是简单加法，一次前缀和线性扫描 O(n) 就够，二分 + 每次重新求和反而是 O(n log n)。「二分」在这里是装饰，不是优化。

**前缀截断的局限**：只取前 k 项，遇到一个大文件就停了，其后若干个小而重要的文件会被一并丢掉。更好的做法：

- 贪心跳过：按分数遍历，放不下就跳过继续试下一个。
- 按密度排序：用「得分 / Token」排序，即背包问题的经典近似。
- 降到定义粒度：像 Aider 一样对单个定义排序，大文件只放它最重要的几个符号。

**确定性**：同分时按路径字典序排，输出字节稳定，有利于提示前缀缓存命中。这一点原文说得对；但只要种子文件一变，整张地图就会变，所以 Aider 会缓存地图，只在输入变化时重算。

### 原文逐项事实核查

结论：12 条关键说法中，算法类大多成立，产品归属与性能数字不成立或无依据。

| 原文说法 | 判断 | 依据 / 说明 |
| --- | --- | --- |
| Claude Code 用 AST + PageRank 的 RepoMap | 错误 | Claude Code 用 agentic search（grep/glob/read 多轮工具调用），创建者公开说明早期向量方案被弃用；RepoMap 是 Aider 的方案 |
| Claude Code 的按需检索 | 有公开设计说明，不是全功能断言 | [产品工程文章](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)说明了按需查取；不能推出所有版本和连接工具都没有索引 |
| Aider 用 tree-sitter 抽 def/ref 建图 | 正确 | 与 Aider repomap.py 一致 |
| 以当前文件为种子跑个性化 PageRank，d = 0.85 | 正确 | Aider 以对话中的文件和提到的标识符作种子 |
| 二分查找卡 Token 预算 | 正确 | 但原文实现里这一步是多余的（见原理三） |
| 边权用 IDF | 合理但非业界做法 | Aider 用一组经验乘子 + 引用次数平方根 |
| 50 万行 50ms 内绘出拓扑 | 无依据 | 首次解析大仓库通常是秒级；靠按 mtime 缓存 tags 才能增量变快 |
| 压缩率 85%\~92%，3\~4k Token 装下 5 万 Token | 无依据 | 量级合理，但没有给出测量仓库与方法 |
| 向量 RAG 必然按 500 Token 定长切块 | 片面 | 成熟产品按 AST 边界切块并做增量同步 |
| 向量索引会陈旧 | 正确 | 这是公认的核心弱点之一 |
| 代码是「有向超图」 | 用词不当 | 这里构建的是带权有向图（可视为多重图），没有用到超边 |
| Rust 提取器是「AST」且「不用正则」 | 名不副实 | 是按行前缀匹配 + 数大括号，脆弱程度与正则相当 |

### 原文代码审查

Go 的 PPR 引擎数学上是对的，可以拿来学习；Rust 提取器只适合当玩具，不要用在生产。

**Go PPR 引擎：做对的地方**

- 悬挂质量按 p 回流，每轮总和严格为 1：(1−d) + d·悬挂质量 + d·(1−悬挂质量) = 1。
- 边方向是「引用者 → 定义者」，概率流向被依赖的核心模块，符合直觉。
- 同分按路径排序，输出确定。

**Go PPR 引擎：可以改进的地方**

- 固定 25 轮，没有收敛判断。
- 种子文件本身得分最高，但没有从地图里排除（注释里提了，代码没做）。
- 一个符号被多个文件定义时，每个定义者都拿到全额 IDF，泛滥符号的总影响不一定被压低。
- 装箱的二分是多余的，且前缀截断会丢小文件（见原理三）。
- 贴出的代码缩进与空格被排版破坏（如 `Skeleton    string// ...`），需 gofmt 后才能读。

**Rust 骨架提取器：具体缺陷**

1. 不是 AST。用 `strip_prefix("fn ")` 之类匹配行首，漏掉 `pub(crate) fn`、`async fn`、`pub enum`、`impl` 块、Go 的 `type X interface`（会被误判为 StructOrClass）。
2. 大括号计数不识别字符串和注释，`"{"` 或 `// }` 会把深度算错，之后整个文件的折叠都会错。
3. 多行签名（参数分多行写）只会保留第一行。
4. 完全不支持 Python 等靠缩进分块的语言。
5. 注释说「优先捕获含大写字母或下划线的标识符」，代码里并没有这个判断，只过滤了长度 ≥ 4。
6. 把本文件定义的名字从 refs 里全部删掉，如果本文件也调用了别处的同名符号（如 `Run`），跨文件边会丢失。
7. 文中「第 102\~105 行」等行号与贴出的代码对不上。

生产上应直接用 tree-sitter + 各语言 `tags.scm`；Rust 生态里已有移植 Aider 算法的 [repo-mapper](https://docs.rs/repo-mapper) 可参考。

### 动手练习与延伸阅读

按顺序做完这 6 个练习，就能独立判断一个代码检索方案的优劣。

- [ ] 手算原理二的例子前 3 轮迭代，观察振荡；再把 d 改成 0.5，看分数如何向种子收缩。
- [ ] 在一个自己熟悉的仓库里跑 `aider --show-repo-map`，对照你心中的「核心文件」看排名是否合理。
- [ ] 用 Python + networkx 复现原文 Go 引擎，对同一张图与 `nx.pagerank(G, personalization=p, dangling=p)` 结果对拍。
- [ ] 用 py-tree-sitter 加载 Go 语法和 tags 查询，把原文 Rust 提取器的 7 个缺陷逐一造例验证。
- [ ] 把装箱从「前缀截断」改为「得分 / Token 贪心」，对比同预算下装入的总分。
- [ ] 在 Claude Code 里问一个跨模块问题，记录它的 grep/read 调用序列，对比 RepoMap 会给出哪些文件。

延伸主题：LSP / SCIP（带类型的精确跳转）是比「按名字连边」更准的下一级方案；理解了本讲义的局限后再看它，会更有感觉。

#### 来源

- [Aider 官方：Repository map](https://aider.chat/docs/repomap.html)
- [Aider repomap.py 源码流程分析（hermes-agent issue #535）](https://github.com/NousResearch/hermes-agent/issues/535)
- [repo-mapper：Aider 算法的 Rust 实现](https://docs.rs/repo-mapper)
- [Settling the RAG Debate：Claude Code 为何弃用向量 RAG](https://smartscope.blog/en/ai-development/practices/rag-debate-agentic-search-code-exploration/)
- [AI Engineer Europe 2026：RAG is dead, right?](https://www.ai.engineer/talks/UM6sFg_jdlE-rag-is-dead-right-kuba-rogut)

</details>
