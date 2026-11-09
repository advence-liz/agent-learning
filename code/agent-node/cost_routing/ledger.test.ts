import assert from "node:assert/strict";
import { test } from "node:test";

import { SCENARIOS, prompts, run, usages } from "./ledger.ts";
import { promptOf } from "./meter.ts";

const total = (name: string) => run(SCENARIOS.find((s) => s.name === name)!).spent();

test("每圈输入线性增长，累计按平方增长", () => {
  const ps = prompts(false);
  const steps = new Set(ps.slice(1).map((b, i) => b - ps[i]));
  assert.equal(steps.size, 1); // 每圈多出来的量相同：线性
  assert.ok(ps.reduce((s, x) => s + x, 0) > 4 * ps[0] * ps.length); // 累计远超「每圈都和第一圈一样长」
});

test("缓存场景的 usage 形状", () => {
  const s = SCENARIOS.find((s) => s.cache && !s.truncate && !s.prefixBreaks)!;
  const us = usages(s), ps = prompts(false);
  assert.equal(us[0].write5m, ps[0]);
  assert.equal(us[0].cacheRead, 0);
  for (let i = 1; i < us.length; i++) {
    assert.equal(us[i].cacheRead, ps[i - 1]); // 读到上一圈的全部
    assert.equal(promptOf(us[i]), ps[i]); // 三项之和 = 本圈输入总量
  }
});

test("几种做法的成本排序", () => {
  const base = total("不缓存 · 不截断");
  assert.ok(total("缓存 · 截断工具结果") < total("缓存 · 不截断"));
  assert.ok(total("缓存 · 不截断") < total("不缓存 · 截断工具结果"));
  assert.ok(total("不缓存 · 截断工具结果") < base);
  // 前缀每圈都变：每圈全量写缓存，比不开缓存还贵 25%
  assert.ok(Math.abs(total("缓存，但前缀每圈都变") / base - 1.25) < 0.05);
});
