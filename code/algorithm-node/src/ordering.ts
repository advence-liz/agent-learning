export function mergeSort(values: readonly number[]): number[] {
  const sorted = [...values];
  const scratch = Array.from({ length: sorted.length }, () => 0);
  function sort(lo: number, hi: number): void {
    if (hi - lo < 2) return;
    const mid = lo + Math.floor((hi - lo) / 2);
    sort(lo, mid);
    sort(mid, hi);
    let left = lo;
    let right = mid;
    for (let out = lo; out < hi; out++) {
      if (right === hi || (left < mid && sorted[left] <= sorted[right])) scratch[out] = sorted[left++];
      else scratch[out] = sorted[right++];
    }
    for (let i = lo; i < hi; i++) sorted[i] = scratch[i];
  }
  sort(0, sorted.length);
  return sorted;
}

// A value with compare(a, b) < 0 outranks b. Elements should not be undefined.
export class BinaryHeap<T> {
  private readonly items: T[] = [];
  private readonly compare: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare;
  }

  get size(): number { return this.items.length; }
  peek(): T | undefined { return this.items[0]; }

  push(value: T): void {
    const items = this.items;
    let i = items.length;
    items.push(value);
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.compare(items[i], items[parent]) >= 0) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }

  pop(): T | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const first = items[0];
    const last = items.pop()!;
    if (items.length === 0) return first;
    items[0] = last;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      if (left >= items.length) break;
      const right = left + 1;
      const child = right < items.length && this.compare(items[right], items[left]) < 0 ? right : left;
      if (this.compare(items[i], items[child]) <= 0) break;
      [items[i], items[child]] = [items[child], items[i]];
      i = child;
    }
    return first;
  }
}

// k is a nonnegative integer. Returns up to k values, in descending order.
export function largestK(values: readonly number[], k: number): number[] {
  if (k === 0) return [];
  const heap = new BinaryHeap<number>((a, b) => a - b);
  for (const value of values) {
    if (heap.size < k) heap.push(value);
    else if (value > heap.peek()!) {
      heap.pop();
      heap.push(value);
    }
  }
  const result: number[] = [];
  while (heap.size > 0) result.push(heap.pop()!);
  return result.reverse();
}
