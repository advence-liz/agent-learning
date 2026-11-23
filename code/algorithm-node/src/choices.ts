// Values are distinct, or each position is treated as its own choice.
export function subsets(values: readonly number[]): number[][] {
  const path: number[] = [];
  const result: number[][] = [];
  function visit(start: number): void {
    result.push([...path]);
    for (let i = start; i < values.length; i++) {
      path.push(values[i]);
      visit(i + 1);
      path.pop();
    }
  }
  visit(0);
  return result;
}

// Coins are positive integers; amount is a nonnegative integer small enough for a table.
export function minCoins(coins: readonly number[], amount: number): number {
  const dp = Array<number>(amount + 1).fill(Infinity);
  dp[0] = 0;
  for (let total = 1; total <= amount; total++) {
    for (const coin of coins) {
      if (coin <= total) dp[total] = Math.min(dp[total], dp[total - coin] + 1);
    }
  }
  return Number.isFinite(dp[amount]) ? dp[amount] : -1;
}

export type Interval = readonly [start: number, end: number];

// Inputs are finite, half-open intervals with start < end; every interval has equal value.
export function maxNonOverlapping(intervals: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  let lastEnd = -Infinity;
  for (const interval of [...intervals].sort((a, b) => a[1] - b[1])) {
    if (interval[0] < lastEnd) continue;
    result.push(interval);
    lastEnd = interval[1];
  }
  return result;
}
