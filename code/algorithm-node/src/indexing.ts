export function countSubarrays(values: readonly number[], target: number): number {
  const seen = new Map([[0, 1]]);
  let sum = 0;
  let count = 0;
  for (const value of values) {
    sum += value;
    count += seen.get(sum - target) ?? 0;
    seen.set(sum, (seen.get(sum) ?? 0) + 1);
  }
  return count;
}

export class Fenwick {
  private readonly sums: number[];

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 0 || size >= 2 ** 31) {
      throw new RangeError('size out of bounds for 32-bit lowbit');
    }
    this.sums = Array<number>(size + 1).fill(0);
  }

  add(index: number, delta: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.sums.length - 1) {
      throw new RangeError('index out of bounds');
    }
    for (let i = index + 1; i < this.sums.length; i += i & -i) this.sums[i] += delta;
  }

  private prefix(end: number): number {
    let total = 0;
    for (let i = end; i > 0; i -= i & -i) total += this.sums[i];
    return total;
  }

  sum(left: number, right: number): number {
    if (!Number.isInteger(left) || !Number.isInteger(right) || left < 0 || left > right || right >= this.sums.length) {
      throw new RangeError('range out of bounds');
    }
    return this.prefix(right) - this.prefix(left);
  }
}

// Returns code point offsets. An empty pattern has no matches by this API's convention.
export function matchStarts(text: string, pattern: string): number[] {
  const chars = Array.from(pattern);
  if (chars.length === 0) return [];
  const prefix = Array<number>(chars.length).fill(0);
  let matched = 0;
  for (let i = 1; i < chars.length; i++) {
    while (matched > 0 && chars[i] !== chars[matched]) matched = prefix[matched - 1];
    if (chars[i] === chars[matched]) matched++;
    prefix[i] = matched;
  }
  const matches: number[] = [];
  let i = 0;
  matched = 0;
  for (const char of text) {
    while (matched > 0 && char !== chars[matched]) matched = prefix[matched - 1];
    if (char === chars[matched]) matched++;
    if (matched === chars.length) {
      matches.push(i - matched + 1);
      matched = prefix[matched - 1];
    }
    i++;
  }
  return matches;
}
