import { applyRanges, inversionCount, matrixSums, rectSum, slidingMax } from '../src/ranges.ts';
import { Trie, minimumSpanningWeight, shortestCosts } from '../src/advanced-graphs.ts';
import { countAtMostWithoutAdjacentOnes, editDistance, knapsack01, lisLength, maxBalloonScore } from '../src/dynamic.ts';
import { gcd, modPow, primesThrough } from '../src/math.ts';

console.log('range add:', JSON.stringify(applyRanges(5, [[0, 3, 2], [1, 5, -1]])));
console.log('rectangle:', rectSum(matrixSums([[1, -2, 3], [4, 0, 5]]), 0, 1, 2, 3));
console.log('window max:', JSON.stringify(slidingMax([9, 2, 2, 5], 2)));
console.log('inversions:', inversionCount([3, 1, 2, 1]));
const trie = new Trie();
trie.add('cart');
console.log('car: prefix / complete:', trie.hasPrefix('car'), '/', trie.has('car'));
const graph = new Map([['a', [['b', 8], ['c', 1]] as const], ['c', [['b', 0]] as const]]);
console.log('shortest costs:', JSON.stringify(Object.fromEntries(shortestCosts(graph, 'a'))));
console.log('spanning weight:', minimumSpanningWeight(4, [[0, 1, 5], [1, 2, -1], [0, 2, 1], [2, 3, 2]]));
console.log('knapsack, edit distance, LIS:', knapsack01([[2, 4]], 4), editDistance('ab', 'ba'), lisLength([3, 5, 2, 2, 4, 7]));
console.log('interval and digit DP:', maxBalloonScore([3, 1, 5, 8]), countAtMostWithoutAdjacentOnes(5));
console.log('gcd and modPow:', String(gcd(-54n, 24n)), String(modPow(3n, 13n, 11n)));
console.log('primes:', JSON.stringify(primesThrough(12)));
