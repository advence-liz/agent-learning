import { evaluate } from '../src/eval.ts';

const report = await evaluate();
console.table(report.results);
console.log(`${report.passed}/${report.total}；${report.mode}`);
console.log('练习：把 tools.ts 中 tenant 过滤移除，观察回归是否转红，然后恢复。不要用改预期来“修”回归。');
if (report.passed !== report.total) process.exitCode = 1;
