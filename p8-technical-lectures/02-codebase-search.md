# 代码库检索：向量检索、RepoMap 与 Agentic Search

**在有限上下文里，向量检索按相似度找候选，RepoMap 用符号关系压缩全库，Agentic Search 在运行时沿线索查证。** 三者可以组合；先看三种方式怎么选，再按需读 RepoMap 的实现细节。

## 核心矛盾：仓库太大，窗口太小

Coding Agent 每次只能「看见」仓库里很小的一部分，代码库检索要解决的就是：看哪一部分。

```d2
warehouse: 全库约 500 万 Token（50 万行 × 约 10 Token/行）
budget: "单次留给代码的预算示例：2 万 Token"
context: "放入上下文的相关代码"
warehouse -> budget: "按任务筛选"
budget -> context: "预算约为全库的 0.4%"
```

后面三种范式都在回答同一个问题：从大方块里挑哪一小块、由谁来挑、什么时候挑。

## 三种范式全景

| 谁决定看什么 ↓ / 什么时候决定 → | 预先计算 | 请求前 / 请求时 | 运行时多轮决定 |
| --- | --- | --- | --- |
| 模型按线索选择 | — | — | **Agentic Search**：边搜边读，决定下一步 |
| 规则或相似度排序 | **向量检索**：预建索引，查询时按相似度召回 | **RepoMap**：在可缓存的符号图上，按本轮种子排序 | — |

表格越往右，决定越晚；越往上，越依赖模型的判断。三者可以组合使用，最后一节讲怎么选。

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

排好名以后，按顺序把文件骨架放进固定预算，放不下就停。下面的示意数据里，前缀策略在第 4 名停止，跳过策略则能继续利用剩余 400 Token：

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

## 怎么选

```d2
semantic: 常只有业务描述？ {
  shape: diamond
}
index: 索引时效和权限可控？ {
  shape: diamond
}
budget: 需要全库鸟瞰？ {
  shape: diamond
}
vector: 向量检索先召回候选
hybrid: RepoMap + 搜索
search: Agentic Search 查源码
map: RepoMap 给骨架
semantic -> index: 是
semantic -> budget: 否
index -> vector: 能
index -> hybrid: 不能
budget -> map: 是
budget -> search: 否
```

这张图是经验法则，不是定律。判断一个方案时，可以直接问三个问题：结果是不是最新的？多快能找到对的文件？总成本（Token、延迟、运维）是多少？

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
