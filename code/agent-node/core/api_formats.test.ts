import assert from "node:assert/strict";
import { test } from "node:test";

import { sendAll } from "./api_formats.ts";

test("三种格式上线的字节", async () => {
  const [results, seen] = await sendAll();
  const byPath = Object.fromEntries(seen.map((c) => [c.path, c]));
  const [a, c, r] = [byPath["/v1/messages"], byPath["/v1/chat/completions"], byPath["/v1/responses"]];

  // 鉴权头：Anthropic 多一个 anthropic-version；OpenAI 两种格式是 Bearer、没有 x-api-key。
  // 注意：@anthropic-ai/sdk 1.1.0 把 apiKey 放在 Authorization: Bearer 里发（Python SDK 用 x-api-key）
  assert.ok(a.headers["anthropic-version"]);
  assert.equal(a.headers["authorization"], "Bearer sk-fake-not-a-real-key");
  assert.ok(c.headers["authorization"].startsWith("Bearer ") && !("x-api-key" in c.headers));
  assert.ok(!("anthropic-version" in c.headers));

  // system 放在哪
  assert.equal(typeof a.body.system, "string");
  assert.ok(a.body.messages.every((m: any) => m.role !== "system"));
  assert.equal(c.body.messages[0].role, "system");
  assert.ok("instructions" in r.body && !("messages" in r.body));

  // 工具定义的嵌套
  assert.ok("input_schema" in a.body.tools[0]);
  assert.ok("parameters" in c.body.tools[0].function);
  assert.ok("parameters" in r.body.tools[0] && !("function" in r.body.tools[0]));

  // 工具结果怎么回去
  assert.equal(a.body.messages.at(-1).content[0].type, "tool_result");
  assert.equal(c.body.messages.at(-1).role, "tool");
  assert.equal(r.body.input.at(-1).type, "function_call_output");
  // OpenAI 两种格式里工具参数是 JSON 字符串，Anthropic 是对象
  assert.equal(typeof c.body.messages[2].tool_calls[0].function.arguments, "string");
  assert.equal(typeof a.body.messages[1].content[0].input, "object");

  // 三种响应解析成同一个结果
  assert.deepEqual(new Set(Object.values(results).map((u) => u.text)), new Set(["超时是 15000ms。"]));
  assert.equal(results.anthropic.stop, "end_turn");
  assert.equal(results.chat_completions.stop, "stop");
});
