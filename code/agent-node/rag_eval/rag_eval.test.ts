import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { FakeAnthropic, text, type Step } from "../fake_llm/index.ts";
import { DOCS } from "../rag/rag.ts";
import {
  JUDGE_MODEL,
  checkCitations,
  evaluateAnswer,
  faithfulness,
  keyFactRecall,
  reviewSample,
  summarize,
  type CaseResult,
  type Verdict,
} from "./generation.ts";
import { ndcgAtK, precisionAtK, recallAtK, reciprocalRank } from "./metrics.ts";
import { buildConfigs, evaluate, loadDataset, pairedDiff, summarize as summarizeRetrieval } from "./retrieval.ts";

const close = (a: number | null, b: number, eps = 1e-9) => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// 正文里手算的例子：标注了 a、b、c 三条证据，检索前 5 名只有第 2、4 名相关
const HAND = [new Set<string>(), new Set(["a"]), new Set<string>(), new Set(["b"]), new Set<string>()];
const GOLD = new Set(["a", "b", "c"]);

test("检索指标：手算例子", () => {
  assert.equal(recallAtK(HAND, GOLD, 1), 0);
  close(recallAtK(HAND, GOLD, 3), 1 / 3);
  close(recallAtK(HAND, GOLD, 5), 2 / 3);
  close(precisionAtK(HAND, 5), 2 / 5);
  assert.equal(reciprocalRank(HAND), 0.5);
  const dcg = 1 / Math.log2(3) + 1 / Math.log2(5);
  const idcg = 1 + 1 / Math.log2(3) + 1 / Math.log2(4);
  close(ndcgAtK(HAND, 3, 5), dcg / idcg);
  close(ndcgAtK(HAND, 3, 5), 0.498, 1e-3);
});

test("检索指标：边界情况", () => {
  assert.equal(reciprocalRank([new Set(), new Set()]), 0);
  assert.equal(ndcgAtK([new Set(["a"])], 1, 5), 1); // 唯一相关的排第一就是满分
  // 一块覆盖两条证据（大块）也只算一块相关
  assert.equal(precisionAtK([new Set(["a", "b"]), new Set()], 2), 0.5);
  assert.equal(recallAtK([new Set(["a", "b"]), new Set()], new Set(["a", "b"]), 1), 1);
  assert.throws(() => recallAtK(HAND, new Set(), 3));
});

test("评测集：证据片段逐字出自目标文档，且不跨句", () => {
  const corpus = Object.fromEntries(
    readdirSync(DOCS).filter((f) => f.endsWith(".md")).map((f) => [f, readFileSync(join(DOCS, f), "utf8")]),
  );
  const data = loadDataset();
  assert.equal(data.length, 21);
  assert.equal(new Set(data.map((c) => c.id)).size, 21);
  for (const c of data) {
    for (const e of c.evidence) {
      assert.ok(c.gold_docs.some((d) => corpus[d].split("。").some((s) => s.includes(e))), `${c.id} ${e}`);
    }
  }
});

test("检索评测：基线数字和逐题配对比较", () => {
  const configs = buildConfigs();
  const data = loadDataset();
  const base = evaluate(configs["A 基线：200 字块 + 标题"], data);
  const noTitle = evaluate(configs["B 去掉块标题"], data);
  assert.equal(base.length, 20); // 无答案题不参与
  const s = summarizeRetrieval(base);
  assert.equal(s.r3, 1);
  close(s.r1, 0.75);
  assert.deepEqual(pairedDiff(base, noTitle), [["q01", "q11"], []]);
});

test("引用检查：抓错引的数字、缺引用、不存在的编号", () => {
  const ctx = ["学生认证后年付可享五折。", "Pro 会员月付 39 元，年付 299 元。"];
  let segs = checkCitations("Pro 会员月付 39 元、年付 299 元 [1]；学生认证后年付可享五折 [2]。", ctx);
  assert.deepEqual(segs[0].problems, ["数字 39、299 不在引用的块里"]);
  assert.deepEqual(segs[1].problems, []); // 没有数字的错引，代码查不出来，要靠评审
  segs = checkCitations("能识别日语。月付 39 元 [5]。资料中没有相关说明。", ctx);
  assert.deepEqual(segs[0].problems, ["没有标引用"]);
  assert.deepEqual(segs[1].problems, ["引用 [5] 不存在"]);
  assert.deepEqual(segs[2].problems, []);
  // 数字边界：3 不能匹配到 39 里
  assert.deepEqual(checkCitations("最多 3 台 [2]", ctx)[0].problems, ["数字 3 不在引用的块里"]);
});

test("关键事实命中", () => {
  assert.equal(keyFactRecall("免费版 15 GB，Pro 2 TB", ["15 GB", "2 TB"]), 1);
  assert.equal(keyFactRecall("免费版 15 GB", ["15 GB", "2 TB"]), 0.5);
});

const j = (obj: unknown): Step => text(JSON.stringify(obj));

test("LLM 评审：两步调用，请求带评审模型和结构化输出", async () => {
  const judge = new FakeAnthropic([
    j({ claims: ["退款 3 到 5 个工作日到账", "退款后云空间清空"] }),
    j({
      verdicts: [
        { claim: "退款 3 到 5 个工作日到账", supported: true, reason: "doc 1" },
        { claim: "退款后云空间清空", supported: false, reason: "资料未提及" },
      ],
    }),
  ]);
  const c = { id: "q15", question: "退款多久到账？", key_facts: ["3 到 5 个工作日"] };
  const r = await evaluateAnswer(judge, c, "3 到 5 个工作日到账 [1]，之后云空间清空 [1]。", ["款项会在 3 到 5 个工作日内原路退回。"]);
  assert.equal(faithfulness(r), 0.5);
  assert.equal(judge.calls.length, 2);
  const call = judge.calls[1];
  assert.equal(call.model, JUDGE_MODEL);
  assert.equal(call.output_config?.format?.type, "json_schema");
  const content = call.messages[0].content as string;
  assert.ok(content.includes("<context>") && content.includes("2. 退款后云空间清空"));
});

test("拒答没有论断，不再调第二步", async () => {
  const judge = new FakeAnthropic([j({ claims: [] })]);
  const r = await evaluateAnswer(judge, { id: "q21", question: "CEO 是谁", key_facts: ["资料中没有相关说明"] }, "资料中没有相关说明。", ["无关"]);
  assert.equal(faithfulness(r), null);
  assert.equal(judge.calls.length, 1);
  assert.deepEqual(r.segments[0].problems, []);
});

test("评审条数对不上算出错，不能当通过", async () => {
  const judge = new FakeAnthropic([j({ claims: ["a", "b"] }), j({ verdicts: [{ claim: "a", supported: true, reason: "" }] })]);
  await assert.rejects(evaluateAnswer(judge, { id: "x", question: "q", key_facts: [] }, "a [1]。b [1]。", ["a b"]));
});

test("汇总与人工复核抽样", () => {
  const v = (claim: string, supported: boolean): Verdict => ({ claim, supported, reason: "" });
  const row = (id: string, problems: string[], kfr: number, verdicts: Verdict[] | null): CaseResult => ({
    id,
    question: "",
    answer: "",
    segments: [{ text: "x", cites: [1], problems }],
    keyFactRecall: kfr,
    verdicts,
  });
  const results = [
    row("q1", [], 1, [v("a", true), v("b", true)]),
    row("q2", ["没有标引用"], 0.5, [v("c", true), v("d", false)]),
    row("q3", [], 1, null),
  ];
  const s = summarize(results);
  assert.equal(s.judged, 2);
  close(s.faithfulness, 0.75); // (1.0 + 0.5) / 2，拒答不进分母
  assert.equal(s.answersWithUnsupported, 1);
  close(s.citationOk, 2 / 3);
  close(s.keyFactRecall, 2.5 / 3);
  const sample = reviewSample(results, 2);
  assert.deepEqual(sample[0], ["q2", v("d", false)]); // 判不支持的排最前、全拿
  assert.equal(sample.length, 3);
  assert.ok(sample.slice(1).every(([, x]) => x.supported));
});
