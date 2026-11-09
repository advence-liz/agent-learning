import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { FakeAnthropic } from "../fake_llm/index.ts";
import { dumps, estimateTokens, measureTools, truncateResult } from "./budget.ts";
import { TASK, badScript, goodScript, runAgent } from "./compare.ts";
import {
  BAD_HANDLERS,
  BAD_TOOLS,
  GOOD_HANDLERS,
  GOOD_TOOLS,
  ORDERS,
  REFUND_SCHEMA,
  ToolError,
  findOrders,
  formatToolError,
  resetBackend,
  validate,
} from "./toolsets.ts";

const quiet = { log: () => {} };
const order1042 = () => ORDERS.find((o) => o.number === "ORD-1042")!;

beforeEach(resetBackend);
afterEach(resetBackend);

// ---------- budget ----------

test("estimateTokens：ASCII 4 字符 1 token，中文 1 字 1 token", () => {
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens("退款"), 2);
  assert.equal(estimateTokens("ab退款"), 3); // 2/4 向上取整 + 2
});

test("measureTools 把名字、描述、schema 都算进去", () => {
  const m = measureTools(GOOD_TOOLS);
  assert.ok(m.chars > GOOD_TOOLS.reduce((n, t) => n + t.description!.length, 0));
  assert.equal(m.tokens, estimateTokens(dumps(GOOD_TOOLS)));
});

test("短结果不截断", () => {
  assert.equal(truncateResult("abc", 10, "翻页"), "abc");
});

test("按整行截断，并告诉模型还剩多少、怎么继续", () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${String(i).padStart(2, "0")}`).join("\n"); // 79 字符
  const out = truncateResult(text, 20, "传 offset=2 继续。");
  const [head, notice] = out.split("\n…");
  assert.equal(head, "line 00\nline 01"); // 第三行放不下就整行不要
  assert.match(notice, /只显示了前 15 \/ 79 字符/);
  assert.match(notice, /还剩 64 字符/);
  assert.ok(notice.endsWith("传 offset=2 继续。]"));
});

test("单行超长时硬切", () => {
  const out = truncateResult("x".repeat(50), 10, "缩小范围。");
  assert.ok(out.startsWith("x".repeat(10) + "\n…"));
  assert.match(out, /前 10 \/ 50 字符/);
});

// ---------- 错误信息 ----------

test("formatToolError 的格式：哪里错 + 逐条问题 + 下一步", () => {
  assert.equal(formatToolError("参数有误", ["a 不对", "b 缺了"], "改好再调。"), "参数有误：\n- a 不对\n- b 缺了\n改好再调。");
});

test("validate 拒绝非法参数，每条都说清怎么改", () => {
  assert.deepEqual(validate(REFUND_SCHEMA, { order_number: "1042", reason: "耳机有问题", amount: 899 }), [
    "不认识的参数 amount（只接受：order_number、reason、amount_yuan）",
    'order_number="1042" 格式不对。订单号，形如 ORD-1042，从 webapp_find_orders 的结果里原样复制，不要自己编',
    'reason="耳机有问题" 不在可选值里，可选：damaged / not_as_described / no_longer_needed / other',
  ]);
  assert.deepEqual(validate(REFUND_SCHEMA, { reason: "damaged" }), [
    "缺少必填参数 order_number：订单号，形如 ORD-1042，从 webapp_find_orders 的结果里原样复制，不要自己编",
  ]);
  assert.deepEqual(validate(REFUND_SCHEMA, { order_number: "ORD-1042", reason: "damaged", amount_yuan: "99" }), [
    'amount_yuan 应为 number，收到 "99"',
  ]);
  assert.deepEqual(validate(REFUND_SCHEMA, { order_number: "ORD-1042", reason: "damaged", amount_yuan: 0 }), [
    "amount_yuan=0 超出范围 [0.01, 100000]",
  ]);
  assert.deepEqual(validate(REFUND_SCHEMA, { order_number: "ORD-1042", reason: "damaged" }), []);
});

test("好工具：参数不合法就不执行，也不碰后端", () => {
  assert.throws(
    () => GOOD_HANDLERS.webapp_refund_order({ order_number: "1042", reason: "damaged" }),
    (e: Error) => {
      assert.ok(e instanceof ToolError);
      assert.ok(e.message.startsWith("参数有误，这次没有执行："));
      assert.ok(e.message.includes("ORD-1042") && e.message.includes("webapp_find_orders"));
      return true;
    },
  );
  assert.ok(ORDERS.every((o) => o.refunds.length === 0));
});

test("好工具：把后端错误码翻译成下一步", () => {
  assert.throws(
    () => GOOD_HANDLERS.webapp_refund_order({ order_number: "ORD-0987", reason: "damaged" }),
    (e: Error) => {
      assert.match(e.message, /已过退款期（截至 2026-08-26）/);
      assert.match(e.message, /不要换参数重试/);
      assert.ok(!e.message.includes("trace") && !e.message.includes("/srv/")); // 堆栈留给日志，不给模型
      return true;
    },
  );
});

test("坏工具：后端堆栈原样漏给模型", () => {
  assert.throws(
    () => BAD_HANDLERS.api_post_refunds({ order_id: ORDERS[0].id, amount: 899, reason: "耳机有问题" }),
    /E_REFUND_4003[\s\S]*\/srv\/payments\/refund\.js/,
  );
});

test("findOrders：concise / detailed / 翻页提示", () => {
  const concise = findOrders({ customer: "张伟", query: "耳机" });
  assert.equal(concise.split("\n")[1], "ORD-1042 · 2026-10-30 · 降噪耳机 Pro ×1 · ¥899.00 · 可退款");
  assert.ok(!concise.includes("ord_")); // 默认不给不透明 ID
  const detailed = findOrders({ customer: "张伟", query: "耳机", response_format: "detailed" });
  assert.ok(detailed.includes("内部 ID ord_") && detailed.length > concise.length);
  const page = findOrders({ customer: "张伟", limit: 2 });
  assert.ok(page.endsWith("还有 4 笔没列出：传 offset=2 看下一页，或加 query 缩小范围。"));
});

// ---------- 两条轨迹 ----------

test("坏工具集的轨迹：两次报错，还悄悄退错了金额", async () => {
  const st = await runAgent(new FakeAnthropic(badScript()), TASK, BAD_TOOLS, BAD_HANDLERS, quiet);
  assert.deepEqual([st.modelCalls, st.toolCalls, st.toolErrors], [6, 5, 2]);
  assert.equal(order1042().refunds[0].amount_cents, 899); // 想退 ¥899，实际退了 ¥8.99，没有任何报错
});

test("好工具集：定义更长，但上下文总开销小得多", async () => {
  const bad = await runAgent(new FakeAnthropic(badScript()), TASK, BAD_TOOLS, BAD_HANDLERS, quiet);
  resetBackend();
  const good = await runAgent(new FakeAnthropic(goodScript()), TASK, GOOD_TOOLS, GOOD_HANDLERS, quiet);
  assert.deepEqual([good.modelCalls, good.toolCalls, good.toolErrors], [4, 3, 1]);
  assert.ok(good.defsChars > bad.defsChars); // 描述写得细，定义更长……
  assert.ok(good.resultChars * 10 < bad.resultChars); // ……但结果省下的远多于此
  assert.ok(good.contextChars < bad.contextChars);
  assert.equal(good.results[1].is_error, true);
  assert.equal(order1042().refunds[0].amount_cents, 89900);
});
