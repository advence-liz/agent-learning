export function twoSum(values: readonly number[], target: number): [number, number] | null {
  const seen = new Map<number, number>();
  for (const [j, value] of values.entries()) {
    const i = seen.get(target - value);
    if (i !== undefined) return [i, j];
    seen.set(value, j);
  }
  return null;
}

export function prefixSums(values: readonly number[]): number[] {
  const prefix = [0];
  for (const value of values) prefix.push(prefix[prefix.length - 1] + value);
  return prefix;
}

// Assumes 0 <= left <= right < prefix.length, with integer boundaries.
export function rangeSum(prefix: readonly number[], left: number, right: number): number {
  return prefix[right] - prefix[left];
}
