import type OpenAI from 'openai';

// 直接复用 SDK 消息协议，额外保留 DeepSeek 的 reasoning_content 扩展。
export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type Assistant = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & { reasoning_content?: string | null };
export type ToolDefinition = OpenAI.Chat.Completions.ChatCompletionTool;
export type Turn = { message: Assistant; stop: 'tool_calls' | 'stop' | 'length' | 'refusal'; inputTokens: number; outputTokens: number };
export interface Model { next(messages: Message[], tools: ToolDefinition[], signal: AbortSignal): Promise<Turn> }
export type Citation = { id: string; quote: string };
export type Answer = { kind: 'grounded' | 'not_found'; answer: string; citations: Citation[] };
export type AgentState = { messages: Message[]; evidence: Record<string, string>; answer: Answer | null; steps: number; tokens: number; inputTokens: number; outputTokens: number };
export type Context = { tenant: string; signal: AbortSignal };
export type Trace = { type: string; data: unknown };
export type Status = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'cancelled' | 'failed';
export type Run = { id: string; tenant: string; requestKey: string; prompt: string; publish: boolean; status: Status; state: AgentState; owner: string | null; leaseUntil: number; deadline: number; error: string | null };
export type Event = { runId: string; seq: number; type: string; data: unknown };
export class AppError extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = 'AppError'; this.code = code; }
}
export class TransientError extends AppError {}
export function fail(code: string): never { throw new AppError(code); }
export function checkAbort(signal: AbortSignal): void { signal.throwIfAborted(); }

// Promise.race 使不合作的模型实现也无法拖住任务；底层 SDK 同时收到取消信号。
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason ?? new AppError('CANCELLED'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', listener); }
}
