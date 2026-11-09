import assert from "node:assert/strict";
import { test } from "node:test";

import { CostMeter } from "./meter.ts";
import {
  HAIKU, OPUS, SONNET, TASKS, checkLabel, checkLocation, checkPlan, compare, routeRule, runCascade, runFixed, scriptedClient,
} from "./router.ts";

const byId = Object.fromEntries(TASKS.map((t) => [t.id, t]));

test("规则路由表", () => {
  assert.equal(routeRule(byId.t1), HAIKU); // 分类
  assert.equal(routeRule(byId.t4), HAIKU); // 检索词改写
  assert.equal(routeRule(byId.t6), SONNET); // 编码
  assert.equal(routeRule(byId.t7), OPUS); // 规划
});

test("校验器只是普通代码", () => {
  assert.ok(checkLabel("bug") && !checkLabel("这看起来像是一个 bug"));
  assert.ok(checkLocation('{"file": "a.ts", "line": 3}') && !checkLocation('{"file": "a.ts", "line": "3"}'));
  assert.ok(!checkPlan('[{"step": "x"}]'));
});

test("级联：第一档通过就停", async () => {
  const client = scriptedClient();
  const [o] = await runCascade(client, [byId.t1], new CostMeter());
  assert.deepEqual(o.attempts, [HAIKU]);
  assert.ok(o.passed);
  assert.deepEqual(client.calls.map((c) => c.model), [HAIKU]);
});

test("级联：校验不过就升级，失败的尝试也计费", async () => {
  const client = scriptedClient();
  const meter = new CostMeter();
  const [o] = await runCascade(client, [byId.t8], meter);
  assert.deepEqual(o.attempts, [HAIKU, SONNET, OPUS]);
  assert.ok(o.passed);
  assert.deepEqual(client.calls.map((c) => c.model), [HAIKU, SONNET, OPUS]);
  // 失败的两次也计费：总价 = 三次之和
  assert.equal(meter.records.length, 3);
  assert.equal(o.usd, meter.records.reduce((s, r) => s + r.usd, 0));
});

test("级联可以从规则选的那档起步", async () => {
  const [o] = await runCascade(scriptedClient(), [byId.t7], new CostMeter(), { start: routeRule });
  assert.deepEqual(o.attempts, [OPUS]);
});

test("梯子用完仍不过就放弃", async () => {
  const [o] = await runCascade(scriptedClient(), [byId.t8], new CostMeter(), { ladder: [HAIKU, SONNET] });
  assert.deepEqual(o.attempts, [HAIKU, SONNET]);
  assert.ok(!o.passed);
});

test("规则路由把同类型里难的那条判轻了", async () => {
  const [o] = await runFixed(scriptedClient(), [byId.t8], new CostMeter(), routeRule);
  assert.deepEqual(o.attempts, [SONNET]);
  assert.ok(!o.passed);
});

test("汇总对比", async () => {
  const r = await compare();
  const [opus, haiku, rule, cascade] = ["全用 Opus", "全用 Haiku", "规则路由", "级联路由"].map((k) => r.get(k)![0]);
  assert.equal(opus.passed, 8);
  assert.equal(cascade.passed, 8);
  assert.equal(rule.passed, 6);
  assert.equal(haiku.passed, 4);
  assert.ok(cascade.dailyUsd < 0.2 * opus.dailyUsd);
  // 按调用量算的通过率会掩盖难任务全军覆没：全 Haiku 也有 90% 以上
  assert.ok(haiku.passRate > 0.9);
  assert.ok(cascade.escalationRate > 0 && cascade.escalationRate < 0.1);
});
