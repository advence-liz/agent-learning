import assert from "node:assert/strict";
import { test } from "node:test";

import { keywordJudge, makeLlmJudge, runGoal, scriptedWorker } from "./goal_loop.ts";
import { FakeAnthropic, text } from "../fake_llm/index.ts";

test("后台任务跳过评审后达成目标", async () => {
  const w = scriptedWorker([
    { text: "2 failed", toolCalls: 1 },
    { text: "bg", toolCalls: 1, backgroundRunning: true },
    { text: "0 failed", toolCalls: 1 },
    { text: "lint clean", toolCalls: 1 },
  ]);
  const r = await runGoal("cond", w, keywordJudge);
  assert.ok(r.outcome === "achieved" && r.turns === 4 && r.evaluations === 3);
});

test("连续无工具调用 → stalled", async () => {
  const w = scriptedWorker(Array(5).fill({ text: "我觉得已经好了", toolCalls: 0 }));
  const r = await runGoal("cond", w, keywordJudge);
  assert.ok(r.outcome === "stalled" && r.evaluations === 2);
});

test("impossible", async () => {
  const r = await runGoal("cond", scriptedWorker([{ text: "测试库无法访问", toolCalls: 1 }]), keywordJudge);
  assert.equal(r.outcome, "impossible");
});

test("LLM 评审用 fake client", async () => {
  const client = new FakeAnthropic([text(JSON.stringify({ status: "met", reason: "ok" }))]);
  const judge = makeLlmJudge(client);
  const v = await judge("cond", [{ role: "assistant", content: "0 failed" }]);
  assert.equal(v.status, "met");
  assert.ok(!("tools" in client.calls[0])); // 评审不给工具
  assert.equal(client.calls[0].output_config?.format?.type, "json_schema");
});
