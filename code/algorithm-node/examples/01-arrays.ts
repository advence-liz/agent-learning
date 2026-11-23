import { prefixSums, rangeSum, twoSum } from '../src/arrays.ts';

console.log('twoSum:', JSON.stringify(twoSum([4, 4, 9], 8)));
console.log('range [1, 3):', rangeSum(prefixSums([3, -2, 7, 0]), 1, 3));
