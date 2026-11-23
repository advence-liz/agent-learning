# 算法导读：先说清状态，再背模板

> **一句话：**先把暴力解写明白，再用输入条件减少工作量；每学一种方法，都要能解释它维护了什么、为什么没漏解、怎样用反例验证。课程使用 TypeScript，不需要先学 Agent，也没有模型调用。

- [按专题学习](#narrow)：从复杂度与不变量开始，再走容器、树图、搜索、动态规划和数学。
- [核对参考覆盖](#traverse)：按原站公开目录的大类和路线图列出对应入口。
- [以练习和项目验收](#build)：先小输入对拍，再把图和优先队列拼成一个规划器。

<a id="narrow"></a>

## 先练分析，再把同一思路用到不同的数据结构

| 专题 | 学完应该能做什么 |
|---|---|
| **准备与解题框架** | 用[复杂度](08-complexity.md)比较两种方案，用[不变量与对拍](09-proof-and-oracles.md)解释正确性，用[递归与显式栈](10-recursion.md)安排处理顺序。 |
| **数组、容器与有序结构** | 从[查表与前缀和](01-arrays-and-hash.md)走到[差分](11-difference-array.md)、[二维前缀和](12-matrix-prefix.md)、[树状数组与线段树](13-range-structures.md)，并用[指针与二分](02-pointers-and-search.md)、[单调结构](14-monotonic.md)、[排序与堆](06-sorting-and-heap.md)减少扫描。 |
| **树、图与路径** | 从[DFS/BFS](04-tree-and-graph.md)走到[搜索树](19-bst.md)、[字典树](20-trie.md)、[并查集](22-graph-connectivity.md)、[最短路](23-dijkstra.md)、[生成树](24-mst.md)和[有向图结构](25-directed-graphs.md)。 |
| **搜索、分治与贪心** | 判断应该[回溯去重](26-backtracking-duplicates.md)、[在隐式图上搜索](27-state-search.md)、[分治合并](28-divide-and-conquer.md)，还是能[证明一个局部选择安全](29-intervals-and-greedy.md)。 |
| **动态规划专项** | 写清[状态与顺序](30-dp-method.md)，从[背包](31-knapsack.md)、[序列](32-sequence-dp.md)、[字符串](33-string-dp.md)延伸到[区间](34-interval-dp.md)、[树和状态机](35-tree-and-state-dp.md)、[数位和状态压缩](36-digit-and-bitmask-dp.md)。 |
| **字符串、数学与随机化** | 用 [KMP](37-kmp.md)复用匹配结果，用[数论](38-number-theory.md)、[位运算和组合](39-bit-and-combinatorics.md)、[随机抽样](40-randomization.md)推导成本与概率。 |
| **综合练习与复盘** | 按[阶段关卡](41-practice-checkpoints.md)检查反例，再做[依赖规划](07-task-planner.md)、[日程查询](68-scheduling-project.md)、[路线查询](69-routing-project.md)、[表达式解析](77-parser-project.md)和[多路有序流](78-stream-feed-project.md)。 |

**系统学**：按侧栏专题走，每节先预测小输入输出，再手算或跑实现。**面试复习**：先做数组与指针，再做树图、回溯和高频 DP，最后按目标岗位选补高级结构和数学。复盘固定问四句：输入前提是什么？维护什么？为什么合法？什么反例会击穿错法？

<a id="traverse"></a>

## 按原站公开主题核对，不把文章数当作覆盖率

参考 labuladong 的[算法首页](https://labuladong.online/zh/algo/home/)与[公开路线图](https://labuladong.online/zh/roadmap/algo/)。原站内容归原作者；本课程正文、练习和代码独立编写，不转载未获许可的正文。

| 公开目录大类 | 本站可核对的覆盖 |
|---|---|
| 准备工作、核心解题框架 | 复杂度与对拍；[数组双指针、滑动窗口、二分](02-pointers-and-search.md)；[链表快慢指针](15-linked-list-patterns.md)。 |
| 经典数据结构与算法 | 数组、前缀和、差分、二维数组、哈希、链表、栈队列、堆和排序；二叉树递归/层序、BST、Trie、图与最短路。 |
| 暴力搜索相关 | [DFS、BFS](04-tree-and-graph.md)、[回溯](26-backtracking-duplicates.md)、[双向与多源搜索](27-state-search.md)；[分治](28-divide-and-conquer.md)和[贪心](29-intervals-and-greedy.md)独立讲适用条件。 |
| 动态规划相关 | [方法和常用模型](30-dp-method.md)，以及背包、序列与前缀、区间、树、状态机、数位与状态压缩。 |
| 数学运算技巧 | [最大公约数、筛法和快速幂](38-number-theory.md)，[位运算与组合计数](39-bit-and-combinatorics.md)，[洗牌与抽样](40-randomization.md)。 |

这张表对照的是公开大类和路线图，不是付费文章与题库的逐页等量清单；专题里有代码实验，也有通过手算、反例和开放题验收的课文。

<a id="build"></a>

## 用反例和小项目验证，不只刷通样例

```d2
direction: down
foundation: 基础题：查表、缩区间、选下一步
practice: 进阶题：图、搜索决策、排序与堆
project: 小项目：带优先级的依赖规划器
foundation -> practice: 从单个状态练到状态之间的关系
practice -> project: 复用图的依赖关系和堆的出队规则
```

[任务依赖规划器](07-task-planner.md)只计算合法顺序和阻塞任务，不运行任务。结合[阶段关卡](41-practice-checkpoints.md)，可以用它区分「哪些任务成环」「哪些任务被环阻塞」「实际并行执行需要什么状态」。

从仓库根目录运行（Node 24+）：

```bash
node code/algorithm-node/examples/01-arrays.ts
node code/algorithm-node/examples/08-advanced.ts
npm --prefix code/algorithm-node test
```

运行示例和测试不需要先安装 npm 依赖；类型检查和 lint 需要先 `npm ci`。进阶示例的运行命令和输出见[实验代码说明](../code/algorithm-node/README.md)。
