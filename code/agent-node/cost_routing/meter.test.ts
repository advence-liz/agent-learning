import assert from "node:assert/strict";
import { test } from "node:test";

import { Budget, CostMeter, costUsd, normalizeUsage, tokens, worstCaseNextUsd } from "./meter.ts";

const approx = (a: number, b: number) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);

test("纯输入 / 输出按标价算", () => {
  // Opus 5.5：输入 $4 / 输出 $20 每百万
  approx(costUsd("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 0 }), 4.0);
  approx(costUsd("claude-opus-5-5", { input_tokens: 0, output_tokens: 1_000_000 }), 20.0);
});

test("缓存写入 1.25×、缓存读按读价", () => {
  const u = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
  // Sonnet 5.5：写入（默认按 5 分钟）2 × 1.25 = 2.5，读 0.10（0.05×）
  approx(costUsd("claude-sonnet-5-5", u), 2.5 + 0.1);
});

test("有 cache_creation 拆分时按 TTL 分别计价", () => {
  const u = {
    input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
  };
  const t = normalizeUsage(u);
  assert.deepEqual([t.write5m, t.write1h], [100, 200]);
  approx(costUsd("claude-opus-5-5", u), (100 * 4 * 1.25 + 200 * 4 * 2.0) / 1e6);
});

test("null 字段按 0 算", () => {
  // SDK 的 Usage 里没开缓存时这两个字段是 null
  const u = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: null, cache_read_input_tokens: null };
  assert.deepEqual(normalizeUsage(u), tokens({ input: 10, output: 10 }));
});

test("Batch 全部五折", () => {
  const u = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 5000 };
  approx(costUsd("claude-opus-5-5", u, { batch: true }), costUsd("claude-opus-5-5", u) / 2);
});

test("Haiku 5.5 超过 100K 提示换长上下文价", () => {
  approx(costUsd("claude-haiku-5-5", tokens({ input: 100_000, output: 1_000 })), (100_000 * 0.1 + 1_000 * 0.5) / 1e6);
  approx(costUsd("claude-haiku-5-5", tokens({ input: 100_001, output: 1_000 })), (100_001 * 0.5 + 1_000 * 2.5) / 1e6);
  // 判断依据是三种输入之和，不只是 input_tokens
  approx(costUsd("claude-haiku-5-5", tokens({ input: 1, cacheRead: 100_000 })), (1 * 0.5 + 100_000 * 0.05) / 1e6);
});

test("价格表里没有的模型直接报错", () => {
  assert.throws(() => costUsd("claude-unknown", { input_tokens: 1, output_tokens: 1 }));
});

test("按租户、按模型汇总", () => {
  const m = new CostMeter();
  m.add("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 0 }, { tenant: "a" });
  m.add("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 0 }, { tenant: "b" });
  approx(m.spent(), 4.01);
  approx(m.spent("a"), 4.0);
  const t = m.by("tenant");
  approx(t.a, 4.0);
  approx(t.b, 0.01);
  assert.deepEqual(Object.keys(m.by("model")), ["claude-opus-5-5", "claude-haiku-5-5"]);
});

test("预算判定：先看硬上限", () => {
  const b = new Budget(1.0, 2.0);
  assert.equal(b.check(0.5, 0.1), "ok");
  assert.equal(b.check(1.0, 0.1), "soft");
  assert.equal(b.check(1.5, 0.6), "hard"); // 最坏情况会超就别再调
});

test("最坏情况：全按未缓存价、输出顶满 max_tokens", () => {
  const last = tokens({ cacheRead: 9_000, write5m: 1_000, output: 500 });
  // 下一次输入 ≈ 10,000 + 500（上一圈输出）+ 200（新工具结果），全按未缓存价；输出顶满 1,000
  approx(worstCaseNextUsd("claude-opus-5-5", last, 1_000, 200), (10_700 * 4 + 1_000 * 20) / 1e6);
});
