import { lowerBound } from './pointers.ts';

export function knapsack01(items: readonly (readonly [weight: number, value: number])[], capacity: number): number {
  const dp = Array<number>(capacity + 1).fill(0);
  for (const [weight, value] of items) {
    for (let c = capacity; c >= weight; c--) dp[c] = Math.max(dp[c], dp[c - weight] + value);
  }
  return dp[capacity];
}

export function editDistance(first: string, second: string): number {
  const a = Array.from(first);
  const b = Array.from(second);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (const [i, x] of a.entries()) {
    const row = [i + 1];
    for (const [j, y] of b.entries()) {
      row.push(x === y ? prev[j] : 1 + Math.min(prev[j], prev[j + 1], row[j]));
    }
    prev = row;
  }
  return prev[b.length];
}

export function lisLength(values: readonly number[]): number {
  const tails: number[] = [];
  for (const value of values) tails[lowerBound(tails, value)] = value;
  return tails.length;
}

export function maxBalloonScore(values: readonly number[]): number {
  const padded = [1, ...values, 1];
  const dp = Array.from(padded, () => Array<number>(padded.length).fill(0));
  for (let width = 2; width < padded.length; width++) {
    for (let lo = 0; lo + width < padded.length; lo++) {
      const hi = lo + width;
      let best = -Infinity;
      for (let last = lo + 1; last < hi; last++) {
        const score = dp[lo][last] + dp[last][hi] + padded[lo] * padded[last] * padded[hi];
        best = Math.max(best, score);
      }
      dp[lo][hi] = best;
    }
  }
  return dp[0][padded.length - 1];
}

// ceiling is a nonnegative safe integer. Fixed width allows leading zeroes.
export function countAtMostWithoutAdjacentOnes(ceiling: number): number {
  const digits = ceiling.toString(2);
  const memo = new Map<number, number>();
  function count(pos: number, previous: number, tight: boolean): number {
    if (pos === digits.length) return 1;
    const key = pos * 2 + previous;
    if (!tight && memo.has(key)) return memo.get(key)!;
    const cap = tight ? Number(digits[pos]) : 1;
    let result = 0;
    for (let digit = 0; digit <= cap; digit++) {
      if (digit === 1 && previous === 1) continue;
      result += count(pos + 1, digit, tight && digit === cap);
    }
    if (!tight) memo.set(key, result);
    return result;
  }
  return count(0, 0, true);
}
