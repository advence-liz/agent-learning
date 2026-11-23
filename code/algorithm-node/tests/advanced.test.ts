import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyRanges, matrixSums, rectSum, nextGreater, slidingMax, inversionCount } from '../src/ranges.ts';
import { Trie, DisjointSet, shortestCosts, minimumSpanningWeight } from '../src/advanced-graphs.ts';
import { knapsack01, editDistance, lisLength, maxBalloonScore, countAtMostWithoutAdjacentOnes } from '../src/dynamic.ts';
import { gcd, primesThrough, modPow } from '../src/math.ts';

test('difference updates overlap, cancel and stop at the exclusive endpoint', () => {
  assert.deepEqual(applyRanges(5, [[0, 3, 2], [1, 5, -1], [2, 2, 99]]), [2, 1, 1, -1, -1]);
  assert.deepEqual(applyRanges(0, []), []);
});

test('2D prefix queries agree with a direct scan for all rectangles', () => {
  const matrix = [[1, -2, 3], [4, 0, 5]];
  const prefix = matrixSums(matrix);
  for (let top = 0; top <= 2; top++) for (let bottom = top; bottom <= 2; bottom++) {
    for (let left = 0; left <= 3; left++) for (let right = left; right <= 3; right++) {
      const expected = matrix.slice(top, bottom).flatMap(row => row.slice(left, right)).reduce((a, b) => a + b, 0);
      assert.equal(rectSum(prefix, top, left, bottom, right), expected);
    }
  }
  assert.equal(rectSum(matrixSums([]), 0, 0, 0, 0), 0);
});

test('monotonic structures handle equal values and immediate expiration', () => {
  assert.deepEqual(nextGreater([2, 2, 3, 1]), [2, 2, -1, -1]);
  assert.deepEqual(nextGreater([]), []);
  const values = [9, 2, 2, 5, -1, 3];
  for (let width = 1; width <= values.length; width++) {
    const naive = values.slice(width - 1).map((_, i) => Math.max(...values.slice(i, i + width)));
    assert.deepEqual(slidingMax(values, width), naive);
  }
  assert.deepEqual(slidingMax(values, 0), []);
});

test('count strict inversions without changing the input', () => {
  const values = [3, 1, 2, 1];
  assert.equal(inversionCount(values), 4);
  assert.deepEqual(values, [3, 1, 2, 1]);
  assert.equal(inversionCount([]), 0);
});

test('trie separates complete words from prefixes and traverses Unicode code points', () => {
  const trie = new Trie();
  trie.add('😀ab');
  assert.equal(trie.has('😀'), false);
  assert.equal(trie.hasPrefix('😀'), true);
  trie.add('😀');
  trie.add('😀');
  assert.equal(trie.has('😀'), true);
  assert.equal(trie.hasPrefix('no'), false);
});

test('disjoint sets merge components and Kruskal rejects disconnected graphs', () => {
  const sets = new DisjointSet(4);
  assert.equal(sets.union(0, 1), true);
  assert.equal(sets.union(1, 0), false);
  assert.equal(sets.union(2, 1), true);
  assert.equal(sets.find(0), sets.find(2));
  assert.notEqual(sets.find(0), sets.find(3));
  assert.equal(minimumSpanningWeight(4, [[0, 1, 5], [1, 2, -1], [0, 2, 1], [2, 3, 2]]), 2);
  assert.equal(minimumSpanningWeight(3, [[0, 1, 2]]), null);
  assert.equal(minimumSpanningWeight(1, []), 0);
});

test('Dijkstra replaces a tentative distance and handles 0 weight and unreachable points', () => {
  const graph = new Map([['a', [['b', 8], ['c', 1]] as const], ['c', [['b', 0]] as const], ['z', [] as const]]);
  assert.deepEqual(shortestCosts(graph, 'a'), new Map([['a', 0], ['b', 1], ['c', 1]]));
  assert.throws(() => shortestCosts(new Map([['a', [['b', -2]]]]), 'a'), /weight/);
});

test('knapsack cannot reuse an item and accepts a perfect fit', () => {
  assert.equal(knapsack01([[2, 4]], 4), 4);
  assert.equal(knapsack01([[2, 4], [3, 7], [4, 8]], 5), 11);
  assert.equal(knapsack01([], 4), 0);
});

test('edit distance handles insert, replace and empty strings', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('', '😀a'), 2);
  assert.equal(editDistance('😀a', '😀a'), 0);
  assert.equal(editDistance('ab', 'ba'), 2);
});

test('LIS must be strictly increasing, not nondecreasing', () => {
  assert.equal(lisLength([3, 5, 2, 2, 4, 7]), 3);
  assert.equal(lisLength([3, 3, 3]), 1);
  assert.equal(lisLength([]), 0);
});

test('interval DP chooses the final pop inside each interval', () => {
  assert.equal(maxBalloonScore([3, 1, 5, 8]), 167);
  assert.equal(maxBalloonScore([7]), 7);
  assert.equal(maxBalloonScore([]), 0);
});

test('digit DP agrees with brute force across irregular upper bounds', () => {
  let expected = 0;
  for (let ceiling = 0; ceiling <= 100; ceiling++) {
    if (!ceiling.toString(2).includes('11')) expected++;
    assert.equal(countAtMostWithoutAdjacentOnes(ceiling), expected);
  }
});

test('number theory helpers handle signs, small limits and large integer powers', () => {
  assert.equal(gcd(-54n, 24n), 6n);
  assert.equal(gcd(0n, 0n), 0n);
  assert.deepEqual(primesThrough(12), [2, 3, 5, 7, 11]);
  assert.deepEqual(primesThrough(1), []);
  assert.equal(modPow(-3n, 5n, 13n), 4n);
  assert.equal(modPow(2n, 0n, 1n), 0n);
  assert.equal(modPow(17n, 100n, 97n), 17n ** 100n % 97n);
});
