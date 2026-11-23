import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prefixSums, rangeSum, twoSum } from '../src/arrays.ts';
import { longestUnique, lowerBound, sortedPair } from '../src/pointers.ts';
import { bracketsValid, reverseList, type ListNode } from '../src/structures.ts';
import { distanceFrom, treeDepth } from '../src/traversal.ts';
import { maxNonOverlapping, minCoins, subsets } from '../src/choices.ts';
import { BinaryHeap, largestK, mergeSort } from '../src/ordering.ts';
import { planTasks } from '../src/planner.ts';

test('twoSum never reuses an index and handles duplicate values', () => {
  assert.deepEqual(twoSum([4, 4], 8), [0, 1]);
  assert.equal(twoSum([4], 8), null);
  assert.deepEqual(twoSum([-3, 5, 2], -1), [0, 2]);
});

test('prefix sums answer every half-open range like slicing and summing', () => {
  const values = [3, -2, 7, 0, -4];
  const prefix = prefixSums(values);
  for (let left = 0; left <= values.length; left++) {
    for (let right = left; right <= values.length; right++) {
      assert.equal(rangeSum(prefix, left, right), values.slice(left, right).reduce((a, b) => a + b, 0));
    }
  }
  assert.equal(rangeSum(prefixSums([]), 0, 0), 0);
});

test('sorted pair lookup returns distinct indexes or null', () => {
  assert.deepEqual(sortedPair([-5, 2, 4, 6], 1), [0, 3]);
  assert.deepEqual(sortedPair([2, 2], 4), [0, 1]);
  assert.equal(sortedPair([2], 4), null);
  assert.equal(sortedPair([], 4), null);
});

test('window does not rewind past its left edge and counts Unicode code points', () => {
  assert.equal(longestUnique('abba'), 2);
  assert.equal(longestUnique('a😀b😀c'), 3);
  assert.equal(longestUnique(''), 0);
});

test('lower bound matches a linear scan for duplicates, gaps, and extremes', () => {
  for (const values of [[], [2], [1, 2, 2, 4, 7]]) {
    for (let wanted = -1; wanted <= 8; wanted++) {
      const linear = values.findIndex(value => value >= wanted);
      assert.equal(lowerBound(values, wanted), linear < 0 ? values.length : linear);
    }
  }
});

test('link reversal reuses the nodes and cuts the original head link', () => {
  const last: ListNode = { value: 3, next: null };
  const middle: ListNode = { value: 2, next: last };
  const first: ListNode = { value: 1, next: middle };
  assert.equal(reverseList(first), last);
  assert.equal(last.next, middle);
  assert.equal(middle.next, first);
  assert.equal(first.next, null);
  assert.equal(reverseList(null), null);
});

test('brackets must close in reverse order, not just in matching counts', () => {
  for (const text of ['', '([]){}', '(()[])']) assert.equal(bracketsValid(text), true);
  for (const text of ['([)]', ')', '(', 'a']) assert.equal(bracketsValid(text), false);
});

test('tree depth is counted in nodes, including the root', () => {
  assert.equal(treeDepth(null), 0);
  assert.equal(treeDepth({ left: null, right: null }), 1);
  assert.equal(treeDepth({ left: { left: null, right: null }, right: null }), 2);
});

test('graph distances use the fewest edges and omit unreachable vertices', () => {
  const graph = new Map([['A', ['B', 'D']], ['B', ['C']], ['C', ['D', 'A']], ['D', ['A']], ['E', []]]);
  assert.deepEqual(distanceFrom(graph, 'A'), new Map([['A', 0], ['B', 1], ['D', 1], ['C', 2]]));
  assert.deepEqual(distanceFrom(graph, 'E'), new Map([['E', 0]]));
});

test('backtracking saves independent snapshots, including the empty subset', () => {
  const paths = subsets([1, 2]);
  assert.deepEqual(paths, [[], [1], [1, 2], [2]]);
  paths[1].push(99);
  assert.deepEqual(paths[2], [1, 2]);
  assert.deepEqual(subsets([]), [[]]);
});

test('minimum coins beats largest-coin-first, supports reuse and detects impossibility', () => {
  assert.equal(minCoins([1, 3, 4], 6), 2);
  assert.equal(minCoins([2], 3), -1);
  assert.equal(minCoins([], 0), 0);
});

test('interval selection sorts by end, accepts touching endpoints, and keeps input intact', () => {
  const intervals = [[0, 10], [5, 7], [3, 5], [1, 3]] as const;
  assert.deepEqual(maxNonOverlapping(intervals), [[1, 3], [3, 5], [5, 7]]);
  assert.deepEqual(intervals[0], [0, 10]);
  assert.deepEqual(maxNonOverlapping([]), []);
});

test('merge sort and top K agree with numeric sorting on a range of inputs', () => {
  for (const values of [[], [2], [1, 2, 3, 4], [8, 7, 6, 5, 4], [4, -10, 2, 10, 4, -2]]) {
    const snapshot = [...values];
    assert.deepEqual(mergeSort(values), [...values].sort((a, b) => a - b));
    for (let k = 0; k <= values.length + 1; k++) {
      assert.deepEqual(largestK(values, k), [...values].sort((a, b) => b - a).slice(0, k));
    }
    assert.deepEqual(values, snapshot);
  }
});

test('heap stays ordered when push and pop are interleaved', () => {
  const heap = new BinaryHeap<number>((a, b) => a - b);
  assert.equal(heap.pop(), undefined);
  for (const value of [4, 9, 1, 2, 2]) heap.push(value);
  assert.equal(heap.peek(), 1);
  assert.equal(heap.pop(), 1);
  heap.push(0);
  assert.deepEqual(Array.from({ length: 5 }, () => heap.pop()), [0, 2, 2, 4, 9]);
  assert.equal(heap.size, 0);
});

test('planner only prioritizes ready tasks and uses a stable tie rule', () => {
  const tasks = [
    { id: 'deploy', priority: 100, needs: ['build', 'test'] },
    { id: 'test', priority: 2, needs: ['build'] },
    { id: 'lint', priority: 2, needs: [] },
    { id: 'build', priority: 2, needs: [] },
    { id: 'docs', priority: 1, needs: [] },
  ];
  const expected = { order: ['build', 'lint', 'test', 'deploy', 'docs'], blocked: [] };
  assert.deepEqual(planTasks(tasks), expected);
  assert.deepEqual(planTasks([...tasks].reverse()), expected);
  assert.deepEqual(planTasks([]), { order: [], blocked: [] });
});

test('planner separates schedulable tasks from cycles and their downstream tasks', () => {
  assert.deepEqual(planTasks([
    { id: 'report', priority: 5, needs: ['b'] },
    { id: 'b', priority: 0, needs: ['a'] },
    { id: 'a', priority: 0, needs: ['b'] },
    { id: 'self', priority: 0, needs: ['self'] },
    { id: 'free', priority: 0, needs: [] },
  ]), { order: ['free'], blocked: ['a', 'b', 'report', 'self'] });
});

test('planner rejects malformed inputs rather than reporting them as cycles', () => {
  const a = { id: 'a', priority: 0, needs: [] };
  assert.throws(() => planTasks([a, a]), /duplicate task/);
  assert.throws(() => planTasks([{ ...a, needs: ['missing'] }]), /unknown dependency/);
  assert.throws(() => planTasks([a, { id: 'b', priority: 0, needs: ['a', 'a'] }]), /duplicate dependency/);
  assert.throws(() => planTasks([{ ...a, priority: NaN }]), /invalid priority/);
});
