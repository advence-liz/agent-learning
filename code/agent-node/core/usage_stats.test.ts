import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PRICES, defaultSession, render, scan } from "./usage_stats.ts";

function line(mid: string, { model = "claude-opus-5-5", ...u }: Record<string, any> = {}): string {
  const usage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, ...u };
  return JSON.stringify({
    type: "assistant",
    message: { id: mid, model, usage, content: [{ type: "text", text: "SECRET-BODY" }] },
  });
}

/** 对应 pytest 的 tmp_path：每个用例一个临时目录，用完删掉。 */
function tmpPath(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-stats-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("拆分行去重，费用按缓存分档计算", (t) => {
  const f = join(tmpPath(t), "s.jsonl");
  const split1h = { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 };
  const rows = [
    JSON.stringify({ type: "user", message: { role: "user", content: "SECRET-BODY" } }),
    line("m1", { input_tokens: 10, cache_creation_input_tokens: 1_000_000, output_tokens: 100, cache_creation: split1h }),
    line("m1", { input_tokens: 10, cache_creation_input_tokens: 1_000_000, output_tokens: 100, cache_creation: split1h }),
    line("m2", { input_tokens: 10, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, output_tokens: 100 }), // 没有拆分字段 → 按 5 分钟写入算
    line("m3", { model: "<synthetic>", input_tokens: 999 }),
    "not json",
  ];
  writeFileSync(f, rows.join("\n"));
  const rep = scan([f]);
  const tot = rep.byModel.get("claude-opus-5-5")!;
  assert.equal(rep.duplicateLines, 1);
  assert.equal(rep.skippedLines, 1);
  assert.ok(!rep.byModel.has("<synthetic>"));
  assert.deepEqual(
    [tot.requests, tot.input, tot.cacheRead, tot.write1h, tot.write5m, tot.output],
    [2, 20, 1_000_000, 1_000_000, 1_000_000, 200],
  );
  assert.ok(Math.abs(tot.hitRate - 1_000_000 / 3_000_020) < 1e-12);
  const p = PRICES["claude-opus-5-5"];
  const expected = (20 * 4 + 1_000_000 * 0.2 + 1_000_000 * 4 * 2 + 1_000_000 * 4 * 1.25 + 200 * 20) / 1e6;
  assert.ok(Math.abs(tot.cost(p) - expected) < 1e-9);
  assert.ok(Math.abs(tot.costWithoutCache(p) - (3_000_020 * 4 + 200 * 20) / 1e6) < 1e-9);
  assert.ok(!render(rep).includes("SECRET-BODY")); // 输出里绝不出现正文
});

test("默认会话：取 projects 下最大的那个 jsonl", (t) => {
  const proj = tmpPath(t);
  mkdirSync(join(proj, "-a"));
  mkdirSync(join(proj, "-b"));
  writeFileSync(join(proj, "-a", "small.jsonl"), line("x"));
  writeFileSync(join(proj, "-b", "big.jsonl"), [line("y"), line("z")].join("\n"));
  writeFileSync(join(proj, "-b", "notes.txt"), "x".repeat(10_000)); // 不是 jsonl，不算
  assert.equal(defaultSession(proj), join(proj, "-b", "big.jsonl"));
  assert.throws(() => defaultSession(join(proj, "nope")), /没找到会话 jsonl/);
});
