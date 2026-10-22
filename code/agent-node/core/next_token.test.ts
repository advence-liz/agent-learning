import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CORPUS, TinyAttention, bigramCounts, buildVocab, generate, kvMacs, logitsFromCounts, nextTokenProbs,
} from "./next_token.ts";

function model() {
  const [itos, stoi] = buildVocab(CORPUS);
  return { itos, stoi, logits: logitsFromCounts(bigramCounts(CORPUS, stoi)) };
}

const sum = (p: number[]) => p.reduce((a, b) => a + b, 0);
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("概率和为 1，temperature 越小越尖", () => {
  const { stoi, logits } = model();
  const row = logits[stoi["录"]];
  const [pCold, pHot] = [nextTokenProbs(row, 0.5), nextTokenProbs(row, 1.5)];
  assert.ok(close(sum(pCold), 1) && close(sum(pHot), 1));
  assert.ok(Math.max(...pCold) > Math.max(...pHot)); // T 越小越尖
  assert.equal(nextTokenProbs(row, 0)[stoi["音"]], 1.0); // T=0 = 贪心
});

test("top-k 恰好留下 k 个", () => {
  const { itos, stoi, logits } = model();
  const p = nextTokenProbs(logits[stoi["录"]], 1.0, 2);
  const kept = p.flatMap((v, i) => (v > 0 ? [itos[i]] : []));
  assert.equal(kept.length, 2);
  assert.deepEqual(new Set(kept), new Set(["音", "页"]));
});

test("贪心生成是确定的", () => {
  const { itos, stoi, logits } = model();
  const a = generate("fix(webapp): ", logits, itos, stoi, 20, { temperature: 0, seed: 1 });
  const b = generate("fix(webapp): ", logits, itos, stoi, 20, { temperature: 0, seed: 2 });
  assert.equal(a, b);
  assert.equal(a, "fix(webapp): 修复录音列表滚动卡顿\n");
});

test("KV cache：输出相同，计算更少", () => {
  const { itos, stoi } = model();
  const m = new TinyAttention(itos.length, 16);
  const ids = [...CORPUS].slice(0, 30).map((c) => stoi[c]);
  m.kvMacs = 0;
  const a = m.generate(ids, 10, false);
  const nc = m.kvMacs;
  m.kvMacs = 0;
  const b = m.generate(ids, 10, true);
  assert.deepEqual(a, b);
  assert.equal(nc, kvMacs(30, 10, 16, false));
  assert.equal(m.kvMacs, kvMacs(30, 10, 16, true));
  assert.ok(m.kvMacs < nc);
});
