import { maxNonOverlapping, minCoins, subsets } from '../src/choices.ts';

console.log('subsets:', JSON.stringify(subsets([1, 2])));
console.log('min coins:', minCoins([1, 3, 4], 6));
console.log('meetings:', JSON.stringify(maxNonOverlapping([[0, 10], [5, 7], [3, 5], [1, 3]])));
