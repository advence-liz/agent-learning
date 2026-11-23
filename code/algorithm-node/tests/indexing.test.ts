import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countSubarrays, Fenwick, matchStarts } from '../src/indexing.ts';

test('prefix counts match brute force including zero and negative values', () => {
  for (const values of [[], [0, 0, 0], [1, -1, 1], [-5, 2, 4, -1]]) {
    for (let target = -3; target <= 4; target++) {
      let count = 0;
      for (let left = 0; left < values.length; left++) {
        for (let right = left + 1; right <= values.length; right++) {
          if (values.slice(left, right).reduce((a, b) => a + b, 0) === target) count++;
        }
      }
      assert.equal(countSubarrays(values, target), count);
    }
  }
});

test('Fenwick queries agree with a mutable baseline after positive and negative updates', () => {
  const values = [2, 4, 6, 8];
  const tree = new Fenwick(values.length);
  for (const [index, value] of values.entries()) tree.add(index, value);
  for (const [index, delta] of [[1, 5], [3, -8], [0, -4]]) {
    tree.add(index, delta);
    values[index] += delta;
    for (let left = 0; left <= values.length; left++) {
      for (let right = left; right <= values.length; right++) {
        assert.equal(tree.sum(left, right), values.slice(left, right).reduce((a, b) => a + b, 0));
      }
    }
  }
  assert.throws(() => tree.add(-1, 5), /bounds/);
  assert.throws(() => tree.sum(0, 5), /bounds/);
  assert.equal(new Fenwick(0).sum(0, 0), 0);
});

test('KMP includes overlapping matches and returns code point offsets', () => {
  assert.deepEqual(matchStarts('ababa', 'aba'), [0, 2]);
  assert.deepEqual(matchStarts('😀x😀x', 'x'), [1, 3]);
  assert.deepEqual(matchStarts('aaa', 'aa'), [0, 1]);
  assert.deepEqual(matchStarts('ababcababa', 'ababa'), [5]);
  assert.deepEqual(matchStarts('short', 'long pattern'), []);
  assert.deepEqual(matchStarts('text', ''), []);
});
