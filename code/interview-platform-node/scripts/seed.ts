import { createPool } from '../src/repository.ts';
import { seed } from '../src/seed.ts';
const pool = createPool();
try { await seed(pool); console.log('四篇虚构教学文档已幂等写入。'); }
finally { await pool.end(); }
