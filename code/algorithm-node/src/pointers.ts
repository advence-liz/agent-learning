export function sortedPair(values: readonly number[], target: number): [number, number] | null {
  let left = 0;
  let right = values.length - 1;
  while (left < right) {
    const sum = values[left] + values[right];
    if (sum === target) return [left, right];
    if (sum < target) left++;
    else right--;
  }
  return null;
}

export function longestUnique(text: string): number {
  const lastSeen = new Map<string, number>();
  let left = 0;
  let right = 0;
  let best = 0;
  for (const symbol of text) {
    const previous = lastSeen.get(symbol);
    if (previous !== undefined) left = Math.max(left, previous + 1);
    lastSeen.set(symbol, right);
    best = Math.max(best, right - left + 1);
    right++;
  }
  return best;
}

export function lowerBound(values: readonly number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
