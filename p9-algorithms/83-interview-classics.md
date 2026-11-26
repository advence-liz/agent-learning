# 11 道经典算法面试题：把解法讲清楚，再写代码

> [算法路线](00-guide.md) · [核心算法框架](79-core-frameworks.md) · 独立原创

**面试时先把题意翻译成一句能检验的约定。** 比如不是「用滑窗」，而是「扫描到右端时，这段区间内没有重复字符，左端不会后退」。然后讲清为什么一步也没漏，最后拿反例验代码。

题型选择参考 [LeetCode Top Interview 150](https://leetcode.com/studyplan/top-interview-150/)。这里按解题方法精选 11 道代表题，不把它当公司出题频率或排名；题目链接用于实练，下面的解释和反例独立编写。

| 复习顺序 | 先回答的问题 | 代表题 |
|---|---|---|
| [线性扫描](#scan) | 扫到当前位置时，哪些历史还要记？ | 两数之和、无重复最长子串、有效括号、搜索插入位置 |
| [容器与关系](#relationships) | 更新的是查找顺序、节点关系，还是执行资格？ | LRU 缓存、二叉树最大深度、岛屿数量、课程表 |
| [搜索与最优值](#decisions) | 要列出所有解，还是只返回一个最优值？ | 全排列、零钱兑换、最大子数组和 |

建议每题先只点开题目，用自己的话说一遍「输入和输出 → 保留什么状态 → 为什么安全 → 一个反例」，再回来读解析。卡住就按各题的延伸链接补课，不必一次刷完。

<a id="scan"></a>

## 扫描数组或字符串时，先说明要保留什么历史

### 1. 两数之和：先查补数，再记当前位置

[LeetCode 1](https://leetcode.com/problems/two-sum/) 要返回两个**不同下标**。扫描到 `i` 时，表里只放 `i` 之前的值和下标；先查 `target - nums[i]`，再登记当前值。这样一对合法答案在第二个下标被扫描时一定能被发现，又不会拿同一个元素配自己。按哈希平均常数操作估算，时间 `O(n)`，额外空间 `O(n)`。

**验错：** `[3, 3]`、目标 `6` → `[0, 1]`。如果先写表再查，可能得到 `[0, 0]`。若输入已经有序，可以改用双指针；若必须保留原下标，不能直接排序后交新下标。[原理与代码](01-arrays-and-hash.md)

### 2. 无重复字符的最长子串：已经离开窗口的字符不能让左端倒退

[LeetCode 3](https://leetcode.com/problems/longest-substring-without-repeating-characters/) 求的是连续子串。`lastSeen` 记录每个字符最近的位置；若当前字符上次出现在当前窗口里（含左端），就跳到那次位置的后一格，统一写成 `left = max(left, previous + 1)`。更新后，`[left, right]` 没有重复；每一轮取一次最大长度。时间 `O(n)`，额外空间 `O(u)`，`u` 为不同字符数，按哈希平均常数操作估算。

**验错：** `abba` → `2`。最后一个 `a` 的旧位置在窗外，不能把 `left` 拉回去。面试若给 Unicode 输入，先和面试官约定按 UTF-16 单元、码点还是用户感知字符计数；[本站实现](../code/algorithm-node/src/pointers.ts)按码点。[滑窗讲解](02-pointers-and-search.md)

### 3. 有效括号：栈顶只允许关闭最近一个左括号

[LeetCode 20](https://leetcode.com/problems/valid-parentheses/) 不只问数量对不对，还问嵌套顺序。读到左括号，就把对应的右括号压栈；读到右括号时，必须等于栈顶。扫描结束还要检查栈是空的。时间 `O(n)`，额外空间 `O(n)`。

**验错：** `([)]` → `false`，数量对但顺序错；`([` → `false`，最后还有未匹配项。[栈和括号的讲解](03-linear-structures.md)

### 4. 搜索插入位置：找第一处不小于目标的位置

[LeetCode 35](https://leetcode.com/problems/search-insert-position/) 的输入按升序排列，官方题目中元素互异。把问题说成找第一个 `nums[i] >= target` 的下标，找不到就返回 `n`。维护半开区间 `[lo, hi)`：`lo` 左边都太小，`hi` 开始的有效位置都合格；`nums[mid]` 合格时令 `hi = mid`，因为 `mid` 自己也可能是第一个。时间 `O(log n)`，额外空间 `O(1)`。

**验错：** `[1, 3, 5, 6]` 查 `0`、`2`、`7` → `0`、`1`、`4`。返回 `4` 是合法插入位置，不是可访问下标。允许重复时，同一写法会返回第一个匹配位置。[二分边界](02-pointers-and-search.md)

<a id="relationships"></a>

## 处理节点关系时，先说明谁能先处理

### 5. LRU 缓存：一张表管定位，一条链管先淘汰谁

[LeetCode 146](https://leetcode.com/problems/lru-cache/) 要高效读写，并在满时淘汰**最久未使用**的键。哈希表把键映射到节点；双向链表维护访问顺序。命中读和更新已有键，都把节点移到最近一端；只有插入新键导致超容量时才删最久未用的一端，并同步删表项。用哈希表和双向链表时，平均每次 `O(1)`，额外空间 `O(capacity)`。

**验错：** 容量 `2`，依次写 `A`、`B`，读 `A`，再写 `C`，应淘汰 `B`，不是 `A`。再测更新已有键不会逐出其他键。[哈希与 LRU](16-hash-lru.md)

### 6. 二叉树的最大深度：先让每棵子树说明自己的答案

[LeetCode 104](https://leetcode.com/problems/maximum-depth-of-binary-tree/) 按节点数计深度。把 `depth(node)` 约定为以该节点为根的最大深度；空树 `0`，非空返回 `1 + max(depth(left), depth(right))`。父节点只用两个结果，不用知道哪片叶子最深。时间 `O(n)`，递归栈 `O(h)`，`h` 为树高。

**验错：** 空树 `0`、单节点 `1`、三节点单链 `3`。左右结果不能相加；深链还要考虑调用栈上限。[两种树递归写法](81-storage-and-traversal.md) · [实现](../code/algorithm-node/src/traversal.ts)

### 7. 岛屿数量：外层负责计数，内层负责把连通块标完

[LeetCode 200](https://leetcode.com/problems/number-of-islands/) 的陆地只按上下左右连通。逐格扫描；遇到没标记的陆地，答案加一，再从这格遍历整块陆地。要在入队或入栈时标记，避免同一个格子被多个邻居重复加入。`m × n` 网格的时间 `O(mn)`；显式栈或队列与访问表最坏额外空间 `O(mn)`。允许改输入时可以原地标记，不等于队列也变成常数空间。

**验错：** 两行 `10`、`01` → `2`，四邻接不走对角；两行 `11`、`11` → `1`，内部有多条抵达路径但只算一座岛。[岛屿搜索专题](74-islands.md)

### 8. 课程表：只有前置都消掉的课才入队

[LeetCode 207](https://leetcode.com/problems/course-schedule/) 问能否修完全部课程。`[course, prerequisite]` 要建边 `prerequisite → course`；入度表示尚未修完的直接前置数量。每次取一门零入度课，减少后继的入度。队列用完而完成数小于 `n`，说明有环挡住了进度。时间和空间都是 `O(n + e)`，`e` 为前置关系数，下面用递增下标模拟队头。

```ts
function canFinishCourses(n: number, prerequisites: readonly (readonly [number, number])[]): boolean {
  const outgoing: number[][] = Array.from({ length: n }, () => []);
  const incoming = Array<number>(n).fill(0);
  for (const [course, prerequisite] of prerequisites) {
    outgoing[prerequisite].push(course);
    incoming[course]++;
  }
  const ready: number[] = [];
  for (let course = 0; course < n; course++) {
    if (incoming[course] === 0) ready.push(course);
  }
  for (let head = 0; head < ready.length; head++) {
    for (const next of outgoing[ready[head]]) {
      if (--incoming[next] === 0) ready.push(next);
    }
  }
  return ready.length === n;
}
```

**验错：** `n=3`，`[[1,0],[0,1],[2,1]]` → `false`。`0`、`1` 在环里，`2` 只是被阻塞；如果追问「哪些课自己在环里」，不能直接把剩余节点都当环成员。[有向图、拓扑和强连通](25-directed-graphs.md)

<a id="decisions"></a>

## 做选择时，先决定保留每条路径还是一个最优值

### 9. 全排列：路径中的下标用过，回到上层就得恢复

[LeetCode 46](https://leetcode.com/problems/permutations/) 的输入元素互异，要列出所有排列。把递归第 `k` 层看成选择第 `k` 项：枚举未用下标，标记并加入路径，递归后撤销这两步；路径满长时**复制**到答案里。确实要输出 `n!` 个长度为 `n` 的数组，所以时间 `O(n · n!)`；额外空间 `O(n)`（不计输出）。

**验错：** `[1, 2, 3]` 应得到六个互不相同的结果。漏撤销会少答案；不复制路径会让多个答案共用一个数组。若元素可重复且要求结果去重，还要处理同一层的等价选择。[回溯去重](26-backtracking-duplicates.md)

### 10. 零钱兑换：状态是金额，不是此前用过哪些硬币

[LeetCode 322](https://leetcode.com/problems/coin-change/) 的正面值硬币每种不限量。令 `dp[t]` 表示凑出 `t` 的最少枚数，`dp[0]=0`，其他从不可达开始。任意可行解都可以去掉最后一枚面值 `c` 的硬币，所以用 `dp[t-c]+1` 更新 `dp[t]`，按金额递增处理。目标金额 `A`、面值种数 `m` 且 `m≥1` 时，时间 `O(A·m)`，空间 `O(A)`。

**验错：** `[1, 3, 4]` 凑 `6` → `2`，先选最大面值却要 `4+1+1` 三枚；`[2]` 凑 `3` → `-1`，凑 `0` → `0`。若改成「有几种凑法」，状态的含义和循环顺序都需要重新交代。[回溯、DP 与贪心的对照](05-backtracking-dp-greedy.md)

### 11. 最大子数组和：以当前位置结尾的答案，不等于全局答案

[LeetCode 53](https://leetcode.com/problems/maximum-subarray/) 求的是**非空、连续**区间。`ending` 表示必须在当前项结尾的最大和，当前项要么另起一段，要么接上上一段；`best` 才是扫描到目前为止所有右端点的最大值。用第一项初始化，时间 `O(n)`，额外空间 `O(1)`。

```ts
function maxSubarray(nums: readonly [number, ...number[]]): number {
  let ending = nums[0];
  let best = ending;
  for (let i = 1; i < nums.length; i++) {
    ending = Math.max(nums[i], ending + nums[i]);
    best = Math.max(best, ending);
  }
  return best;
}
```

**验错：** `[-7, -2, -9]` → `-2`，不能把空区间的 `0` 当答案；`[4, -1, 2, -7]` → `5`，最后一项对应的 `ending` 是 `-2`，不能直接返回它。[动态规划方法](30-dp-method.md)

## 真正过关，是改一个条件也能解释接下来怎么办

<details>
<summary>复盘：为什么「下标倒退」「环的下游」「全负输入」都适合用来验错？</summary>

它们各自击中一个不容易被普通样例发现的错误：窗口把已排除的位置放回来了；把无法完成的节点误当成环成员；或把题目不允许的空解混进来了。挑一个错例，先说它打破了什么约定，再开始改代码。

</details>

做完一轮，合上这一页去做[五道混合题](82-mixed-practice.md)。那一页不标算法名，更适合检查你能不能只凭题目条件选出方法。
