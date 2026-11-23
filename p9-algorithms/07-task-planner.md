# 综合项目：用拓扑排序和堆规划任务依赖

> [算法路线](00-guide.md) · 独立原创
>
> **一句话：**图决定任务能不能出队，堆决定已就绪的任务谁先出队。把两条规则分开，高优先级任务就不会跳过依赖。

## 先跑规划结果：优先级再高，也要等前置任务

```bash
node code/algorithm-node/examples/07-planner.ts
```

```text
plan: {"order":["build","lint","test","deploy","docs"],"blocked":[]}
cycle: {"order":["free"],"blocked":["a","b","report"]}
```

第一组里，`deploy` 优先级最高，却要等 `build` 和 `test`；`build` 和 `lint` 同优先级，按任务 ID 的 JavaScript 字符串比较次序打破平局。第二组里，`a`、`b` 成环，依赖 `b` 的 `report` 也被卡住，但独立任务 `free` 仍能进入规划结果。

## 用入度维护资格，用堆维护已就绪任务的顺序

```d2
direction: down
input: 任务列表：id、priority、needs
index: 校验并建立入度与后继索引
ready: 优先队列：只收入度为 0 的任务
picked: 取堆顶加入规划，减少后继入度
result: 返回规划顺序与阻塞任务
input -> index: 每个依赖建一条从前置到后继的边
index -> ready: 初始无未满足依赖的任务入堆
ready -> picked: 堆非空，按优先级取一个
picked -> ready: 后继入度刚变为 0 时入堆；再取下一项
ready -> result: 堆空，入度仍大于 0 即阻塞
```

[核心实现 `planTasks`](../code/algorithm-node/src/planner.ts)采用 Kahn 拓扑排序：`remaining[id]` 记录还没进入计划的直接前置数。每次安排一个任务，只减少依赖它的任务计数；变为 `0` 才推入[二叉堆](../code/algorithm-node/src/ordering.ts)。每个任务最多入堆一次，每条边最多用于一次减计数。按平均常数哈希查找、常见比较排序成本计，最坏时间 `O(V+E+V log(V+1))`（包括排序阻塞列表），额外空间 `O(V+E)`。

**输出契约：**合法图中的 `order` 一定不会违反前置依赖；堆空后若仍有任务没安排，就存在环。`blocked` 既可能含环成员，也含环的下游，不是精确环成员名单。重复 ID、未知依赖、重复依赖和非有限优先级会报错，不会混进 `blocked`。

## 用测试分三步把能力加起来

| 增量 | 先写的验收断言 |
|---|---|
| 依赖合法 | `deploy` 必须排在 `build` 和 `test` 后，哪怕优先级最高。 |
| 就绪时有序 | 同优先级按 ID；把输入反过来，结果仍相同。 |
| 错误和阻塞分开 | 自环与下游进 `blocked`，独立任务仍能安排；未知依赖抛错。 |

在仓库根目录运行 `npm --prefix code/algorithm-node test`，再去[测试文件](../code/algorithm-node/tests/algorithms.test.ts)补自己的边界。这个项目只计算静态、单步选择的合法顺序，不执行任务，不处理并发、失败重试，也不声称得到最短总工期。

## 练习：把「能排」和「能执行」分开

1. 增加两个可同时就绪的高优先级任务，写断言验证只在同一批**当前就绪**任务里做比较。

<details>
<summary>提示</summary>

让另一个更高优先级任务依赖其中一个。依赖解除前不能选它；解除后应重新与剩余就绪任务比较。

</details>

2. 如果改成两个 worker 并行，什么时候才能给后继减计数？

<details>
<summary>提示</summary>

静态规划里「入计划」就能解锁，真实执行时要等前置成功完成。分开记录 `ready`、`running` 和 `completed`，再明确失败是否阻断后继；不要直接把静态顺序当作执行状态。

</details>

回顾：[树与图](04-tree-and-graph.md)教你表达关系和前沿，[排序与堆](06-sorting-and-heap.md)教你不必每次全量排序就能找到下一位。
