import { largestK, mergeSort } from '../src/ordering.ts';

const values = [4, 9, 1, 9, 2];
console.log('sorted:', JSON.stringify(mergeSort(values)));
console.log('top 3:', JSON.stringify(largestK(values, 3)));
