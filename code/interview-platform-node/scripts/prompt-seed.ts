import { seedLocalPrompt } from '../src/prompt-seed.ts';
const version = await seedLocalPrompt();
console.log(`本机 Prompt 已就绪；固定以下版本供 API 创建任务使用：\nPROMPT_NAME=${process.env.PROMPT_NAME ?? 'research-system'}\nPROMPT_VERSION=${version}`);
