# 滑动窗口三练：长度变了，哪条规则也要跟着变？

> [算法路线](00-guide.md) · [核心算法框架](79-core-frameworks.md) · 独立原创

**滑动窗口的关键不是两根指针，而是能不能安全地移走左端。** 下面三题都问连续子数组：先固定长度，再让长度可变，最后只改一个输入条件，看同一段代码为什么会漏解。

## 固定长度：每进一步，恰好换掉一个元素

给定 `[4, -3, 5, -2]`，长度为 `2` 的连续子数组，最大和是多少？先别写循环：三个窗口的和依次是 `1`、`2`、`3`。从第一个移到第二个时，只需要减掉离开的 `4`、加上新进来的 `5`。

```ts
function maxFixedSum(values: readonly number[], k: number): number | null {
  if (!Number.isInteger(k) || k < 1 || k > values.length) return null;
  let sum = 0;
  for (let i = 0; i < k; i++) sum += values[i];
  let best = sum;
  for (let right = k; right < values.length; right++) {
    sum += values[right] - values[right - k];
    best = Math.max(best, sum);
  }
  return best;
}
```

这里**不要求数字非负**：能移走左端，不是因为和会变大或变小，而是因为下一个长度为 `k` 的窗口根本不包含它。时间 `O(n)`，额外空间 `O(1)`。

<details>
<summary>自测：<code>[-8, -3, -5]</code>、<code>k = 2</code>，最大和是多少？</summary>

是 `-8`，不是 `0`。合法窗口只有 `[-8, -3]` 和 `[-3, -5]`，所以应拿第一个合法窗口的和初始化 `best`。

</details>

## 可变长度：只有证明左端不会再有用，才把它移走

现在改成：在**非负整数**数组 `[2, 1, 3, 2]` 里，找和至少为 `5` 的最短连续子数组。窗口 `[2, 1, 3]` 达标，先记长度 `3`，再试着去掉 `2`；此时 `[1, 3]` 只剩 `4`，再缩一定不够，应该继续向右扩。最后 `[3, 2]` 达标，答案是 `2`。

```ts
// 前提：每一项非负，target > 0；无解返回 null。
function minLengthAtLeast(values: readonly number[], target: number): number | null {
  let left = 0;
  let sum = 0;
  let best = Infinity;
  for (let right = 0; right < values.length; right++) {
    sum += values[right];
    while (sum >= target) {
      best = Math.min(best, right - left + 1);
      sum -= values[left++];
    }
  }
  return Number.isFinite(best) ? best : null;
}
```

达标的窗口已经记过答案，再让它的左端配上更晚的右端，只会更长，所以这个左端可以丢掉。不达标时，删掉非负数不会让和变大，所以这轮左端不必继续缩。两根指针都只往前走，时间 `O(n)`，额外空间 `O(1)`。另一种可变窗口见[最长无重复子串](02-pointers-and-search.md)：它维护的是重复字符，不是区间和。

<details>
<summary>自测：<code>[1, 1]</code>、目标 <code>3</code>，应该返回什么？</summary>

返回 `null`：从没有任何窗口达标。再试 `[0, 5]`、目标 `5`，应该返回 `1`，用来验证达标后还会继续缩。

</details>

## 加入负数：缩一下不够，不等于再缩也不够

把输入改成 `[1, -1, 3]`，目标还是 `3`。非负数版会先看到整个窗口达标，记下长度 `3`；去掉 `1` 后和是 `2`，循环停止。可如果再去掉 `-1`，剩下的 `[3]` 又达标了，最短长度其实是 `1`。

别先修补 `while`。先用两层循环枚举每个左端和右端，确认结果；想把解法从 `O(n²)` 降到 `O(n)`，可以选读下面的[进阶解法](#signed-solution)。

回到[核心算法框架](79-core-frameworks.md)时，试着用一句话说出区别：**失效的是「不达标就不用再缩」这条推理，不是「连续区间可以维护一个和」。** 想检验自己能不能在没有提示时选对方法，可以直接做[五道混合题](82-mixed-practice.md)，不必先读进阶。

<details>
<summary>自测：为什么这个反例不影响第一题的固定窗口？</summary>

第一题只检查恰好 `k` 项的区间，从来不靠「缩短后和不会变大」判断是否跳过候选。加入负数不会改变每次一进一出的规则。

</details>

<a id="signed-solution"></a>

## 选读：队首结算答案，队尾淘汰更差的左边界

令 `prefix[j]` 为下标 `j` 之前的累计和，因此 `[i, j)` 的和是 `prefix[j] - prefix[i]`，长度是 `j - i`。从左到右枚举右边界 `j`；队列里只留可能有用的旧下标，前缀和从队首到队尾严格递增。

| 从哪一端删 | 什么条件可以删 | 为什么不会漏掉更短解 |
|---|---|---|
| **队首结算** | `prefix[j] - prefix[队首] >= target` | 先记录这次长度。今后用同一个左边界，只会更长。若队首都不达标，后面更大的前缀和也不达标。 |
| **队尾淘汰** | `prefix[队尾] >= prefix[j]` | 把 `j` 当作未来的左边界，位置更靠后、前缀和又不大于旧队尾；对任意未来右边界，和至少一样大、长度更短。 |

`[1, -1, 3]` 的前缀和是 `[0, 1, 0, 3]`。走到 `j = 2` 时，新的 `0` 比队尾的 `1` 小、和更早的 `0` 相等，可以从队尾连续淘汰下标 `1`、`0`。走到 `j = 3` 时，队首是下标 `2`，差值 `3 - 0` 达标，长度是 `3 - 2 = 1`。

```ts
// target > 0；输入和相关和均须能被 Number 精确表示；无解返回 null。
function minLengthWithNegatives(values: readonly number[], target: number): number | null {
  const prefix = [0];
  for (const value of values) prefix.push(prefix[prefix.length - 1] + value);

  const deque: number[] = [];
  let head = 0;
  let best = Infinity;
  for (let j = 0; j < prefix.length; j++) {
    while (head < deque.length && prefix[j] - prefix[deque[head]] >= target) {
      best = Math.min(best, j - deque[head++]);
    }
    while (head < deque.length && prefix[deque[deque.length - 1]] >= prefix[j]) {
      deque.pop();
    }
    deque.push(j);
  }
  return Number.isFinite(best) ? best : null;
}
```

先用 `j` 结算旧边界，再把 `j` 放进队列作为未来的左边界，所以不会把空区间当成候选。`head` 标记剩余队列的起点，不用 `shift()`。每个下标最多入队、出队各一次；前缀和与队列各占 `O(n)` 空间，时间也是 `O(n)`。

<details>
<summary>进阶自测：什么时候队首要连续结算两次？</summary>

试 `[1, 2]`、目标 `2`。最后的前缀和是 `3`，队首下标 `0` 和下一项下标 `1` 都达标：先得到长度 `2`，再得到长度 `1`。如果把队首的 `while` 写成 `if`，就会错过 `[2]`。再用 `[2, -2, 2]`、目标 `3` 验证无解返回 `null`。

</details>
