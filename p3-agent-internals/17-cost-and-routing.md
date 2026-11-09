# 成本控制与模型路由

> 本章不对应原站文章，是知识库的补充章节（独立原创）：先把一次 agent 任务的账算清，再按「省多少、风险多大」排降本手段，最后给循环加上金额预算，给模型路由挂上评测门禁。

> **一句话结论**：agent 的钱大头花在「每一圈都重读整段历史」上，所以先保住缓存命中、在工具结果进门时就截短，再谈换模型。换模型是唯一会直接动质量的手段，路由前后必须跑同一个评测集，按「每个做完的任务花多少钱」比，而不是按单次请求比。

## 任务没变，账单为什么翻了三倍？

假设你给 webapp 做了一个修 bug 的 agent。上周一个任务平均几毛钱，这周同样的任务，账单是上周的三倍。代码没人动过。

你可能会问：是不是模型涨价了？大概率不是。翻 trace 往往会看到下面几种情况之一：

- 有人往 system prompt 里加了一行「当前时间：……」，缓存从此每圈都失效；
- 新接的一个工具一次返回两万行日志，后面每一圈都要把它重读一遍；
- 某类任务的圈数从 6 圈涨到了 15 圈。

这三件事都不会让单次请求贵多少，但会让**一个任务**贵很多。成本控制的第一步，是把账算到「任务」这一级。

## 先算账：每一圈都在为整段历史买单

[上下文是什么？token 怎么计费？](../p0-core/03-messages-and-tokens.md)讲过：模型没有状态，每次请求都把完整的 `messages` 重发一遍，`usage` 把输入拆成三份分别计价。放到 agent 循环里，一次任务的成本就是把每一圈的账加起来：

```text
任务成本 = Σ 每一圈 [ 未缓存输入 × 输入价
                    + 缓存写入 × 输入价 × 1.25（5 分钟 TTL）或 × 2（1 小时 TTL）
                    + 缓存读取 × 缓存读价
                    + 输出（含思考）× 输出价 ]
```

单价取自 Claude 官方[定价页](https://platform.claude.com/docs/en/about-claude/pricing)（2026-11-09 查），第一方 API 标价，单位是美元每百万 token：

| 模型 | 输入 | 输出 | 缓存读 | 说明 |
|---|---|---|---|---|
| `claude-opus-5-5` | $4.00 | $20.00 | $0.20（0.05×） | 当前默认模型 |
| `claude-sonnet-5-5` | $2.00 | $10.00 | $0.10（0.05×） | |
| `claude-haiku-5-5` | $0.10 | $0.50 | $0.01（0.1×） | 提示不超过 100K token 时的价格；超过后 $0.50 / $2.50 / 缓存读 $0.05 |

缓存写入是输入价的 1.25 倍（5 分钟 TTL）或 2 倍（1 小时 TTL）；Batch API 对所有 token 打五折，缓存读写也算在内。注意缓存读的倍率因模型而异：Opus 5.5 和 Sonnet 5.5 是 0.05×，Haiku 5.5 等多数模型是 0.1×。

你可能会问：每圈多读一点历史，为什么会「超线性」？

因为第 n 圈的输入里，装着前 n−1 圈所有的工具调用和工具结果。每圈的输入线性变长，把这些线性增长的数加起来，累计输入就是平方增长。这就像复印一本只往后加页的笔记本：每次都要从第一页复印到最后一页，复印十次，复印的总页数远不止最后那本的十倍。

类比不完全成立的地方在于缓存：缓存让「旧页」的复印费降到一两折，但页数照样在涨。

下面这张表是本章 `ledger` 脚本算的。10 圈的对话，固定前缀 8,000 token，每圈模型输出 400 token、工具返回 6,000 token；usage 是按这个形状构造的，不是真实请求，单价用 Opus 5.5：

=== "Node"

    ```text
    $ cd code/agent-node && node cost_routing/ledger.ts
    [离线 fake 用量] 模型 claude-opus-5-5，10 圈 agent 对话，usage 按固定形状构造

    圈    本圈输入   无缓存 本圈$   有缓存 本圈$
     1       8,300        0.0412         0.0495
     2      14,700        0.0668         0.0417
     3      21,100        0.0924         0.0429
     4      27,500        0.1180         0.0442
     5      33,900        0.1436         0.0455
     6      40,300        0.1692         0.0468
     7      46,700        0.1948         0.0481
     8      53,100        0.2204         0.0493
     9      59,500        0.2460         0.0506
    10      65,900        0.2796         0.0599

    第 10 圈的输入是第 1 圈的 7.9 倍；10 圈累计输入 371,000 token（如果每圈都只有第 1 圈那么长，是 83,000）

    做法                        总成本$  相对基线
    不缓存 · 不截断              1.5720     100%
    不缓存 · 截断工具结果        0.7080      45%
    缓存 · 不截断                0.4785      30%
    缓存 · 截断工具结果          0.2280      15%
    缓存，但前缀每圈都变         1.9430     124%
    ```

=== "Python"

    ```text
    $ cd code/agent && uv run python -m cost_routing.ledger
    [离线 fake 用量] 模型 claude-opus-5-5，10 圈 agent 对话，usage 按固定形状构造

    圈    本圈输入   无缓存 本圈$   有缓存 本圈$
     1       8,300        0.0412         0.0495
     2      14,700        0.0668         0.0417
     3      21,100        0.0924         0.0429
     4      27,500        0.1180         0.0442
     5      33,900        0.1436         0.0455
     6      40,300        0.1692         0.0468
     7      46,700        0.1948         0.0481
     8      53,100        0.2204         0.0493
     9      59,500        0.2460         0.0506
    10      65,900        0.2796         0.0599

    第 10 圈的输入是第 1 圈的 7.9 倍；10 圈累计输入 371,000 token（如果每圈都只有第 1 圈那么长，是 83,000）

    做法                        总成本$  相对基线
    不缓存 · 不截断              1.5720     100%
    不缓存 · 截断工具结果        0.7080      45%
    缓存 · 不截断                0.4785      30%
    缓存 · 截断工具结果          0.2280      15%
    缓存，但前缀每圈都变         1.9430     124%
    ```

读这张表能得到四个结论：

- **不开缓存时，每圈的钱跟着输入线性涨**，第 10 圈是第 1 圈的近 7 倍。圈数翻倍，总成本接近翻四倍。
- **开了缓存，每圈的钱几乎是平的**。第 1 圈反而更贵（全部按 1.25× 写入），从第 2 圈起，旧历史按 0.05× 读，只有新增的那段按 1.25× 写。
- **缓存和截断能叠加**。两样都做，只剩 15%。
- **最后一行最该警惕**：前缀每圈都变，每圈都要全量写缓存，比不开缓存还贵 24%。这正是开头那个「system 里加了当前时间」的事故。

回到主线：模型只看上下文预测下一个 token，而上下文按 token 收费。agent 每多一圈，就要为整段历史再付一次钱。所以本章所有手段，要么让旧历史读得更便宜（缓存），要么让进入历史的东西更少（截断、压缩、子 agent），要么让每个 token 的单价更低（换模型、Batch）。

## 降本手段：先拿免费的，再动有代价的

按「能省多少」和「会不会伤质量」排一下。`claude-api` skill 的成本优化指南也是这个顺序：先拿不影响质量的「免费收益」，再碰需要拿评测验证的取舍。

| 手段 | 省多少 | 风险 | 要不要评测 |
|---|---|---|---|
| 保住缓存命中 | 上表里 70%；长会话更多 | 几乎为零 | 只看 `cache_read_input_tokens` |
| 工具结果截断 / 子 agent 隔离 / 压缩 | 看工具输出多大，上表里 55% | 截掉了模型需要的信息 | 截断规则要有用例 |
| Batch API | 50% | 没人等结果的活才能用 | 不需要 |
| 降 effort、收紧 `max_tokens` | 输出侧，按任务而定 | 复杂任务变差 | 要 |
| 换小模型 / 路由 | 单价差 2～40 倍 | 最大，直接动能力上限 | 必须 |

### 缓存：agent 场景下怎么保住命中率

缓存的基础规则（前缀匹配、`tools` → `system` → `messages` 的渲染顺序、断点和最小长度）已经在[上下文是什么？token 怎么计费？](../p0-core/03-messages-and-tokens.md)讲过。agent 场景要多防几件事：

- **前缀里不放会变的东西**。时间、请求 ID、没排序的 JSON、按轮变化的任务列表，都放到最后一条消息里，或者追加一条 messages 内的 `role: "system"` 消息。[Agent 构建指南](13-agent-build-guide.md)「内核三」那张装配顺序图，就是按这个原则排的。
- **工具定义一圈都不改**。工具排在最前面，改一个字，后面所有内容都要重写。按轮增减工具、往工具描述里拼动态信息，都是在每圈重付全价。真要动态加工具，用追加式的做法：工具搜索（见[工具设计](../p2-agent-basics/12-tool-design.md)），或者 beta 的对话中途增删工具（`tool_addition` / `tool_removal`）。
- **断点放对地方**。skill 推荐的组合是：静态 system 的末尾放一个显式断点，再在请求顶层开自动缓存，让断点跟着对话增长往后移。健康的循环每圈都应该读到之前的全部、只写这一圈新增的部分。
- **别在对话中途换模型或改 effort**。缓存按模型隔离，换了模型就是冷启动；在请求顶层改 `effort` 也会让消息部分的缓存失效。
- **别回头改历史**。事后把旧工具结果删掉或改写，等于改了前缀，从改动点往后全部重写。skill 的成本指南明确说，上下文编辑（清理旧工具结果）是腾窗口的工具，不是省钱的手段，它每清一次就要重写一次缓存。

验证只看一个字段：一个已经热起来的循环里，`cache_read_input_tokens` 应该远大于 `input_tokens`，`cache_creation_input_tokens` 大约是一圈新增的量。如果每圈的写入都接近整段对话，就是有东西在破坏前缀。

### 控制上下文长度：在工具结果进门时截短

上一节说了别回头改历史。那历史太长怎么办？答案是**在它进门的时候就控制**：工具结果第一次回填之前就截短，之后它就作为稳定前缀被缓存，再也不用动。

三种手段已经各有一章，这里只说它们在账本上的位置：

- **截断工具结果**：日志只留匹配行，文件只读需要的范围。上表里一项就省了 55%。截断要留一句「已截断，共 N 行，可以用 xxx 参数取后面的部分」，否则模型会以为它看到的就是全部。
- **子 agent 隔离**：让啰嗦的探索在另一个数组里发生，主循环只收结论（[Sub Agent](../p1-tools/10-sub-agent.md)）。子 agent 自己也花钱，而且第一次请求读不到父会话的缓存，所以只有「探索产生的垃圾远多于结论」时才划算。
- **压缩**：前半段换成摘要（[上下文压缩](05-context-compaction.md)）。压缩本身是一次很大的请求，压完之后缓存要从摘要处重建。它是窗口快满时的手段，不是日常省钱的手段。

### effort、思考和 max_tokens

输出比输入贵 5 倍，思考 token 按输出计费。控制输出侧有三个参数，作用各不相同（参数名以 `claude-api` skill 为准）：

| 参数 | 位置 | 它是什么 | 模型知道吗 |
|---|---|---|---|
| `effort` | `output_config.effort`，取值 `low` / `medium` / `high` / `xhigh` / `max` | 控制思考深度和整体 token 花费 | 知道，会据此调整工具调用次数和回答长度 |
| `max_tokens` | 请求顶层 | 单次响应的硬上限，到了就截断 | 不知道，所以截断常常发生在句子中间 |
| `task_budget` | `output_config.task_budget`，beta 头 `task-budgets-2026-03-13` | 整个 agent 循环的 token 预算，最小 20,000 | 知道，服务端注入倒计时，让模型自己收尾 |

几个容易踩的点：

- **`claude-opus-5-5` 关不掉思考**。传 `thinking: {type: "disabled"}` 或 `budget_tokens` 都会返回 400，只能靠降 effort 少想一点。它的 effort 默认是 `medium`，`claude-haiku-5-5` 也是 `medium`，`claude-sonnet-5-5` 默认 `high`。默认值各不相同，所以要显式写出来。
- **别用 `max_tokens` 省钱**。它不会让模型少想，只会让回答被截断，然后你重试一次，花得更多。skill 的建议是非流式请求默认 16,000 左右，只有分类这类本来就短的任务才设到几百。
- **先在同一个模型上降 effort，再考虑换模型**。skill 的成本指南给的顺序是：先把当前模型的 effort 从高往低扫一遍，`low` 也能过评测，再往下降一档模型。一个模型意味着只有一套缓存，这一点后面讲级联时还会用到。

### Batch API：没人等的活打五折

评测集回放、批量打标签、夜里的离线摘要，这些活没有用户在等。Batch API 异步处理，所有 token 五折，缓存读写的折扣也叠加。

代价有两个：一是结果不是马上回来，回来的顺序也不固定，要按 `custom_id` 对号入座；二是每个请求只跑一次，**不能在批里跑工具循环**。所以 Batch 适合的是 agent 的「外围」：评测、离线数据处理，而不是 agent 循环本身。

### 模型路由：最后才动，也最需要证据

前面几项都不改变「谁来想」，路由改变了。它的收益最大，Opus 5.5 和 Haiku 5.5 的输入单价差 40 倍；风险也最大。

常见的有两种做法。

**规则路由**：按任务类型查表。分类、摘要、检索词改写、字段抽取交给小模型；规划和难的编码交给大模型。实现就是一张字典，问题在于「类型」不等于「难度」：同样是修 bug，有的改一行，有的要理解 SSR 和水合（hydration）。

**级联路由**：一律先用最便宜的模型，用代码校验它的输出，不过就带着同一个请求升级到下一档。

```d2
direction: down
req: "任务进来"
start: "选起点\n默认最便宜的一档\n也可以按规则表起步"
call: "调当前档模型"
check: "代码校验\n测试 / schema / 红线规则" {shape: diamond}
done: "返回结果\n记下用了哪几档"
higher: "还有更高一档？" {shape: diamond}
escalate: "升级到下一档\n同一个请求重发"
fail: "放弃：标记失败\n交给人或报错"
req -> start
start -> call
call -> check
check -> done: 通过
check -> higher: 不通过
higher -> escalate: 有
higher -> fail: 没有
escalate -> call
```

图注：级联的成本 = 成功那一档的钱 + 所有失败尝试的钱。它省不省钱，取决于两件事：便宜模型在你的流量里能直接通过多少，以及你有没有一个**不用调模型**就能判对错的校验。

你可能会问：没有代码能判的校验，让小模型自己说「我有把握」行不行？我不建议。让模型自评置信度，等于要它自己认出自己不会的题，而这恰恰是它缺的那部分判断力。

skill 的成本指南在讲 advisor（小模型遇到难题时请教大模型）时也提到同一个问题：执行者什么时候该请教，是整个方案里最脆弱的一环。能落到测试、schema、正则红线上的校验，才适合做级联的闸门。

级联还有两个隐藏成本：

- **缓存不共享**。每一档模型各有各的缓存，升级之后，长前缀要在新模型上重新按写入价付一遍。所以级联适合短的单次请求，不适合在一段长对话中途换模型。skill 的原话是「在对话之间换，不要在对话里面换」。
- **延迟翻倍**。失败的那一次已经花掉了一个来回的时间。

所以在搭级联之前，skill 建议先测一个更简单的对照组：**只用最强的模型，但把 effort 降下来**。新模型在低 effort 下往往不输上一代的高 effort，而且只有一套缓存。

还有一种「同模型级联」：先用低 effort 跑，只把校验失败的那些用高 effort 重跑。skill 引用的 Anthropic 编码实验里，这样做的通过率和全部用高 effort 持平甚至略高，花费略多于一半（失败的那次低 effort 尝试也算在内）。

## 预算护栏：软上限收口，硬上限止损，按租户记账

降本手段是让平均成本变低，预算护栏管的是尾部：一个死循环的任务，不能把一个月的额度烧完。

[Agent 构建指南](13-agent-build-guide.md)「内核一」讲过三道上限：迭代次数、软预算、硬超时。那里的软预算按时间算，这里把它换成钱，逻辑完全一样：

```d2
direction: down
loop: "准备开新一圈"
est: "估下一圈最坏花多少\n上一圈输入 + 新工具结果全按未缓存价\n输出顶满 max_tokens"
hard: "已花 + 最坏 > 硬上限？" {shape: diamond}
soft: "已花 ≥ 软上限？" {shape: diamond}
stop: "停：不再调模型\n返回已有结果 · budget_hard"
wrap: "收口：tool_choice=none 再调一次\n让模型总结做到哪了 · budget_soft"
go: "正常调模型\n按 usage 记账到租户"
loop -> est
est -> hard
hard -> stop: 是
hard -> soft: 否
soft -> wrap: 是
soft -> go: 否
go -> loop: 有工具调用
```

图注：先判硬上限再判软上限。硬上限用「最坏情况」估，宁可提前停；软上限只拦「再开一圈」，所以实际花费一定会超过软上限，超多少取决于最后一圈有多大。

几条做法：

- **两个上限之间留够一圈的余量**。软上限 = 硬上限 − 一圈最坏花费 − 收口那次的花费。下面的演示里软上限 $0.30、硬上限 $0.80：过了软上限之后还跑完了收口那次，实际花了 $0.527，仍在硬上限以内。两个上限要是靠得太近，收口那次就会撞上硬上限，连总结都拿不到。
- **按租户记账**。每条 usage 记到用户、团队或租户名下，预算按租户判，一个团队的失控任务不应该吃掉别人的额度。多租户 SaaS 还要按租户导出账单，所以计量最好和可观测性放在一起：[给 Agent 加上可观测性](../p2-agent-basics/08-agent-observability.md)里每个 chat span 已经带着 token 数，再挂上租户 ID 和算出的金额就行。
- **客户端算的是估计，账单以平台为准**。价格表会变，合作方渠道另有价格。计量模块的价格表要标来源和日期，碰到不认识的模型就报错，不能悄悄按 0 元记。
- **API 侧也有硬兜底**。workspace 可以设花费上限，它管的是整个 workspace，不管单个任务，是最后一道闸。

## 路由怎么证明没变差

规则表里改一行「`extract` → Haiku」，线上行为就变了，而且不经过任何代码发布。所以路由规则和 prompt、模型版本一样，是一个**会改变行为的入口**，要挂评测门禁。[Agent 评测实践指南](14-agent-eval-guide.md)讲过门禁怎么搭，这里只补成本这一维：

1. **同一个评测集，路由前后各跑一遍**，每条跑多次，配对比较通过率。只看总通过率不够，要按任务类型切开看，下一节的演示会说明为什么。
2. **比「每个做完的任务花多少钱」**。一次请求便宜，但要多跑几圈、多重试几次才做完，就不算便宜。级联里失败的尝试也要算进去。
3. **看最难的那一成**。skill 的成本指南专门提醒：在普通任务上所有模型看起来都差不多，最便宜的最好；账单和事故都由便宜模型做不出来的那部分任务决定。
4. **上线后按路由结果切片看**。线上抽样评分按「用了哪个模型、升没升级」切开，升级率突然变高，通常说明流量变难了，或者小模型那一档退化了。

## 动手：计价器、路由器和预算

代码在 `code/agent-node/cost_routing/`（Python 版 `code/agent/cost_routing/`），全部离线，不需要 API key：

| 文件 | 内容 |
|---|---|
| `meter.ts` / `meter.py` | 价格表常量、`costUsd`、`CostMeter`（按模型和租户汇总）、`Budget` |
| `ledger.ts` / `ledger.py` | 上面那张 10 圈对比表 |
| `router.ts` / `router.py` | 规则路由、级联路由，以及五种策略的对比 |
| `budget.ts` / `budget.py` | 带金额预算的 agent 循环 |

### 先看路由的结果

八类任务，每类带一个每天调用量（分类 3,000 次，难的编码 20 次）。哪个模型在哪个任务上答对，是 fake client 按脚本给的，**不代表真实模型的能力**，只用来看清账怎么算：

=== "Node"

    ```text
    $ node cost_routing/router.ts
    [离线 fake 模型] 级联路由逐条（任务 / 类型 / 每天调用量 / 依次用过的模型）：
      t1 classify       3,000  haiku                   ✔
      t2 classify       3,000  haiku                   ✔
      t3 summarize        800  haiku                   ✔
      t4 rewrite_query  1,500  haiku                   ✔
      t5 extract          400  haiku → sonnet          ✔
      t6 code              60  haiku → sonnet          ✔
      t7 plan              20  haiku → sonnet          ✔
      t8 code              20  haiku → sonnet → opus   ✔

    策略             任务通过  按调用量通过率    每天$  相对全 Opus  升级率
    全用 Opus             8/8          100.0%    23.28         100%    0.0%
    全用 Haiku            4/8           94.3%     0.58           3%    0.0%
    规则路由              6/8           95.2%     2.03           9%    0.0%
    级联路由              8/8          100.0%     3.70          16%    5.7%
    规则起步+级联         8/8          100.0%     3.79          16%    4.8%
    ```

=== "Python"

    ```text
    $ uv run python -m cost_routing.router
    [离线 fake 模型] 级联路由逐条（任务 / 类型 / 每天调用量 / 依次用过的模型）：
      t1 classify       3,000  haiku                   ✔
      t2 classify       3,000  haiku                   ✔
      t3 summarize        800  haiku                   ✔
      t4 rewrite_query  1,500  haiku                   ✔
      t5 extract          400  haiku → sonnet          ✔
      t6 code              60  haiku → sonnet          ✔
      t7 plan              20  haiku → sonnet          ✔
      t8 code              20  haiku → sonnet → opus   ✔

    策略             任务通过  按调用量通过率    每天$  相对全 Opus  升级率
    全用 Opus             8/8          100.0%    23.28         100%    0.0%
    全用 Haiku            4/8           94.3%     0.58           3%    0.0%
    规则路由              6/8           95.2%     2.03           9%    0.0%
    级联路由              8/8          100.0%     3.70          16%    5.7%
    规则起步+级联         8/8          100.0%     3.79          16%    4.8%
    ```

最值得看的是「全用 Haiku」那一行：按调用量算，通过率 94.3%，看起来只差一点；按任务类型看，8 类里挂了 4 类，规划和编码全军覆没。分类请求量大，把难任务的失败稀释掉了。**这就是为什么路由评测一定要按任务类型切开看。**

「规则路由」挂了两类：`extract` 被规则判给了 Haiku，而 Haiku 抽出来的行号是字符串；t8 和 t6 同属 `code`，规则只能一视同仁地给 Sonnet，难的那条就判轻了。级联用 5.7% 的升级率把它们都兜住了，成本是全 Opus 的 16%。

「规则起步 + 级联」在这组数据里并没有更便宜：规则把 `plan` 直接派给 Opus，而 Sonnet 其实就够了。规则表里的难度是人拍脑袋写的，级联的数据会告诉你哪条规则写高了、哪条写低了。

### 计价器

核心就是一行公式，四种 token 各乘各的单价：

=== "Node"

    ```ts
    export function costUsd(model: string, usage: UsageLike | Tokens, { batch = false } = {}): number {
      const p = PRICES[model];
      if (!p) throw new Error(`价格表里没有 ${model}：宁可报错，也别按 0 元记账`);
      const t = normalizeUsage(usage);
      const long = p.longThreshold !== undefined && promptOf(t) > p.longThreshold;
      const [inp, out, read] = long ? [p.longInput!, p.longOutput!, p.longCacheRead!] : [p.input, p.output, p.cacheRead];
      const usd =
        (t.input * inp + t.write5m * inp * CACHE_WRITE_5M + t.write1h * inp * CACHE_WRITE_1H + t.cacheRead * read + t.output * out) /
        1_000_000;
      return batch ? usd * BATCH_DISCOUNT : usd;
    }
    ```

=== "Python"

    ```python
    def cost_usd(model: str, usage: Any, *, batch: bool = False) -> float:
        if model not in PRICES:
            raise KeyError(f"价格表里没有 {model}：宁可报错，也别按 0 元记账")
        p = PRICES[model]
        t = usage if isinstance(usage, Tokens) else normalize_usage(usage)
        long = p.long_threshold is not None and t.prompt > p.long_threshold
        inp, out, read = (p.long_input, p.long_output, p.long_cache_read) if long else (p.input, p.output, p.cache_read)
        usd = (
            t.input * inp
            + t.write_5m * inp * CACHE_WRITE_5M
            + t.write_1h * inp * CACHE_WRITE_1H
            + t.cache_read * read
            + t.output * out
        ) / 1_000_000
        return usd * BATCH_DISCOUNT if batch else usd
    ```

两个细节。一是 `normalizeUsage`：SDK 的 usage 里，没开缓存时 `cache_*` 字段是 `null`，要当 0；有 `cache_creation` 拆分时按 5 分钟和 1 小时分别计价，没有就全按 5 分钟算。二是 Haiku 5.5 的长提示价：判断用的是三种输入之和，不只是 `input_tokens`，一个几乎全部命中缓存的长对话照样会跨过 100K 的线。

### 级联

=== "Node"

    ```ts
    for (const t of tasks) {
      const o: Outcome = { task: t, attempts: [], passed: false, usd: 0 };
      const first = start ? ladder.indexOf(start(t)) : 0;
      for (const m of ladder.slice(first)) {
        o.attempts.push(m);
        const [answer, usd] = await ask(client, m, t, meter, tenant);
        o.usd += usd; // 失败的那几次也照算
        if (t.check(answer)) {
          o.passed = true;
          break;
        }
      }
      out.push(o);
    }
    ```

=== "Python"

    ```python
    for t in tasks:
        o = Outcome(t)
        first = ladder.index(start(t)) if start else 0
        for m in ladder[first:]:
            o.attempts.append(m)
            answer, usd = _ask(client, m, t, meter, tenant)
            o.usd += usd  # 失败的那几次也照算
            if t.check(answer):
                o.passed = True
                break
        out.append(o)
    ```

说穿了就是一个 `for` 循环套一个 `break`。真正值钱的是 `t.check`：演示里它是 schema 校验和几条规则，换到真实项目里，编码任务应该是「把补丁打上去跑测试」，抽取任务应该是 JSON Schema 校验加业务规则。

### 预算

=== "Node"

    ```text
    $ node cost_routing/budget.ts
    [离线 fake 模型] 软上限 $0.3，硬上限 $0.8（单个租户、单次任务）

    —— 租户 team-a：模型一直想再搜一次 ——
      [计费] team-a 本次 $0.0840，累计 $0.0840
    ⏺ search_logs({"query":"q0"})
      [计费] team-a 本次 $0.1160，累计 $0.2000
    ⏺ search_logs({"query":"q1"})
      [计费] team-a 本次 $0.1480，累计 $0.3480
    ⏺ search_logs({"query":"q2"})
    ⊘ 已花 $0.3480，到了软上限 $0.3：禁用工具，再调最后一次收口
      [计费] team-a 本次 $0.1790，累计 $0.5270
      结束原因 budget_soft，3 圈，花费 $0.5270
      回答：已确认：依赖安装阶段缓存全部未命中，占了大部分耗时。还没查清缓存为什么失效，建议对比两次构建的 lockfile。

    —— 租户 team-b：两圈就答完 ——
      [计费] team-b 本次 $0.0840，累计 $0.0840
    ⏺ search_logs({"query":"q0"})
      [计费] team-b 本次 $0.1150，累计 $0.1990
      结束原因 end_turn，2 圈，花费 $0.1990

    按租户汇总： { 'team-a': 0.527, 'team-b': 0.199 }
    ```

=== "Python"

    ```text
    $ uv run python -m cost_routing.budget
    [离线 fake 模型] 软上限 $0.3，硬上限 $0.8（单个租户、单次任务）

    —— 租户 team-a：模型一直想再搜一次 ——
      [计费] team-a 本次 $0.0840，累计 $0.0840
    ⏺ search_logs({"query": "q0"})
      [计费] team-a 本次 $0.1160，累计 $0.2000
    ⏺ search_logs({"query": "q1"})
      [计费] team-a 本次 $0.1480，累计 $0.3480
    ⏺ search_logs({"query": "q2"})
    ⊘ 已花 $0.3480，到了软上限 $0.3：禁用工具，再调最后一次收口
      [计费] team-a 本次 $0.1790，累计 $0.5270
      结束原因 budget_soft，3 圈，花费 $0.5270
      回答：已确认：依赖安装阶段缓存全部未命中，占了大部分耗时。还没查清缓存为什么失效，建议对比两次构建的 lockfile。

    —— 租户 team-b：两圈就答完 ——
      [计费] team-b 本次 $0.0840，累计 $0.0840
    ⏺ search_logs({"query": "q0"})
      [计费] team-b 本次 $0.1150，累计 $0.1990
      结束原因 end_turn，2 圈，花费 $0.1990

    按租户汇总： {'team-a': 0.527, 'team-b': 0.199}
    ```

这里的 usage 同样是构造的：每圈输入涨 8,000 token，没开缓存，所以每圈越来越贵。team-a 在第 3 圈结束时过了软上限，循环不再开新一圈，而是禁用工具再调一次，拿到一段「做到哪了」的总结。收口那次花了 $0.179，最终 $0.527，比软上限多出 76%，这就是前面说的「两个上限之间要留一圈余量」。

判定写在循环开头：

=== "Node"

    ```ts
    const spent = meter.spent(tenant);
    const verdict = budget.check(spent, worstCaseNextUsd(model, last, MAX_TOKENS, pendingInput));
    if (verdict === "hard") {
      log(`⊘ 下一圈最坏情况会超过硬上限 $${budget.hardUsd}，不再调用模型`);
      return { answer: lastAnswer || "（预算用尽，任务未完成）", stop: "budget_hard", turns: turn, usd: spent };
    }
    if (verdict === "soft") {
      // ……把收口提示并进最后一条 user 消息，tool_choice: { type: "none" } 再调一次
    }
    ```

=== "Python"

    ```python
    spent = meter.spent(tenant)
    verdict = budget.check(spent, worst_case_next_usd(model, last, MAX_TOKENS, pending_input))
    if verdict == "hard":
        log(f"⊘ 下一圈最坏情况会超过硬上限 ${budget.hard_usd}，不再调用模型")
        return RunResult(last_answer or "（预算用尽，任务未完成）", "budget_hard", turn, spent)
    if verdict == "soft":
        ...  # 把收口提示并进最后一条 user 消息，tool_choice={"type": "none"} 再调一次
    ```

收口为什么用 `tool_choice: none` 而不是去掉 `tools`，[Agent 构建指南](13-agent-build-guide.md)的「动手」一节讲过：去掉工具定义会让整段缓存失效。

### 测试

=== "Node"

    ```text
    $ node --test cost_routing/*.test.ts      # 输出节选
    ℹ tests 25
    ℹ pass 25
    ℹ fail 0
    ```

=== "Python"

    ```text
    $ uv run pytest cost_routing -q           # 输出节选，耗时每次不同
    .........................                                                [100%]
    25 passed
    ```

覆盖四块：计价（纯输入输出、缓存写读、TTL 拆分、`null` 字段、Batch 五折、Haiku 长提示价、未知模型报错、按租户汇总）；路由决策（规则表、校验器、规则把难任务判轻）；级联（第一档通过就停、逐档升级且失败尝试计费、按规则起步、梯子用完放弃）；预算（正常结束、软上限收口且禁用工具、硬上限不再调用、租户之间互不影响）。

## 对照你的环境

- **`/usage` 就是 Claude Code 自带的 CostMeter**。`/cost` 现在是它的别名。Session 一栏按标价从 token 数估算金额，并按模型列出输入、输出、缓存读、缓存写，和本章 `CostMeter.by("model")` 是同一张表。v2.1.251 起还多了一行 `Prompt cache (main)`：命中占比、未命中次数，能判断时还会给出可能的原因（比如工具定义变了）。上面「保住命中率」那一节要你盯的指标，它已经替你算好了，只是只覆盖主对话，不含子 agent。
- **你的 statusline 已经在显示花费**。`statusline.sh` 读的是 Claude Code 传进来的 `.cost.total_cost_usd`，和 `/usage` 是同一个数。它按标价估算，订阅用户的实际计费方式不同，所以把它当趋势看，不要当账单看。
- **`/model` 里的 `opusplan` 是一条内置的规则路由**：plan 模式用 `opus`，执行时换成 `sonnet`。它按「阶段」路由，正好是本章说的「规划用大模型，执行用中模型」。
- **子 agent 的 `model` 字段是逐个子 agent 的路由表**。frontmatter 里可以写 `sonnet`、`opus`、`haiku`、`fable`、完整模型 ID 或 `inherit`。不写时，Claude Code 按顺序取：调用时传的 `model` 参数 → 定义里的 `model` → 环境变量 `CLAUDE_CODE_SUBAGENT_MODEL` → 主对话的模型。你 `~/.claude/agents/` 下那个只负责调 codex CLI 的审查子 agent 没写 `model`，所以它跟着主对话走；它的活主要是跑命令、转述结果，属于官方成本文档说的「简单子 agent 任务可以指定 `model: haiku`」那一类。改之前按上一节的说法，拿几次真实审查对比一下转述质量。
- **后台功能用的是 haiku 那一档**。`ANTHROPIC_DEFAULT_HAIKU_MODEL` 的说明是「`haiku` 别名，以及后台功能使用的模型」。文档没有逐条列出是哪些后台功能，这里不展开。
- **`--max-budget-usd` 是 Claude Code 版的硬上限**。只在 `-p` 模式下生效，按客户端估算的花费判断，子 agent 的花费也算进去；文档特别说明花费可能越过上限，要留余量。这和本章预算演示里软上限被越过是同一个现象。`--max-turns` 则对应迭代上限。
- **`/effort`** 调的就是本章的 `effort`。官方成本文档还提醒，在 Claude Code 里 Opus 5.5、Sonnet 5.5、Haiku 5.5 和 Fable 系列的思考关不掉，要省思考 token 只能降 effort。直接调 API 时略有不同：Haiku 5.5 在 effort 不高于 `high` 时可以传 `{type: "disabled"}`；Sonnet 5.5 传 `disabled` 会 400，要关思考得改传 `{type: "between_tools"}`（同样只在 effort 不高于 `high` 时可用）；Opus 5.5 在任何 effort 下都关不掉。

## 回到开头的问题

任务没变，账单翻了三倍，该从哪查？

先按任务而不是按请求看账：圈数变没变，每圈的 `cache_read_input_tokens` 和 `cache_creation_input_tokens` 是什么比例。写入占比突然变高，就去找是谁动了前缀；输入总量涨得快，就去找哪个工具结果没截断；圈数涨了，就去看预算和停止条件。这三样都不用换模型。

真要换模型，就把路由规则当成一次上线：同一个评测集，按任务类型切开，比每个做完的任务花多少钱，升级率和最难那一成的通过率都要过门禁。

回到主线：上下文既决定模型能做对什么，也决定每一圈花多少钱。本章的手段都在回答同一个问题：怎样让模型看到同样有用的上下文，又少为它付钱。

## 常见坑

- **按单次请求比价**。小模型单价便宜，但多跑几圈、多重试几次，每个任务反而更贵。级联里失败的尝试也要记账。
- **只看总通过率**。高频的简单任务会把难任务的失败稀释掉，「全用 Haiku」在演示里按调用量算还有 94%。评测按任务类型切开看。
- **事后清理旧工具结果来省钱**。改历史就是改前缀，每清一次重写一次缓存。截断要在结果第一次进门时做。
- **对话中途换模型**。缓存按模型隔离，换过去就是冷启动；思考块也可能读不了。路由在对话之间做，不在对话中间做。
- **用 `max_tokens` 控成本**。它只截断，不让模型少想，截断后的重试反而更贵。控成本用 effort，控整个循环用预算。

## 练习

**1.** 把 `ledger` 里的模型从 Opus 5.5 换成 Haiku 5.5，先手算「缓存 · 不截断」相对基线会变成多少（提示：Haiku 5.5 的缓存读价是输入价的 0.1 倍，而 Opus 5.5 是 0.05 倍；本例每圈输入不到 100K，不触发 Haiku 的长提示价），再跑脚本核对。

<details>
<summary>提示</summary>

只改 `MODEL` 一个常量。绝对金额会缩到原来的约 1/40，但比例才是重点：基线和「前缀每圈都变」两行的比例不变，因为它们不涉及缓存读；变的是读缓存的几行。读价相对输入价翻了一倍，「缓存 · 不截断」会从 30% 升到 34% 左右，「缓存 · 截断工具结果」从 15% 升到 16% 左右。这说明缓存读的倍率越低，「保住命中率」越值钱。换成 Sonnet 5.5 则比例和 Opus 5.5 完全一样，因为两者都是 0.05×。

</details>

**2.** 给 `router` 加一种「同模型级联」：梯子不再是三个模型，而是同一个模型的 `(model, effort)` 组合，例如先 `low` 再 `high`。fake client 根据请求里的 `output_config.effort` 决定答对还是答错，然后把它加进对比表。

<details>
<summary>提示</summary>

`LADDER` 改成元组列表，`ask` 多传一个 `output_config: {effort}`。fake 的 `respond` 读 `params.output_config.effort`；计价不用改，effort 的影响体现在 `output_tokens` 上，可以让 `high` 的输出 token 是 `low` 的几倍。测试照 `test_cascade_escalates_until_check_passes_and_bills_failed_attempts` 写一条：断言两次调用的 effort 依次是 `low`、`high`，模型不变。表里新增的一行要能说明：这种级联的缓存在同一个模型上，代价是多了一次低 effort 的尝试。

</details>

**3.** 开放题：给你 webapp 里一个用到 LLM 的功能（或者你自己的一组子 agent）设计一套路由方案和门禁。写清楚：哪些任务类型走小模型，校验用什么代码判，评测集按什么切片，什么情况下拦截上线。

<details>
<summary>提示</summary>

先按调用量和单次花费排一下，钱集中在哪几类任务上，就从哪几类开始，别平均用力。每类任务先问「有没有不用调模型就能判对错的校验」：有，才适合级联；没有，就只能用规则路由加离线评测。门禁至少包含三条：每个任务类型单独的通过率不下降（不是总通过率）；每个做完的任务的平均花费下降；最难的那一成用例单独看。上线后盯升级率，它突然变化时要能报警。

</details>

## 延伸阅读

- [Claude API：定价](https://platform.claude.com/docs/en/about-claude/pricing)（本章的单价以它为准，价格会变）
- [Claude API：在成本和智能之间取舍](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence)（缓存、Batch、effort、模型选择的实测对比）
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) · [Batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
- [Claude Code：Manage costs effectively](https://code.claude.com/docs/en/costs) · [Model configuration](https://code.claude.com/docs/en/model-config) · [Subagents：Choose a model](https://code.claude.com/docs/en/sub-agents)
- 本库：上一章 [RAG 评测](16-rag-eval.md)；相关章 [上下文是什么？token 怎么计费？](../p0-core/03-messages-and-tokens.md)、[上下文压缩](05-context-compaction.md)、[Sub Agent](../p1-tools/10-sub-agent.md)、[给 Agent 加上可观测性](../p2-agent-basics/08-agent-observability.md)、[Agent 构建指南](13-agent-build-guide.md)、[Agent 评测实践指南](14-agent-eval-guide.md)
- 下一部分：[第 4 部分 · 手搓 mini Claude Code](../p4-mini-cc/01-cli.md)，把拆到的能力一章一章加进自己的 Agent
