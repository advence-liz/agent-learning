import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadLocalSettings } from '../src/settings.ts';
import { check, disableImplicitTracing } from '../src/domain.ts';

const entries: Record<string, string> = { server: '../src/server.ts', gateway: '../src/gateway.ts', worker: '../src/worker.ts', demo: './demo.ts', migrate: './migrate.ts', seed: './seed.ts', evaluate: './evaluate.ts', 'prompt-seed': './prompt-seed.ts' };
const [name, ...args] = process.argv.slice(2); check(Object.hasOwn(entries, name), 'INVALID_ENTRYPOINT');
const files = ['../.env.example', '../.env'].map(path => new URL(path, import.meta.url)).filter(path => existsSync(path)).map(path => readFileSync(path, 'utf8'));
const env = loadLocalSettings(files, process.env);
for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
disableImplicitTracing();
if (!['gateway', 'demo'].includes(name)) for (const key of ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[key];
const entry = new URL(entries[name], import.meta.url);
process.argv = [process.execPath, fileURLToPath(entry), ...args];
await import(entry.href);
