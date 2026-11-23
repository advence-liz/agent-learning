import { bracketsValid, reverseList } from '../src/structures.ts';

let node = reverseList({ value: 1, next: { value: 2, next: { value: 3, next: null } } });
const values: number[] = [];
while (node !== null) {
  values.push(node.value);
  node = node.next;
}
console.log('reversed:', values.join(' -> '));
console.log('([)] is valid:', bracketsValid('([)]'));
