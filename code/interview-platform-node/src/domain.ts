import { z } from 'zod';

export const answerSchema = z.object({
  kind: z.enum(['grounded', 'not_found']),
  answer: z.string().min(1).max(6000),
  citations: z.array(z.object({ id: z.string().min(1).max(100), quote: z.string().min(1).max(600) }).strict()).max(4),
}).strict().meta({ title: 'research_answer' });
export type Answer = z.infer<typeof answerSchema>;
export type Status = 'queued' | 'running' | 'waiting_approval' | 'publishing' | 'completed' | 'cancelled' | 'failed';
export type Run = { id: string; tenant: string; request_key: string; prompt: string; status: Status; owner: string | null; answer: Answer | null; error: string | null; deadline: Date; prompt_version: string; system_prompt: string; input_tokens: number; output_tokens: number; publish_attempts: number };
export class AppError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export function check(condition: unknown, code: string): asserts condition { if (!condition) throw new AppError(code); }
export function localURL(value: string, allowExternal = false): URL {
  const url = new URL(value);
  check(['http:', 'https:', 'postgres:', 'postgresql:'].includes(url.protocol), 'INVALID_URL');
  check(allowExternal || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'EXTERNAL_ENDPOINT_DISABLED');
  return url;
}
export function databaseURL() {
  const value = process.env.DATABASE_URL ?? 'postgres://agent_demo:local-demo-only@127.0.0.1:55432/agent_platform';
  const url = localURL(value, process.env.ALLOW_EXTERNAL_DATABASE === 'true');
  check(['postgres:', 'postgresql:'].includes(url.protocol), 'INVALID_DATABASE_PROTOCOL');
  // pg-connection-string 的 query 字段会覆盖 authority，默认拒绝所有覆盖项。
  check(!url.search && !url.hash, 'DATABASE_URL_OVERRIDES_DISABLED');
  return value;
}
export function disableImplicitTracing() {
  // legacy LANGCHAIN_TRACING 按字符串真值判断，不能简单写成字符串 "false"。
  for (const name of ['LANGSMITH_TRACING', 'LANGSMITH_TRACING_V2', 'LANGCHAIN_TRACING_V2', 'LANGCHAIN_TRACING', 'LANGCHAIN_VERBOSE']) delete process.env[name];
}
export function assertContextBudget(messages: readonly unknown[], systemMessage?: unknown) {
  check(Buffer.byteLength(JSON.stringify([...(systemMessage ? [systemMessage] : []), ...messages])) < 40_000, 'CONTEXT_LIMIT');
}
export const GLOBAL_CONCURRENCY = 2;
export const QUEUE_LIMIT = 128;
