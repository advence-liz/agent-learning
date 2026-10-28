/**
 * 第 2 章：同一段对话，三种线格式（wire format）。
 *
 * 一段「中性」的对话状态 → 分别序列化成 Anthropic Messages / OpenAI Chat Completions / OpenAI Responses
 * 的请求体，用一个假的 fetch 拦截（不发任何真实请求），打印真正上线的 JSON，再把三种响应解析回统一结构。
 *
 * 离线运行： node core/api_formats.ts [--compact]
 */

import Anthropic from "@anthropic-ai/sdk";

// ---------- 中性的对话状态：和任何厂商无关 ----------
export const SYSTEM = "你是 webapp 前端仓库的助手，回答要短。";
export const USER = "webapp 的 vitest 超时是多少？";
export const TOOL = {
  name: "read_file",
  description: "读取仓库里的一个文件",
  schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
} as const;
export const CALL = { id: "call_001", name: "read_file", args: { path: "apps/web/vitest.config.ts" } };
export const RESULT = "testTimeout: 15000";
export const MAX_TOKENS = 1024;
const FAKE_KEY = "sk-fake-not-a-real-key";

type Body = Record<string, any>;

export function anthropicBody(model = "claude-opus-5-5"): Body {
  return {
    model,
    max_tokens: MAX_TOKENS, // 必填
    system: SYSTEM, // 顶层字段，不在 messages 里
    tools: [{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.schema }],
    messages: [
      { role: "user", content: USER },
      { role: "assistant", content: [{ type: "tool_use", id: CALL.id, name: CALL.name, input: CALL.args }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: CALL.id, content: RESULT }] },
    ],
  };
}

export function chatCompletionsBody(model = "your-openai-model"): Body {
  return {
    model,
    max_completion_tokens: MAX_TOKENS,
    tools: [{ type: "function", function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.schema } }],
    messages: [
      { role: "system", content: SYSTEM }, // system 是一条消息
      { role: "user", content: USER },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: CALL.id, type: "function", function: { name: CALL.name, arguments: JSON.stringify(CALL.args) } },
        ], // 参数是字符串
      },
      { role: "tool", tool_call_id: CALL.id, content: RESULT }, // 工具结果是独立角色
    ],
  };
}

export function responsesBody(model = "your-openai-model"): Body {
  return {
    model,
    instructions: SYSTEM,
    max_output_tokens: MAX_TOKENS,
    store: false,
    tools: [{ type: "function", name: TOOL.name, description: TOOL.description, parameters: TOOL.schema }], // 比 Chat Completions 少一层 function 嵌套
    input: [
      // 不叫 messages，叫 input，元素是「item」
      { role: "user", content: USER },
      { type: "function_call", call_id: CALL.id, name: CALL.name, arguments: JSON.stringify(CALL.args) },
      { type: "function_call_output", call_id: CALL.id, output: RESULT },
    ],
  };
}

// ---------- 三种响应（拦截器返回的假响应，形状照官方文档） ----------
export const ANSWER = "超时是 15000ms。";

const FAKE_RESPONSES: Record<string, Body> = {
  "/v1/messages": {
    id: "msg_fake", type: "message", role: "assistant", model: "claude-opus-5-5",
    content: [{ type: "text", text: ANSWER }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 12 },
  },
  "/v1/chat/completions": {
    id: "chatcmpl_fake", object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 },
  },
  "/v1/responses": {
    id: "resp_fake", object: "response", status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: ANSWER }] }],
    usage: { input_tokens: 120, output_tokens: 12, total_tokens: 132 },
  },
};

export interface Captured {
  path: string;
  headers: Record<string, string>;
  body: Body;
}

/** 假的 fetch：Python 版用 httpx.MockTransport，Node 里 SDK 和手写请求都走 fetch，换掉它就能拦截。 */
export function makeMock(): [typeof fetch, Captured[]] {
  const seen: Captured[] = [];
  const keep = ["authorization", "x-api-key", "anthropic-version", "content-type"];

  const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init); // 统一成 Request，headers 名字自动转小写
    const path = new URL(req.url).pathname;
    const headers: Record<string, string> = {};
    for (const [k, v] of req.headers) if (keep.includes(k)) headers[k] = v;
    seen.push({ path, headers, body: JSON.parse(await req.text()) });
    return new Response(JSON.stringify(FAKE_RESPONSES[path]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return [mockFetch as typeof fetch, seen];
}

export interface Unified {
  text: string;
  stop: string;
  inputTokens: number;
  outputTokens: number;
}

export async function sendAll(): Promise<[Record<string, Unified>, Captured[]]> {
  const [mockFetch, seen] = makeMock();
  const out: Record<string, Unified> = {};

  // Anthropic：用官方 SDK 发（看 SDK 真正替你加了哪些头），fetch 注入拦截器
  const client = new Anthropic({ apiKey: FAKE_KEY, baseURL: "https://api.example.invalid", fetch: mockFetch, maxRetries: 0 });
  const m = await client.messages.create(anthropicBody() as Anthropic.MessageCreateParamsNonStreaming);
  out.anthropic = {
    text: m.content.map((b) => (b.type === "text" ? b.text : "")).join(""),
    stop: m.stop_reason ?? "",
    inputTokens: m.usage.input_tokens,
    outputTokens: m.usage.output_tokens,
  };

  // OpenAI 两种格式：手写 fetch（本项目不装 openai SDK），鉴权是 Bearer
  const post = async (path: string, body: Body): Promise<Body> => {
    const resp = await mockFetch(`https://api.example.invalid${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${FAKE_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return resp.json();
  };
  const c = await post("/v1/chat/completions", chatCompletionsBody());
  out.chat_completions = {
    text: c.choices[0].message.content,
    stop: c.choices[0].finish_reason,
    inputTokens: c.usage.prompt_tokens,
    outputTokens: c.usage.completion_tokens,
  };
  const r = await post("/v1/responses", responsesBody());
  const text = r.output
    .filter((item: Body) => item.type === "message")
    .flatMap((item: Body) => item.content.filter((p: Body) => p.type === "output_text").map((p: Body) => p.text))
    .join("");
  out.responses = { text, stop: r.status, inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens };
  return [out, seen];
}

function mask(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(h).map(([k, v]) => [k, k === "authorization" || k === "x-api-key" ? v.slice(0, 12) + "…" : v]),
  );
}

if (import.meta.main) {
  const indent = process.argv.includes("--compact") ? undefined : 2;
  const [results, seen] = await sendAll();
  for (const cap of seen) {
    console.log(`===== POST ${cap.path}`);
    console.log("headers:", JSON.stringify(mask(cap.headers)));
    console.log(JSON.stringify(cap.body, null, indent));
  }
  console.log("===== 三种响应解析回统一结构（离线假 fetch，无真实请求）");
  for (const [name, u] of Object.entries(results)) {
    console.log(
      `${name.padEnd(17)} text=${JSON.stringify(u.text)} stop=${JSON.stringify(u.stop)} in=${u.inputTokens} out=${u.outputTokens}`,
    );
  }
}
