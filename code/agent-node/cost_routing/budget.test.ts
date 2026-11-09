import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeAnthropic } from "../fake_llm/index.ts";
import { SUMMARY, demoScript, runBudgeted } from "./budget.ts";
import { Budget, CostMeter } from "./meter.ts";

const quiet = { log: () => {} };
const tool = () => "hit";

test("预算内正常结束", async () => {
  const r = await runBudgeted(new FakeAnthropic(demoScript(1)), "x", tool, {
    meter: new CostMeter(), budget: new Budget(10, 20), tenant: "a", ...quiet,
  });
  assert.deepEqual([r.stop, r.turns, r.answer], ["end_turn", 2, SUMMARY]);
});

test("到软上限 → 禁用工具收口", async () => {
  const client = new FakeAnthropic(demoScript(20));
  const r = await runBudgeted(client, "x", tool, { meter: new CostMeter(), budget: new Budget(0.3, 0.8), tenant: "a", ...quiet });
  assert.equal(r.stop, "budget_soft");
  assert.equal(r.answer, SUMMARY);
  const last = client.calls.at(-1)!;
  assert.deepEqual(last.tool_choice, { type: "none" });
  const tail = last.messages.at(-1)!.content as any[];
  assert.deepEqual(tail.map((b) => b.type), ["tool_result", "text"]); // 收口提示并进最后一组 tool_result
  // 软上限只拦「再开一圈」：最终花费会超过软上限，但不超过硬上限
  assert.ok(r.usd > 0.3 && r.usd <= 0.8);
});

test("最坏情况会超硬上限 → 不再调用", async () => {
  const client = new FakeAnthropic(demoScript(20));
  const r = await runBudgeted(client, "x", tool, { meter: new CostMeter(), budget: new Budget(0.3, 0.5), tenant: "a", ...quiet });
  assert.equal(r.stop, "budget_hard");
  assert.ok(client.calls.every((c) => c.tool_choice === undefined)); // 连收口都没调
  assert.ok(r.usd <= 0.5);
});

test("预算按租户独立", async () => {
  const meter = new CostMeter();
  const budget = new Budget(0.15, 10);
  const a = await runBudgeted(new FakeAnthropic(demoScript(20)), "x", tool, { meter, budget, tenant: "a", ...quiet });
  assert.ok(a.stop === "budget_soft" && meter.spent("a") > 0.15);
  // 同一个 meter，但 b 只看自己花了多少：a 超支不影响 b 跑完
  const b = await runBudgeted(new FakeAnthropic(demoScript(1)), "x", tool, { meter, budget, tenant: "b", ...quiet });
  assert.deepEqual([b.stop, b.turns], ["end_turn", 2]);
  assert.ok(Math.abs(meter.spent() - meter.spent("a") - meter.spent("b")) < 1e-12);
});
