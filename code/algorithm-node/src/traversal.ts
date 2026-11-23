export interface TreeNode {
  left: TreeNode | null;
  right: TreeNode | null;
}

export function treeDepth(node: TreeNode | null): number {
  if (node === null) return 0;
  return 1 + Math.max(treeDepth(node.left), treeDepth(node.right));
}

export function distanceFrom(
  graph: ReadonlyMap<string, readonly string[]>, start: string,
): Map<string, number> {
  const distance = new Map([[start, 0]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const vertex = queue[head];
    const nextDistance = distance.get(vertex)! + 1;
    for (const neighbor of graph.get(vertex) ?? []) {
      if (distance.has(neighbor)) continue;
      distance.set(neighbor, nextDistance);
      queue.push(neighbor);
    }
  }
  return distance;
}
