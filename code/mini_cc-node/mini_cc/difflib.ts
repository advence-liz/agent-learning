/**
 * Python 标准库 difflib 的一小部分：SequenceMatcher、get_close_matches、unified_diff。
 *
 * Python 版直接用标准库；Node 没有对等物，这里按 CPython 的算法移植（含 autojunk 的「热门元素」规则，
 * 不支持 isjunk 函数），所以第 1 章的命令纠错和第 9 章的文件 diff 和 Python 版输出一致。
 */

type Opcode = ["equal" | "replace" | "delete" | "insert", number, number, number, number];

export class SequenceMatcher<T> {
  private a: T[];
  private b: T[];
  private b2j = new Map<T, number[]>();
  private popular = new Set<T>();
  private matching: Array<[number, number, number]> | null = null;

  constructor(a: ArrayLike<T> | Iterable<T>, b: ArrayLike<T> | Iterable<T>, autojunk = true) {
    this.a = Array.from(a as Iterable<T>);
    this.b = Array.from(b as Iterable<T>);
    this.b.forEach((x, j) => {
      const idx = this.b2j.get(x);
      if (idx) idx.push(j);
      else this.b2j.set(x, [j]);
    });
    // autojunk：b 至少 200 项时，出现次数超过 1% 的元素算「热门」，不参与找最长匹配的起点
    const n = this.b.length;
    if (autojunk && n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [x, idx] of this.b2j) if (idx.length > ntest) this.popular.add(x);
      for (const x of this.popular) this.b2j.delete(x);
    }
  }

  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    const { a, b } = this;
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of this.b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) [besti, bestj, bestsize] = [i - k + 1, j - k + 1, k];
      }
      j2len = next;
    }
    // 用热门元素把匹配往两边延伸（没有 isjunk，所以「非 junk」恒为真）
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) [besti, bestj, bestsize] = [besti - 1, bestj - 1, bestsize + 1];
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  }

  getMatchingBlocks(): Array<[number, number, number]> {
    if (this.matching) return this.matching;
    const la = this.a.length, lb = this.b.length;
    const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
    const blocks: Array<[number, number, number]> = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const [i, j, k] = this.findLongestMatch(alo, ahi, blo, bhi);
      if (k) {
        blocks.push([i, j, k]);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    // 合并首尾相接的块
    const merged: Array<[number, number, number]> = [];
    let [i1, j1, k1] = [0, 0, 0];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) merged.push([i1, j1, k1]);
        [i1, j1, k1] = [i2, j2, k2];
      }
    }
    if (k1) merged.push([i1, j1, k1]);
    merged.push([la, lb, 0]);
    return (this.matching = merged);
  }

  getOpcodes(): Opcode[] {
    let i = 0, j = 0;
    const out: Opcode[] = [];
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      const tag = i < ai && j < bj ? "replace" : i < ai ? "delete" : j < bj ? "insert" : null;
      if (tag) out.push([tag, i, ai, j, bj]);
      [i, j] = [ai + size, bj + size];
      if (size) out.push(["equal", ai, i, bj, j]);
    }
    return out;
  }

  /** 按变化分组，每组前后各带 n 行上下文（unified diff 的 hunk）。 */
  getGroupedOpcodes(n = 3): Opcode[][] {
    let codes = this.getOpcodes();
    if (!codes.length) codes = [["equal", 0, 1, 0, 1]];
    if (codes[0][0] === "equal") {
      const [tag, i1, i2, j1, j2] = codes[0];
      codes[0] = [tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
    }
    if (codes.at(-1)![0] === "equal") {
      const [tag, i1, i2, j1, j2] = codes.at(-1)!;
      codes[codes.length - 1] = [tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
    }
    const groups: Opcode[][] = [];
    let group: Opcode[] = [];
    for (let [tag, i1, i2, j1, j2] of codes) {
      if (tag === "equal" && i2 - i1 > n + n) {
        group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
        groups.push(group);
        group = [];
        [i1, j1] = [Math.max(i1, i2 - n), Math.max(j1, j2 - n)];
      }
      group.push([tag, i1, i2, j1, j2]);
    }
    if (group.length && !(group.length === 1 && group[0][0] === "equal")) groups.push(group);
    return groups;
  }

  ratio(): number {
    const matches = this.getMatchingBlocks().reduce((s, [, , k]) => s + k, 0);
    const total = this.a.length + this.b.length;
    return total ? (2 * matches) / total : 1;
  }
}

/** difflib.get_close_matches：按相似度取前 n 个，相似度低于 cutoff 的不要。 */
export function getCloseMatches(word: string, possibilities: string[], n = 3, cutoff = 0.6): string[] {
  const scored: Array<[number, string]> = [];
  for (const x of possibilities) {
    const r = new SequenceMatcher(x, word).ratio();
    if (r >= cutoff) scored.push([r, x]);
  }
  // heapq.nlargest 比较 (score, x) 元组：分数相同时字符串大的在前
  scored.sort((p, q) => q[0] - p[0] || (q[1] > p[1] ? 1 : q[1] < p[1] ? -1 : 0));
  return scored.slice(0, n).map(([, x]) => x);
}

function formatRange(start: number, stop: number): string {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return String(beginning);
  if (!length) beginning -= 1;
  return `${beginning},${length}`;
}

/** difflib.unified_diff(a, b, fromfile, tofile, n=n, lineterm="")：返回不带换行符的行。 */
export function unifiedDiff(a: string[], b: string[], fromfile = "", tofile = "", n = 3): string[] {
  const out: string[] = [];
  const groups = new SequenceMatcher(a, b).getGroupedOpcodes(n);
  if (groups.length) out.push(`--- ${fromfile}`, `+++ ${tofile}`);
  for (const group of groups) {
    const first = group[0], last = group.at(-1)!;
    out.push(`@@ -${formatRange(first[1], last[2])} +${formatRange(first[3], last[4])} @@`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        for (const line of a.slice(i1, i2)) out.push(" " + line);
        continue;
      }
      if (tag === "replace" || tag === "delete") for (const line of a.slice(i1, i2)) out.push("-" + line);
      if (tag === "replace" || tag === "insert") for (const line of b.slice(j1, j2)) out.push("+" + line);
    }
  }
  return out;
}
