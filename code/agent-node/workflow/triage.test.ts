import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeAnthropic, text, toolUse } from "../fake_llm/index.ts";
import { Index } from "../rag/rag.ts";
import { FEEDBACK, agent, workflow } from "./triage.ts";

test("workflow 的 gate 不合格时重试一次", async () => {
  const c = new FakeAnthropic([text('{"label": "bug"}'), text("缺格式"), text("复现步骤 期望 实际")]);
  const trace: string[] = [];
  const out = await workflow(c, Index.fromDir(), FEEDBACK, trace);
  assert.deepEqual(trace, ["classify → bug", "gate ✗ → retry", "gate ✓"]);
  assert.ok(c.calls.length === 3 && out.includes("复现步骤"));
});

test("workflow 的咨询路径是写死的", async () => {
  const c = new FakeAnthropic([text('{"label": "question"}'), text("不限次数")]);
  const trace: string[] = [];
  await workflow(c, Index.fromDir(), "Pro 能导出几次", trace);
  assert.ok(trace[0] === "classify → question" && trace[1].startsWith("retrieve"));
  assert.ok(!("tools" in c.calls[1])); // workflow 的每一步都不给模型工具
});

test("agent 自己决定走哪条路", async () => {
  const c = new FakeAnthropic([
    toolUse("search_docs", { query: "导出" }),
    toolUse("create_ticket", { title: "t", body: "b" }),
    text("done"),
  ]);
  const trace: string[] = [];
  assert.equal(await agent(c, Index.fromDir(), FEEDBACK, trace), "done");
  assert.deepEqual(trace.filter((t) => t.startsWith("⏺")).map((t) => t.split("(")[0]), ["⏺ search_docs", "⏺ create_ticket"]);
  assert.equal((c.calls[0].tools![0] as { name: string }).name, "search_docs");
});
