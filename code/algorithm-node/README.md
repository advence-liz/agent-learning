# TypeScript 算法实验

对应[数据结构与算法导读](../../p9-algorithms/00-guide.md)。`examples/` 提供基础和进阶运行脚本，算法实现放在 `src/`，边界与对拍测试集中在 `tests/`。所有示例只用本地数据，不访问模型或网络；其他课文提供手算、伪代码或独立练习。

```bash
# 在本目录运行，Node 24+；示例和测试不需要 npm ci
node examples/01-arrays.ts
node examples/07-planner.ts
node examples/08-advanced.ts
npm test

# 修改完代码再跑静态检查，需要首次安装开发依赖
npm ci
npm run typecheck
npm run lint
```

进阶示例实测输出：

```text
range add: [2,1,1,-1,-1]
rectangle: 6
window max: [9,2,5]
inversions: 4
car: prefix / complete: true / false
shortest costs: {"a":0,"b":1,"c":1}
spanning weight: 2
knapsack, edit distance, LIS: 4 2 3
interval and digit DP: 167 5
gcd and modPow: 6 5
primes: [2,3,5,7,11]
```

建议先改一个用例，观察哪条输入前提或不变量被破坏，再回到实现找原因。综合项目的 `src/planner.ts` 复用 `src/ordering.ts` 的二叉堆，规划任务顺序但不执行任务。
