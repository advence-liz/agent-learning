/**
 * 第 7 章：同一个「读文件 → 改文件」任务，用 Vercel AI SDK（npm 包 ai）写。
 *
 * Node 生态里对应 Pydantic AI 位置的是 Vercel AI SDK：模型无关的 Agent 抽象 + 类型化工具 + 结构化输出。
 * 离线：ai/test 的 MockLanguageModelV4 让我们用一个函数扮演模型（AI SDK 官方提供的测试替身）。
 * 真实：把 new MockLanguageModelV4(...) 换成 anthropic("claude-opus-5-5") 即可（需要 npm 包 @ai-sdk/anthropic）。
 * node sdk_compare/ai_sdk_agent.ts
 */

import { Output, ToolLoopAgent, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

export const FILES: Record<string, string> = { "calc.py": "def add(a, b):\n    return a - b\n" };

const Report = z.object({ fixed: z.boolean(), summary: z.string() }); // 输出也是带校验的类型（对应 Pydantic 的 BaseModel）

const usage = { inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
let callId = 0;
const call = (toolName: string, input: object) => ({
  content: [{ type: "tool-call" as const, toolCallId: `call_${++callId}`, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
  usage,
  warnings: [],
});

export const model = new MockLanguageModelV4({
  // 和 Pydantic AI 的 FunctionModel 一样：看到目前为止有几个工具结果，决定下一步
  doGenerate: async ({ prompt }) => {
    const returns = prompt.flatMap((m) => (m.role === "tool" ? m.content : [])).filter((p) => p.type === "tool-result");
    if (returns.length === 0) return call("read_file", { path: "calc.py" });
    if (returns.length === 1) return call("write_file", { path: "calc.py", content: "def add(a, b):\n    return a + b\n" });
    // 结构化输出在 AI SDK 里不是工具：请求带 responseFormat=json + schema，模型最后一步直接输出 JSON 文本
    return {
      content: [{ type: "text", text: JSON.stringify({ fixed: true, summary: "把 a - b 改成 a + b" }) }],
      finishReason: { unified: "stop", raw: "end_turn" },
      usage,
      warnings: [],
    };
  },
});

export const agent = new ToolLoopAgent({
  model,
  instructions: "你是编程 Agent。",
  output: Output.object({ schema: Report }),
  tools: {
    read_file: tool({
      description: "读取文件内容。",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => FILES[path],
    }),
    write_file: tool({
      description: "覆盖写入文件。",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        FILES[path] = content;
        return "ok";
      },
    }),
  },
});

if (import.meta.main) {
  const r = await agent.generate({ prompt: "修好 calc.py" });
  console.log("output:", r.output);
  console.log("messages:", r.responseMessages.map((m) => m.role)); // 不含最初那条 user prompt
  console.log("calc.py:", FILES["calc.py"].split("\n")[1].trim());
  const { inputTokens, outputTokens } = r.totalUsage;
  const toolCalls = r.steps.flatMap((s) => s.toolCalls).length;
  console.log(`usage: requests=${r.steps.length} tool_calls=${toolCalls} input_tokens=${inputTokens} output_tokens=${outputTokens}`);
}
