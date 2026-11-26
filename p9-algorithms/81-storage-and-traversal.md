# 从数组到图：数据怎么存，决定你怎么找

> [算法路线](00-guide.md) · 独立原创。延伸阅读：labuladong 的[《学习数据结构和算法的框架思维》](https://labuladong.online/zh/algo/essential-technique/algorithm-summary/)。

**动手前先问两件事：从当前节点能去哪？题目要我交付可达性、距离，还是计数？** 下标、`next` 和邻接关系决定你能怎么走；输出要求决定走的时候要记什么。

假设有五个构建任务：A「入口」、B「编译」、C「测试」、D「打包」、E「发布」。给你一个起点，请判断能不能找到 **E**。任务不变，我们只换它们的组织方式。后面的箭头只表示本题允许沿哪个方向走，不表示构建依赖可以成环。

## 数组给你下标，链表只给你下一跳

| 同一批任务怎么组织 | 找 E 时怎么走 | 改动时要付什么代价 |
|---|---|---|
| 数组：`[A, B, C, D, E]` | 已知 E 在下标 `4` 就直接取；只知道名字且没建索引，最坏还是要逐项查。 | 紧凑数组中间插入一项，后面的项通常要挪位。 |
| 单链表：`A → B → C → D → E` | 从 A 沿 `next` 走。就算知道 E 排第五，也要先经过前面的节点。 | 已经拿到前驱节点时，可改常数条链接完成插入或删除其后继；没拿到前驱，先算找它的成本。 |

这里的数组按典型的紧凑数组模型讨论，不假定 JavaScript 引擎必须采用某种物理内存布局。两者按名字找最坏都是 `O(n)`；真正拉开差距的是：**你手里是下标、前驱，还是只有一个待查的值？**

<details>
<summary>自测：要经常读取第 500 项，却很少在中间插入，选谁？</summary>

选数组。优势来自已知位置，不是数组天然擅长按未知名字查找。如果需求改成按唯一名字高频查找，可以考虑另外维护哈希索引。

</details>

## 树让你选择分支，图让你记住来过哪里

把五个任务改用下面的关系表示，从 A 开始。这里不是搜索树，看到 B 不能断定 E 在哪一侧。

| 节点 | 树里可以走到 | 图里可以走到 |
|---|---|---|
| A | B、C | B、C |
| B | D | D |
| C | E | E、D |
| D | 无 | A |
| E | 无 | 无 |

从 A 做深度优先搜索（DFS），树上先沿 `A → B → D` 走到底，再处理另一支 `C → E`。图上 D 可以走回 A；不做标记，就可能绕着 `A → B → D → A` 一直走。树和图描述的是**节点之间的关系**，不是两种固定的内存布局。下面用 `Map` 按名字取出邻居，用数组存每个节点的邻居列表；这就是邻接表。

用栈记住下一批要处理的节点，栈顶写在右边。先弹出 A，把 C、B 压成 `[C, B]`；再弹出 B、压入 D，栈变成 `[C, D]`。处理 D 时发现 A 已经标记，就不再压入，接着才轮到 C。`seen` 记录的是「已发现（已入过栈）」，包括还没弹出来的点。

```ts
function canReach(graph: ReadonlyMap<string, readonly string[]>, start: string, target: string): boolean {
  // 约定每个节点都有一条邻接表记录；没有出边也用空数组登记。
  if (!graph.has(start) || !graph.has(target)) return false;
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === target) return true;
    const neighbors = graph.get(node) ?? [];
    // 反向压入本轮新发现的邻居，让它们按列出的顺序出栈。
    for (let i = neighbors.length - 1; i >= 0; i--) {
      const next = neighbors[i];
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return false;
}

const graph = new Map<string, readonly string[]>([
  ['A', ['B', 'C']], ['B', ['D']], ['C', ['E', 'D']], ['D', ['A']], ['E', []],
]);
console.log(canReach(graph, 'A', 'E'), canReach(graph, 'E', 'A'));
```

输出：`true false`。入栈前标记，同一个点最多入栈一次。**反向入栈不保证有共享节点的图会走出和递归 DFS 一样的顺序**，但可达性不依赖精确的访问顺序。按邻接表计算，最坏要检查从起点可达的点和边，时间 `O(V + E)`，额外空间 `O(V)`。本例只问「能不能到」；如果每步成本相同，还要问最少走几步，改看[广度优先搜索](04-tree-and-graph.md)。

<details>
<summary>自测：把 <code>D → A</code> 删掉，可以把 <code>seen</code> 也删掉吗？</summary>

这张图删边后没有环，单次可达性查询即使不去重也会停；但找不到目标时，仍可能从 B 和 C 各处理一次 D。有多个入口和有环是两种不同的问题。

</details>

## 同一棵树，可以一路记答案，也可以让子树返回答案

回到树：A 的孩子是 B、C，B 的孩子是 D，C 的孩子是 E。现在不找 E，改问「有多少个没有后续任务的节点？」画着数是 D、E，共 `2` 个。下面两种写法遍历的是同一棵树，区别是**答案放在哪里**。

```ts
type Task = { name: string; children: readonly Task[] };

function countLeavesByWalking(root: Task | null): number {
  let count = 0;
  function visit(node: Task): void {
    if (node.children.length === 0) count++;
    for (const child of node.children) visit(child);
  }
  if (root !== null) visit(root);
  return count;
}

function countLeavesByCombining(root: Task | null): number {
  if (root === null) return 0;
  if (root.children.length === 0) return 1;
  let total = 0;
  for (const child of root.children) total += countLeavesByCombining(child);
  return total;
}

const tree: Task = { name: 'A', children: [
  { name: 'B', children: [{ name: 'D', children: [] }] },
  { name: 'C', children: [{ name: 'E', children: [] }] },
] };
console.log(countLeavesByWalking(tree), countLeavesByCombining(tree));
```

输出：`2 2`。第一种每到一片叶子就给同一个计数器加一；第二种让 B、C 各返回 `1`，A 只负责相加，不用知道叶子叫 D 还是 E。两种都是 DFS，时间 `O(n)`、递归栈 `O(h)`，`h` 是树高。要**输出每条根到叶的路径**，沿途携带路径更自然；要**计算某棵子树的大小或高度**，先写清子树返回值，再考虑如何合并。见[递归与显式栈](10-recursion.md)。

<details>
<summary>自测：去掉图里的 <code>D → A</code> 后，从 A 能到达几个不同的无后继节点？还能直接加两边的结果吗？</summary>

只有 D、E 两个。B 这边通向 D，C 这边通向 E 和 D；直接相加会得到 `3`，因为 D 被算了两次。树上能直接相加，是因为两棵子树没有共享节点。图上如果问的是不同节点的个数，就需要按节点去重，比如遍历时用 `seen`，只给首次遇到的无后继节点计数。

</details>

## 遇到新题，先问能走哪里，再问答案怎么交付

数组下标、链表后继、树的子节点和图的邻居，都在回答「下一步有哪些」。下一关才是算法选择：需要保留所有路径、最短距离，还是可复用的子问题结果？带着这个问题去看[核心算法框架](79-core-frameworks.md)，会比从模板名字开始好选得多。
