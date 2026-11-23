export function applyRanges(n: number, updates: readonly (readonly [number, number, number])[]): number[] {
  const diff = Array<number>(n + 1).fill(0);
  for (const [left, right, value] of updates) {
    diff[left] += value;
    diff[right] -= value;
  }
  let current = 0;
  return diff.slice(0, n).map(delta => (current += delta));
}

export function matrixSums(matrix: readonly (readonly number[])[]): number[][] {
  const columns = matrix[0]?.length ?? 0;
  const sums = Array.from({ length: matrix.length + 1 }, () => Array<number>(columns + 1).fill(0));
  for (let r = 1; r <= matrix.length; r++) {
    for (let c = 1; c <= columns; c++) {
      sums[r][c] = matrix[r - 1][c - 1] + sums[r - 1][c] + sums[r][c - 1] - sums[r - 1][c - 1];
    }
  }
  return sums;
}

export function rectSum(sums: readonly (readonly number[])[], top: number, left: number, bottom: number, right: number): number {
  return sums[bottom][right] - sums[top][right] - sums[bottom][left] + sums[top][left];
}

export function nextGreater(values: readonly number[]): number[] {
  const result = Array<number>(values.length).fill(-1);
  const stack: number[] = [];
  for (const [i, value] of values.entries()) {
    while (stack.length && values[stack.at(-1)!] < value) result[stack.pop()!] = i;
    stack.push(i);
  }
  return result;
}

export function slidingMax(values: readonly number[], width: number): number[] {
  if (!Number.isInteger(width) || width < 1 || width > values.length) return [];
  // A ring keeps memory proportional to the window, not the whole input.
  const deque = Array<number>(width).fill(0);
  let head = 0;
  let size = 0;
  const result: number[] = [];
  for (const [i, value] of values.entries()) {
    if (size > 0 && deque[head] <= i - width) {
      head = (head + 1) % width;
      size--;
    }
    while (size > 0 && values[deque[(head + size - 1) % width]] <= value) size--;
    deque[(head + size) % width] = i;
    size++;
    if (i >= width - 1) result.push(values[deque[head]]);
  }
  return result;
}

export function inversionCount(input: readonly number[]): number {
  const values = [...input];
  const temp = Array<number>(values.length).fill(0);
  function count(lo: number, hi: number): number {
    if (hi - lo < 2) return 0;
    const mid = Math.floor((lo + hi) / 2);
    let total = count(lo, mid) + count(mid, hi);
    let a = lo;
    let b = mid;
    for (let i = lo; i < hi; i++) {
      if (b === hi || (a < mid && values[a] <= values[b])) temp[i] = values[a++];
      else {
        temp[i] = values[b++];
        total += mid - a;
      }
    }
    for (let i = lo; i < hi; i++) values[i] = temp[i];
    return total;
  }
  return count(0, values.length);
}
