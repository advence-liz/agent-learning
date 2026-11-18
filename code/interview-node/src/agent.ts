import type { AgentState, Context, Model, Trace, Turn } from './types.ts';
import { AppError, TransientError, abortable, checkAbort, fail } from './types.ts';
import { KnowledgeTools, toolDefinitions } from './tools.ts';
import { SYSTEM } from './model.ts';
import { setTimeout as delay } from 'node:timers/promises';

export type Limits = { maxSteps: number; maxTokens: number; maxContextBytes: number; turnTimeoutMs: number; retries: number };
export const defaults: Limits = { maxSteps: 8, maxTokens: 12_000, maxContextBytes: 40_000, turnTimeoutMs: 30_000, retries: 1 };
export function createState(prompt: string): AgentState {
  if (!prompt.trim() || prompt.length > 2000) fail('INVALID_PROMPT');
  return { messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], evidence: {}, answer: null, steps: 0, tokens: 0, inputTokens: 0, outputTokens: 0 };
}

// 只推进一个模型轮次，便于内存示例与持久化 worker 共享同一个内核。
export async function advance(state: AgentState, model: Model, tools: KnowledgeTools, ctx: Context, options: Partial<Limits> = {}, trace: Trace[] = []): Promise<boolean> {
  const limits = { ...defaults, ...options };
  checkAbort(ctx.signal);
  if (state.answer) return true;
  if (state.steps >= limits.maxSteps) fail('STEP_LIMIT');
  if (state.tokens >= limits.maxTokens) fail('TOKEN_LIMIT');
  if (Buffer.byteLength(JSON.stringify(state.messages)) > limits.maxContextBytes) fail('CONTEXT_LIMIT');
  const controller = new AbortController();
  const signal = AbortSignal.any([ctx.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(new AppError('TURN_TIMEOUT')), limits.turnTimeoutMs);
  let turn!: Turn;
  try {
    for (let attempt = 0; ; attempt++) {
      try { turn = await abortable(model.next(structuredClone(state.messages), toolDefinitions, signal), signal); break; }
      catch (error) {
        if (!(error instanceof TransientError) || attempt >= limits.retries || signal.aborted) throw error;
        trace.push({ type: 'model.retry', data: { attempt: attempt + 1 } });
        await delay(50 * 2 ** attempt + Math.floor(Math.random() * 30), undefined, { signal });
      }
    }
    checkAbort(signal);
    state.steps++;
    state.inputTokens += turn.inputTokens; state.outputTokens += turn.outputTokens;
    state.tokens += turn.inputTokens + turn.outputTokens;
    trace.push({ type: 'model.finished', data: { step: state.steps, inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, stop: turn.stop } });
    if (state.tokens > limits.maxTokens) fail('TOKEN_LIMIT');
    if (turn.stop === 'length') fail('MODEL_TRUNCATED');
    if (turn.stop === 'refusal') fail('MODEL_REFUSAL');
    const calls = turn.message.tool_calls ?? [];
    if (turn.stop !== 'tool_calls' || !calls.length || calls.length > 4) fail('EXPECTED_TOOL_CALL');
    if (new Set(calls.map(c => c.id)).size !== calls.length) fail('DUPLICATE_CALL_ID');
    if (calls.some(c => c.type !== 'function')) fail('UNSUPPORTED_TOOL_CALL');
    if (calls.length > 1 && calls.some(c => c.type === 'function' && c.function.name === 'submit_answer')) fail('AMBIGUOUS_FINAL_TURN');
    // 完整保留 content / tool_calls / reasoning_content，不能只存可见文字。
    state.messages.push(structuredClone(turn.message));
    for (const item of calls) {
      if (item.type !== 'function') fail('UNSUPPORTED_TOOL_CALL');
      checkAbort(signal);
      let output: unknown;
      try {
        const input: unknown = JSON.parse(item.function.arguments);
        output = await abortable(tools.execute(item.function.name, input, state, { ...ctx, signal }), signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        output = { error: error instanceof AppError ? error.code : error instanceof SyntaxError ? 'INVALID_JSON' : 'TOOL_FAILED', hint: '检查工具名、必填字段与文档 ID；不要重复相同的错误调用。' };
      }
      state.messages.push({ role: 'tool', tool_call_id: item.id, content: JSON.stringify(output) });
      trace.push({ type: 'tool.finished', data: { callId: item.id, tool: item.function.name, error: typeof output === 'object' && output !== null && 'error' in output ? output.error : null } });
    }
    return state.answer !== null;
  } finally { clearTimeout(timer); }
}

export async function runInMemory(prompt: string, model: Model, tenant = 'alpha', limits: Partial<Limits> = {}) {
  const state = createState(prompt); const trace: Trace[] = []; const controller = new AbortController();
  while (!await advance(state, model, new KnowledgeTools(), { tenant, signal: controller.signal }, limits, trace)) { /* 模型决定下一步，宿主负责边界 */ }
  return { state, trace };
}
