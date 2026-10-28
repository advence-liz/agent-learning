import assert from "node:assert/strict";
import { test } from "node:test";

import type Anthropic from "@anthropic-ai/sdk";
import { ABORTED, TOOLS, addUserText, danglingToolUses, demoInterrupt, runGuarded } from "./guarded_loop.ts";
import { FakeAnthropic, text, toolUse } from "../fake_llm/index.ts";

const quiet = { log: () => {} };
const search = { search_logs: () => "hit" };
const start = (task = "x"): Anthropic.MessageParam[] => [{ role: "user", content: task }];

test("模型自己停下 → end_turn，不多调一次", async () => {
  const client = new FakeAnthropic([toolUse("search_logs", { query: "a" }), text("好了")]);
  const r = await runGuarded(client, start(), TOOLS, search, quiet);
  assert.deepEqual(r, { answer: "好了", stop: "end_turn", turns: 2 });
  assert.equal(client.calls.length, 2);
});

test("撞迭代上限 → 收口总结而不是抛错，收口请求禁用工具", async () => {
  const step = toolUse("search_logs", { query: "a" });
  const client = new FakeAnthropic([step, step, text("总结")]);
  const r = await runGuarded(client, start(), TOOLS, search, { ...quiet, maxTurns: 2 });
  assert.deepEqual(r, { answer: "总结", stop: "max_iterations", turns: 2 });
  const last = client.calls.at(-1)!;
  assert.deepEqual(last.tool_choice, { type: "none" });
  assert.ok(last.tools && last.tools.length > 0, "历史里有 tool_use，工具定义要保留");
  // 收口提示和最后一组 tool_result 在同一条 user 消息里
  const tail = last.messages.at(-1)!.content as any[];
  assert.deepEqual(tail.map((b) => b.type), ["tool_result", "text"]);
  assert.match(tail[1].text, /迭代上限 2/);
});

test("软预算只拦下一圈，正在跑的这圈照常做完", async () => {
  let t = 0;
  const now = () => t;
  const client = new FakeAnthropic([toolUse("search_logs", { query: "a" }), text("总结")]);
  const handlers = {
    search_logs: () => {
      t = 60_000; // 这圈的工具执行中时间用完了
      return "hit";
    },
  };
  const r = await runGuarded(client, start(), TOOLS, handlers, { ...quiet, softBudgetMs: 30_000, now });
  assert.equal(r.stop, "soft_budget");
  const results = client.calls[1].messages[2].content as any[];
  assert.equal(results[0].content, "hit"); // 已发出的工具调用没被丢弃
});

test("打断后补齐没执行的工具调用，历史不留半截", async () => {
  const [first, second, messages] = await demoInterrupt();
  assert.equal(first.stop, "interrupted");
  assert.equal(second.stop, "end_turn");
  assert.deepEqual(danglingToolUses(messages), []);
  const results = messages[2].content as any[];
  assert.equal(results[0].content, "120 passed, 0 failed");
  assert.deepEqual([results[1].content, results[1].is_error], [ABORTED, true]);
  // 用户的补充并进了同一条 user 消息，没有出现两条连续的 user
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
});

test("danglingToolUses 能发现缺回音的 tool_use", () => {
  const msgs: Anthropic.MessageParam[] = [
    { role: "user", content: "x" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "run_tests", input: {} }] },
  ];
  assert.deepEqual(danglingToolUses(msgs), ["t1"]);
  addUserText(msgs, "继续");
  assert.deepEqual(danglingToolUses(msgs), ["t1"]); // 只补文字不补 tool_result，仍然缺
});
