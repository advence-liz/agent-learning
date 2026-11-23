import { distanceFrom, treeDepth } from '../src/traversal.ts';

const leaf = { left: null, right: null };
console.log('tree depth:', treeDepth({ left: { left: leaf, right: null }, right: leaf }));
const graph = new Map([['A', ['B', 'D']], ['B', ['C']], ['C', ['D', 'A']], ['D', ['A']]]);
console.log('distance from A:', JSON.stringify(Object.fromEntries(distanceFrom(graph, 'A'))));
