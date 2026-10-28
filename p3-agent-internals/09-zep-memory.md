# Zep 记忆系统的实现思路

> 对应原站：[Zep 记忆系统的实现思路](https://labuladong.online/zh/ai-coding/basics/zep-memory/)（会员内容；本章为独立原创重写）

> **一句话结论**：Zep（开源内核 Graphiti）把记忆存成一张「实体—关系」图，每条关系边都带两条时间线：现实中何时成立 / 何时失效，以及系统何时得知 / 何时作废。新事实和旧事实冲突时，旧边只被打上失效时间，不会被删除，所以既能问「现在是什么」，也能问「当时是什么」「当时系统以为是什么」。

## 「他现在在哪家公司？」

上一章 mem0 留了一个尾巴：用户说「我不用 Vim 了，改用 VS Code」，被拆成两条孤立的事实，关系丢了。

再想一个更难的场景。你做一个帮销售记客户信息的 Agent：

- 2024 年 3 月，用户说「小李在 A 公司」。
- 2026 年 6 月，用户说「小李跳槽到 B 公司了」。
- 2026 年 7 月，用户又补充了一句「对了，小李 2022 年在 C 公司实习过」。

现在问三个问题：小李现在在哪？2025 年初他在哪？2023 年他在哪？

你可能会问：用 mem0 v3 那种只追加的方式，三条都存着，让模型自己看不就行了？

对「现在在哪」也许可以。但「2023 年在哪」就要求模型从三条孤立的句子里自己推出时间区间，而且第三条信息是**晚到的旧事实**：它说的是更早的事，却是最后才告诉系统的。光靠追加和检索，很难答对。

Zep 的思路是：把时间做成数据结构的一部分。

先交代一下关系：Zep 是商业托管服务，开源的是它的内核 Graphiti，一个时序知识图谱库。本章读的是 `getzep/graphiti` 仓库（commit `8e320f8`，2026-10-21），概念参考 Zep 论文（arXiv:2501.13956）。

## 数据结构：节点、边、两条时间线

Graphiti 的图里有三类主要节点（`graphiti_core/nodes.py`）：

- **EpisodicNode（情节）**：一段原始输入，比如一条消息、一段文本、一个 JSON。带 `valid_at`，表示这段原始材料产生的时间。
- **EntityNode（实体）**：从情节里抽出来的人、公司、项目等，带名字的 embedding 和一段摘要。
- **CommunityNode（社区）**：一群关系紧密的实体的聚类摘要。

关系存在 **EntityEdge** 上（`graphiti_core/edges.py`），这是重点：

| 字段 | 含义 |
|---|---|
| `name` | 关系名，比如 `WORKS_AT` |
| `fact` | 一句话描述这条关系，比如「小李在 A 公司工作」 |
| `fact_embedding` | `fact` 的向量 |
| `episodes` | 这条事实出自哪些情节（溯源） |
| `valid_at` / `invalid_at` | 现实世界里何时成立 / 何时不再成立（时间线 T） |
| `created_at` / `expired_at` | 系统何时得知 / 何时把它标记失效（时间线 T′） |

情节和实体之间还有 `MENTIONS` 边，所以每个实体都能追溯到最初提到它的原话。

为什么要两条时间线？打个比方，这像法院的案卷：一份合同「2024 年 3 月生效、2026 年 6 月解除」，这是**合同本身的效力期**；法院「2024 年 3 月 5 日收到这份合同、2026 年 6 月 3 日登记了解除」，这是**法院的登记时间**。两者不一样，而且都重要。

类比的局限：法院登记的信息基本可靠，而 Graphiti 的时间是 LLM 从自然语言里抽出来的，「上个月」「年底前」这种说法抽错的概率不小。源码里专门有一段处理这个（下面会讲）。

## 写路径：一次 add_episode 发生了什么

```d2
direction: down
a: "add_episode: 一条新消息"
b: 取最近 10 个情节当上下文
c: LLM 抽实体
d: 实体去重 {shape: diamond}
e: 合并到已有实体
f: LLM 判断是否同一实体
g: "LLM 抽关系边 + 时间"
h: "混合检索候选：\n同一对实体的旧边 / 所有相关旧边"
i: "LLM 判断：重复？矛盾？"
j: "复用旧边，\nepisodes 里加上这条情节"
k: "按时间给旧边或新边打\ninvalid_at / expired_at"
l: 新增边
m: "写入图：节点、边、MENTIONS"
a -> b
b -> c
c -> d
d -> e: "精确名匹配 / MinHash 模糊匹配"
d -> f: 拿不准
e -> g
f -> g
g -> h
h -> i
i -> j: 重复
i -> k: 矛盾
i -> l: 都不是
j -> m
k -> m
l -> m
```

逐步说（入口是 `graphiti_core/graphiti.py` 的 `Graphiti.add_episode()`）：

**抽实体。** 提示词在 `prompts/extract_nodes.py`，有一长串「不要抽」的清单：代词、抽象概念、泛泛的名词、光秃秃的亲属称谓。比如要抽「Nisha 的爸爸」而不是「爸爸」，并且要求根据前文消解代词。

**实体去重**（`utils/maintenance/node_operations.py` 的 `resolve_extracted_nodes`）。这是图记忆的命门：「小李」「李明」「Li Ming」要是成了三个节点，图就碎了。它的顺序是：

1. 先收集候选：精确名字匹配 + 名字 embedding 余弦相似度（最多 15 个，相似度至少 0.6）。
2. 再走确定性规则：规范化后名字完全相同且只有一个候选，直接合并；否则对「信息量够大」的名字（香农熵 ≥ 1.5，太短的名字不算）用 MinHash/LSH 算 Jaccard 相似度，≥ 0.9 算同一个。
3. 剩下拿不准的，才交给 LLM 判断。

我很喜欢这个顺序：**能用确定性规则解决的，就不花 LLM 调用**。熵门槛那一步尤其细心：「Al」和「AI」这种短名字，字符片段太少，模糊匹配很不可靠，干脆不让它走这条路。

**抽关系和时间。** `prompts/extract_edges.py` 一次调用同时抽出关系边和 `valid_at` / `invalid_at`。然后 `normalize_future_temporal_bounds` 用正则修正两类常见错误：「将要 / 计划」类的未来时态，`valid_at` 改成当前参考时间；「在……之前 / 截止」类的说法只是期限，不算 `invalid_at`。

**冲突检测与失效**（`utils/maintenance/edge_operations.py`）。对每条新边做两次混合检索（BM25 + 向量，RRF 融合）：一次只看同一对实体之间的旧边，找**重复**；一次不限端点，找**矛盾**。然后一次 LLM 调用输出 `duplicate_facts` 和 `contradicted_facts`。提示词写得很保守：除非新事实**明确**让旧事实不成立，否则不要标矛盾。

标了矛盾之后，怎么改时间（`_apply_temporal_invalidation` / `resolve_edge_contradictions`）：

- 正常顺序：旧边比新边早生效，旧边的 `invalid_at` 设为新边的 `valid_at`，`expired_at` 设为现在。
- 乱序到达：矛盾的旧边反而比新边**晚**生效（新来的是更早的事），那么是**新边**的 `invalid_at` 设为旧边的 `valid_at`。
- 两个区间本来就不重叠，就不动。

这就是开头那个「晚到的旧事实」的解法。

回到主线：Zep 往上下文里放的不是一堆句子，而是「在某个时间点有效的那几条边」。它在写入时多花了好几次 LLM 调用（抽实体、去重、抽边、判矛盾），换来的是读取时能按时间精确过滤，送进上下文的信息更少、更对。

## 动手：双时间线的最小实现

下面的 `Edge` 字段名和 Graphiti 的 `EntityEdge` 一致，矛盾判断用规则代替 LLM，失效逻辑按上面两条规则写：

=== "Node"

    ```ts
    type Day = string;                 // "YYYY-MM-DD"：同格式的日期字符串按字典序比较就是按时间比较

    class Edge {                       // 对应 graphiti 的 EntityEdge（字段名一致，类型简化成日期字符串）
      source: string;
      name: string;
      target: string;
      fact: string;
      valid_at: Day;                   // 事实在现实世界里何时开始成立（时间线 T）
      invalid_at: Day | null = null;   // 何时不再成立（T）
      created_at: Day | null = null;   // 系统何时知道的（时间线 T'）
      expired_at: Day | null = null;   // 系统何时把它标记失效（T'）
      episodes: string[] = [];
      constructor(source: string, name: string, target: string, fact: string, { valid_at }: { valid_at: Day }) {
        [this.source, this.name, this.target, this.fact, this.valid_at] = [source, name, target, fact, valid_at];
      }
    }

    class Graph {
      edges: Edge[] = [];

      contradicts(old: Edge, neu: Edge): boolean {
        // 真实实现：同一实体对上 BM25+向量检索出候选，再让 LLM 判断 contradicted_facts
        return old.source === neu.source && old.name === neu.name && old.target !== neu.target;
      }

      add(neu: Edge, { today }: { today: Day }): void {
        neu.created_at = today;
        for (const old of this.edges) {
          if (!this.contradicts(old, neu)) continue;
          if (old.valid_at < neu.valid_at) {
            // 正常顺序：旧事实在新事实生效那一刻失效（只在区间还重叠时才改）
            if (old.invalid_at === null || old.invalid_at > neu.valid_at)
              [old.invalid_at, old.expired_at] = [neu.valid_at, today];
          } else {
            // 乱序到达：新来的其实是更早的事实，它的有效期截止到后一个事实开始
            if (neu.invalid_at === null || old.valid_at < neu.invalid_at)
              [neu.invalid_at, neu.expired_at] = [old.valid_at, today];
          }
        }
        this.edges.push(neu);
      }

      asOf(t: Day): string[] {                         // 「t 时刻什么是真的」
        return this.edges.filter((e) => e.valid_at <= t && (e.invalid_at === null || t < e.invalid_at)).map((e) => e.fact);
      }

      believedAt(t: Day): string[] {                   // 「t 时刻系统当时认为哪些边有效」（时间线 T'）
        return this.edges.filter((e) => e.created_at! <= t && (e.expired_at === null || t < e.expired_at)).map((e) => e.fact);
      }
    }

    const g = new Graph();
    g.add(new Edge("小李", "WORKS_AT", "A公司", "小李在 A 公司工作", { valid_at: "2024-03-01" }), { today: "2024-03-05" });
    g.add(new Edge("小李", "WORKS_AT", "B公司", "小李跳槽到 B 公司", { valid_at: "2026-06-01" }), { today: "2026-06-03" });
    g.add(new Edge("小李", "WORKS_AT", "C公司", "小李 2022 年在 C 公司实习", { valid_at: "2022-07-01" }), { today: "2026-07-01" });
    for (const e of g.edges)
      console.log(`${e.fact.padEnd(22)} valid=${e.valid_at} invalid=${e.invalid_at} expired=${e.expired_at}`);
    for (const t of ["2023-01-01", "2025-01-01", "2026-10-01"])
      console.log(t, "->", g.asOf(t));
    console.log("系统在 2026-06-02 相信:", g.believedAt("2026-06-02"));
    ```

=== "Python"

    ```python
    from dataclasses import dataclass, field
    from datetime import date

    @dataclass
    class Edge:                       # 对应 graphiti 的 EntityEdge（字段名一致，类型简化成 date）
        source: str
        name: str
        target: str
        fact: str
        valid_at: date                # 事实在现实世界里何时开始成立（时间线 T）
        invalid_at: date | None = None   # 何时不再成立（T）
        created_at: date = None       # 系统何时知道的（时间线 T'）
        expired_at: date | None = None   # 系统何时把它标记失效（T'）
        episodes: list = field(default_factory=list)

    class Graph:
        def __init__(self): self.edges: list[Edge] = []

        def contradicts(self, old: Edge, new: Edge) -> bool:
            # 真实实现：同一实体对上 BM25+向量检索出候选，再让 LLM 判断 contradicted_facts
            return old.source == new.source and old.name == new.name and old.target != new.target

        def add(self, new: Edge, today: date):
            new.created_at = today
            for old in self.edges:
                if not self.contradicts(old, new):
                    continue
                if old.valid_at < new.valid_at:
                    # 正常顺序：旧事实在新事实生效那一刻失效（只在区间还重叠时才改）
                    if old.invalid_at is None or old.invalid_at > new.valid_at:
                        old.invalid_at, old.expired_at = new.valid_at, today
                else:
                    # 乱序到达：新来的其实是更早的事实，它的有效期截止到后一个事实开始
                    if new.invalid_at is None or old.valid_at < new.invalid_at:
                        new.invalid_at, new.expired_at = old.valid_at, today
            self.edges.append(new)

        def as_of(self, t: date):                        # 「t 时刻什么是真的」
            return [e.fact for e in self.edges if e.valid_at <= t and (e.invalid_at is None or t < e.invalid_at)]

        def believed_at(self, t: date):                  # 「t 时刻系统当时认为哪些边有效」（时间线 T'）
            return [e.fact for e in self.edges if e.created_at <= t and (e.expired_at is None or t < e.expired_at)]

    g = Graph()
    g.add(Edge("小李", "WORKS_AT", "A公司", "小李在 A 公司工作", valid_at=date(2024, 3, 1)), today=date(2024, 3, 5))
    g.add(Edge("小李", "WORKS_AT", "B公司", "小李跳槽到 B 公司", valid_at=date(2026, 6, 1)), today=date(2026, 6, 3))
    g.add(Edge("小李", "WORKS_AT", "C公司", "小李 2022 年在 C 公司实习", valid_at=date(2022, 7, 1)), today=date(2026, 7, 1))
    for e in g.edges:
        print(f"{e.fact:<22} valid={e.valid_at} invalid={e.invalid_at} expired={e.expired_at}")
    for t in (date(2023, 1, 1), date(2025, 1, 1), date(2026, 10, 1)):
        print(t, "->", g.as_of(t))
    print("系统在 2026-06-02 相信:", g.believed_at(date(2026, 6, 2)))
    ```

===! "Node"

    ```text
    ❯ node bitemporal_demo.ts
    小李在 A 公司工作             valid=2024-03-01 invalid=2026-06-01 expired=2026-06-03
    小李跳槽到 B 公司             valid=2026-06-01 invalid=null expired=null
    小李 2022 年在 C 公司实习      valid=2022-07-01 invalid=2024-03-01 expired=2026-07-01
    2023-01-01 -> [ '小李 2022 年在 C 公司实习' ]
    2025-01-01 -> [ '小李在 A 公司工作' ]
    2026-10-01 -> [ '小李跳槽到 B 公司' ]
    系统在 2026-06-02 相信: [ '小李在 A 公司工作' ]
    ```

=== "Python"

    ```text
    ❯ uv run python bitemporal_demo.py
    小李在 A 公司工作             valid=2024-03-01 invalid=2026-06-01 expired=2026-06-03
    小李跳槽到 B 公司             valid=2026-06-01 invalid=None expired=None
    小李 2022 年在 C 公司实习      valid=2022-07-01 invalid=2024-03-01 expired=2026-07-01
    2023-01-01 -> ['小李 2022 年在 C 公司实习']
    2025-01-01 -> ['小李在 A 公司工作']
    2026-10-01 -> ['小李跳槽到 B 公司']
    系统在 2026-06-02 相信: ['小李在 A 公司工作']
    ```

（纯本地运行，矛盾判断是规则，不是 LLM。）

三个时间点的答案都对了。注意第三条「C 公司实习」是 2026 年 7 月才告诉系统的，它的有效期被正确地截在了 2024 年 3 月（A 公司那条开始的时候），而 A 公司那条没被它误伤。

最后一行是另一条时间线的查询：2026 年 6 月 2 日，系统还没收到跳槽的消息，它当时**以为**小李在 A 公司。这种「系统当时知道什么」的查询，对审计和排查「Agent 当时为什么那么回答」特别有用。

## 读路径：混合检索 + 重排

`graphiti_core/search/` 里，边、节点、情节、社区各有检索方法：`cosine_similarity`（向量）、`bm25`（关键词）、`bfs`（从某些节点出发在图上广度优先扩展）。检索结果再过一道重排：`rrf`（多路结果按排名融合）、`mmr`（兼顾多样性）、`node_distance`（离某个中心节点越近越优先）、`episode_mentions`（被提到次数越多越优先）、`cross_encoder`（交叉编码器，最准也最贵）。

`search_config_recipes.py` 里预置了一堆组合，比如 `EDGE_HYBRID_SEARCH_RRF`。`Graphiti.search()` 默认就用它；传了中心节点就换成 `EDGE_HYBRID_SEARCH_NODE_DISTANCE`。

图数据库支持 Neo4j、FalkorDB、Kuzu、Amazon Neptune（`driver/driver.py` 里的 `GraphProvider`）。社区用标签传播算法聚类，论文里说选它而不是 Leiden，是因为它容易做增量更新；但增量更新会和全量结果慢慢漂移，所以还要定期全量重建。

## mem0 和 Zep 怎么选

| | mem0（v3） | Zep / Graphiti |
|---|---|---|
| 存什么 | 一条条独立短事实 | 实体 + 带时间的关系边 + 原始情节 |
| 冲突怎么办 | 只追加，读取时排序 | 写入时判矛盾，给旧边打失效时间 |
| 写入成本 | 一次 LLM 调用 | 多次 LLM 调用（抽实体、去重、抽边、判矛盾） |
| 擅长 | 偏好、零散事实，量大、简单 | 人、组织、项目之间会随时间变化的关系 |
| 能回答「当时是什么」 | 难 | 原生支持 |

我的看法：大部分「记住用户偏好」的场景，mem0 那种轻量方案就够了，Zep 的写入成本不划算。但凡你的领域里有**会变的关系**（谁负责哪个模块、哪个客户在哪个阶段、哪个 bug 被谁修了），并且需要回答历史问题，图加时间线的价值就出来了。

## 对照你的环境

你的 Linear watchlist 和 `linear-status-push` 其实在手工做一件 Zep 擅长的事：「这张单**当时**指派给谁、什么时候转给了 QA、现在在谁手上」。一张单从 assignee=me 变成 QA 之后，你 CLAUDE.md 里专门强调要 `linear-watch add`，否则「跟丢」。这就是只记「当前状态」、不记「状态变化时间线」导致的问题。要是用双时间线建模，「转走」只是旧边失效，历史一直都在。

## 回到开头的问题

小李现在在 B 公司，2025 年初在 A 公司，2023 年在 C 公司实习。Zep 能答对，是因为每条关系边都带着有效期，冲突时只给旧边打失效时间、不删除；晚到的旧事实也能根据时间放进正确的位置。

## 常见坑

1. **实体没去重**：同一个人变成三个节点，关系全碎。去重是图记忆质量的上限。
2. **时间抽错**：「计划下个月入职」被当成已经入职。Graphiti 用正则专门修正了未来时态和期限。
3. **矛盾判得太激进**：「小李在 A 公司」和「小李在 A 公司做前端」不矛盾。提示词要保守。
4. **只有一条时间线**：分不清「事实何时变的」和「系统何时知道的」，排查 Agent 的历史行为时就说不清。
5. **写入成本被低估**：一条消息几次 LLM 调用，高频写入场景要算好账，或者异步批处理。

## 练习

1. 给玩具加一条边：「小李 2026 年 9 月从 B 公司离职」（只有 `invalid_at` 的事实），想想该怎么建模，`as_of(2026-10-01)` 应该返回什么。
2. 实现一个最简单的实体去重：名字规范化（去空格、转小写）后完全相同就合并，再加一个「名字太短就不做模糊匹配」的门槛。
3. 开放题：如果把你的 Claude Code `memory/` 目录改造成一张时序图（记忆是边、项目和工具是实体），哪些现在的痛点会被解决？会引入哪些新的麻烦？

## 延伸阅读

- Graphiti 源码：https://github.com/getzep/graphiti（`graphiti_core/graphiti.py`、`utils/maintenance/edge_operations.py`、`search/`）
- Zep 论文：*Zep: A Temporal Knowledge Graph Architecture for Agent Memory*，https://arxiv.org/abs/2501.13956
- 本库：[上一章 mem0](08-mem0-memory.md)、[下一章 权限检查](10-permission-check.md)、[RAG 原理](../p2-agent-basics/04-rag-principles.md)
