import { longestUnique, lowerBound, sortedPair } from '../src/pointers.ts';

console.log('sorted pair:', JSON.stringify(sortedPair([1, 3, 4, 7], 7)));
console.log('longest unique:', longestUnique('abba'));
console.log('first >= 2:', lowerBound([1, 2, 2, 4], 2));
