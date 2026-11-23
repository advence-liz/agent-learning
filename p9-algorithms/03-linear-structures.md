# 链表、栈与队列：结构决定下一步处理谁

> [算法路线](00-guide.md) · 独立原创
>
> **一句话：**链表的状态是「边指向谁」，栈的规则是后进先出，队列的规则是先进先出。先确定操作顺序，再决定用哪种结构。

## 反转不是交换值，而是改谁指向谁

```bash
node code/algorithm-node/examples/03-structures.ts
```

```text
reversed: 3 -> 2 -> 1
([)] is valid: false
```

假设节点还保存着别处引用。如果只交换节点里的值，值的顺序看着对，但原来的头结点还是头结点。这不是反转结构。本实验复用原节点、原地改 `next`：

```d2
direction: down
save: 保存 current.next 到 next
rewire: 将 current.next 改为 previous
advance: previous = current；current = next
save -> rewire: 原后继不会丢
rewire -> advance: 已反转部分向前扩一项
```

每轮开始，`previous` 指向已经反转的前缀，`current` 指向尚未反转部分的头。保存后继，翻转一条边，再推进两个指针；当 `current` 到 `null` 时，`previous` 就是新头。输入需无环；空链表和单节点也走同一套逻辑。`O(n)` 时间、`O(1)` 额外空间。

## 谁应该先出：看你在处理嵌套还是排队

| 规则 | 业务类比 | 代码操作 |
|---|---|---|
| 栈（stack）后进先出 | 最近打开的括号必须最先关闭 | 数组尾部 `push` / `pop` |
| 队列（queue）先进先出 | 最早进入图的前沿应最先扩展 | 尾部 `push`，移动 `head` 读队首 |

扫描括号时，栈存的是「接下来需要的右括号」。`([)]` 中栈顶等着 `]`，却先遇到 `)`，计数相等也没用。处理完还必须检查栈清空；输入含其他字符时，本实现拒绝。`O(n)` 时间、最坏 `O(n)` 空间。[看链表和括号实现](../code/algorithm-node/src/structures.ts)。

[图遍历示例](04-tree-and-graph.md)用数组加递增队头，不反复 `shift()` 搬动或重排元素。代价是旧数组槽不会自动清理：单次遍历用完即可释放整个数组，长期队列则要清掉旧引用并回收槽位，例如改用环形缓冲区。`head++` 不是完整的长期队列实现。

## 练习：把值正确和结构正确分开验证

1. 写 `reverseList` 的对象身份断言，确认没有另造节点。

<details>
<summary>提示</summary>

保存反转前的头和尾，反转后用 `assert.equal` 检查返回的就是原尾，且原头的 `next === null`。

</details>

2. 用两个栈实现一个队列，为什么不必每次出队都搬动所有元素？

<details>
<summary>提示</summary>

入队进 `in`，出队从 `out` 取；只有 `out` 空才把 `in` 全搬过去。每个元素最多跨栈一次，单次出队可能线性，但一串操作的摊销时间为常数。

</details>

延伸：[树与图](04-tree-and-graph.md)把栈与队列用在真正的遍历里。
