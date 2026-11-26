# 缓存：减少回源，但别把缓存当成事实来源

> 本章为独立原创；备考范围见[后端面试导读](00-guide.md)。

**先按业务定允许读旧的范围，再决定缓存什么；缓存挂了，不能让所有请求无上限地打向数据库。**

## P0：读时回填，写提交后失效，但两步不是原子的

**首问：怎么给订单列表加缓存？** 用旁路缓存（Cache-Aside）：先读缓存，未命中再查数据库并设置 TTL；写入先让数据库提交，再失效相关缓存。结果按租户、用户、查询条件隔离，按权限校验；只缓存明确允许短暂读旧的数据。下单成功后的关键事实走主库等能满足一致性约束的读路径。库存扣减不要依据缓存值。

**追问：先提交再删缓存就一致了吗？** 不。删除可能失败，读请求也可能把在提交前读到的旧值回填进去。把失效做成可重试任务、配置 TTL 和监控能降低长期读旧风险，不等于强一致；如果回源读的是副本，复制延迟也可能导致旧值回填。不能读旧的路径绕缓存；如果要版本化缓存，必须说明如何在写入时原子校验版本、版本栅栏由谁维护。

### 动手：用四步重现旧值回填

将下面的 JavaScript 粘到 `node` REPL。它只模拟事件先后，不是 Redis 压测：

```js
let db = 'pending';
const cache = new Map();
const slowRead = db;                  // A: miss 后读到旧值，尚未回填
db = 'confirmed';                    // B: 提交更新
cache.delete('order');                // B: 失效
cache.set('order', slowRead);         // A: 回填旧值
console.log(db, cache.get('order'));
```

输出：`confirmed pending`。逐行解释这次读旧，你就能说明为什么「删成功了」不是强一致承诺。

## P0/P1：三种未命中形态，需要不同的保护

| 场景 | 观察信号 | 优先措施与代价 |
|---|---|---|
| 击穿：单个热 key 失效 | 一个 key 的并发 miss 暴涨 | 合并同 key 的回源请求；进程内合并不覆盖多实例。允许读旧时可后台刷新，仍需全局回源上限。 |
| 穿透：大量查询不存在的键 | 无结果的请求变多，key 不一定重复 | 先限制和校验输入；短 TTL 的负缓存只对重复 miss 有效，还要处理新写入后的失效。 |
| 雪崩：大量 key 同时失效，或缓存整体故障 | 全局命中率下降，DB 连接等待／拒绝上升 | TTL 加抖动能打散过期，不能修复 Redis 宕机；缓存失败后给 DB 回源限并发，优先保写入和关键读。 |

验证不能只看命中率。一起看回源 QPS、DB 池等待、端到端 P99、失效失败／重试量，以及**业务实际读旧时长**。

## P1：Redis key 不见了，先区分过期、淘汰与重启恢复

TTL 是数据的新鲜度策略，淘汰是内存压力下的空间策略，不是同一件事。先对照 `expired_keys`、`evicted_keys`、内存水位和实例重启事件；不要只看到 miss 就延长 TTL。RDB 是时间点快照，AOF 记录写操作用于恢复；两者都不能让缓存和数据库的双写变成原子操作。面试优先答清是否允许丢缓存，以及重建期间如何限制回源。

依据：[Redis：Key eviction](https://redis.io/docs/latest/develop/reference/eviction/)、[Redis：Persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)。

## 练习：说清你愿意牺牲多少新鲜度

1. 某热 key 平时 2,000 req/s，每次过期就拉高数据库 P99。你怎么验证是击穿？

    <details><summary>自检</summary>

    对齐单 key 的失效时间、并发 miss 和 DB 池等待；压测单 key 失效时的实际回源并发（覆盖多个实例），观察合并或限流后的读延迟。

    </details>

2. 产品要求查订单状态不能读旧，但列表允许 30 秒旧数据。怎么拆读路径？

    <details><summary>自检</summary>

    详情关键状态走满足约束的读路径；列表缓存。30 秒是业务目标，不等于设 30 秒 TTL 就达标：还要考虑副本读旧、慢回填、客户端缓存并测量端到端新鲜度。

    </details>

延伸阅读：[Microsoft Azure Architecture Center：Cache-Aside](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside)。
