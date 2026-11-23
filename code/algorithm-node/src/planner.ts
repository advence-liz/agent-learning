import { BinaryHeap } from './ordering.ts';

export interface Task {
  id: string;
  priority: number;
  needs: readonly string[];
}

export function planTasks(tasks: readonly Task[]): { order: string[]; blocked: string[] } {
  const byId = new Map<string, Task>();
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    if (byId.has(task.id)) throw new Error(`duplicate task: ${task.id}`);
    if (!Number.isFinite(task.priority)) throw new Error(`invalid priority: ${task.id}`);
    byId.set(task.id, task);
    remaining.set(task.id, task.needs.length);
    dependents.set(task.id, []);
  }
  for (const task of tasks) {
    const seen = new Set<string>();
    for (const need of task.needs) {
      const next = dependents.get(need);
      if (next === undefined) throw new Error(`unknown dependency: ${task.id} needs ${need}`);
      if (seen.has(need)) throw new Error(`duplicate dependency: ${task.id} needs ${need}`);
      seen.add(need);
      next.push(task.id);
    }
  }

  const ready = new BinaryHeap<Task>((a, b) =>
    b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const task of tasks) if (task.needs.length === 0) ready.push(task);

  const order: string[] = [];
  while (ready.size > 0) {
    const task = ready.pop()!;
    order.push(task.id);
    for (const id of dependents.get(task.id)!) {
      const count = remaining.get(id)! - 1;
      remaining.set(id, count);
      if (count === 0) ready.push(byId.get(id)!);
    }
  }
  const blocked = tasks.filter(task => remaining.get(task.id)! > 0).map(task => task.id).sort();
  return { order, blocked };
}
