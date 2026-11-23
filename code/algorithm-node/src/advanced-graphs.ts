import { BinaryHeap } from './ordering.ts';

type TrieNode = { children: Map<string, TrieNode>; word: boolean };

export class Trie {
  private readonly root: TrieNode = { children: new Map(), word: false };

  add(text: string): void {
    let node = this.root;
    for (const char of text) {
      let child = node.children.get(char);
      if (!child) {
        child = { children: new Map(), word: false };
        node.children.set(char, child);
      }
      node = child;
    }
    node.word = true;
  }

  private lookup(text: string): TrieNode | undefined {
    let node: TrieNode | undefined = this.root;
    for (const char of text) {
      node = node.children.get(char);
      if (!node) return;
    }
    return node;
  }

  has(text: string): boolean { return this.lookup(text)?.word ?? false; }
  hasPrefix(text: string): boolean { return this.lookup(text) !== undefined; }
}

export class DisjointSet {
  private readonly parent: number[];
  private readonly size: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.size = Array<number>(n).fill(1);
  }

  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }

  union(a: number, b: number): boolean {
    a = this.find(a);
    b = this.find(b);
    if (a === b) return false;
    if (this.size[a] < this.size[b]) [a, b] = [b, a];
    this.parent[b] = a;
    this.size[a] += this.size[b];
    return true;
  }
}

export function shortestCosts(graph: ReadonlyMap<string, readonly (readonly [string, number])[]>, start: string): Map<string, number> {
  const best = new Map([[start, 0]]);
  const heap = new BinaryHeap<readonly [string, number]>((a, b) => a[1] - b[1]);
  heap.push([start, 0]);
  while (heap.size > 0) {
    const [vertex, distance] = heap.pop()!;
    if (distance !== best.get(vertex)) continue;
    for (const [neighbor, weight] of graph.get(vertex) ?? []) {
      if (!Number.isFinite(weight) || weight < 0) throw new RangeError('weight must be finite and nonnegative');
      const candidate = distance + weight;
      if (candidate >= (best.get(neighbor) ?? Infinity)) continue;
      best.set(neighbor, candidate);
      heap.push([neighbor, candidate]);
    }
  }
  return best;
}

// Undirected input, vertices 0 <= v < n, n >= 1; weights may be negative.
export function minimumSpanningWeight(n: number, edges: readonly (readonly [number, number, number])[]): number | null {
  const connected = new DisjointSet(n);
  let total = 0;
  let remaining = n - 1;
  for (const [a, b, weight] of [...edges].sort((lhs, rhs) => lhs[2] - rhs[2])) {
    if (!connected.union(a, b)) continue;
    total += weight;
    if (--remaining === 0) break;
  }
  return remaining === 0 ? total : null;
}
