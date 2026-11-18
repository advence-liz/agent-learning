import { createPool, migrate } from '../src/repository.ts';
const pool = createPool();
try { await migrate(pool); console.log('业务表与 LangGraph PostgreSQL checkpointer 已迁移。'); }
finally { await pool.end(); }
