import { planTasks } from '../src/planner.ts';

console.log('plan:', JSON.stringify(planTasks([
  { id: 'deploy', priority: 100, needs: ['build', 'test'] },
  { id: 'test', priority: 2, needs: ['build'] },
  { id: 'lint', priority: 2, needs: [] },
  { id: 'build', priority: 2, needs: [] },
  { id: 'docs', priority: 1, needs: [] },
])));
console.log('cycle:', JSON.stringify(planTasks([
  { id: 'report', priority: 5, needs: ['b'] },
  { id: 'b', priority: 0, needs: ['a'] },
  { id: 'a', priority: 0, needs: ['b'] },
  { id: 'free', priority: 0, needs: [] },
])));
