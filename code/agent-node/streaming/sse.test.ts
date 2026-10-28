import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Accumulator, FIXTURE, dropNulls, fileLines, linesFromChunks, parseSse, viaSdk } from "./sse.ts";

function assemble(lines: Iterable<string>) {
  const acc = new Accumulator();
  for (const [, ev] of parseSse(lines)) acc.feed(ev);
  return acc.message;
}

test("tool 参数只在 content_block_stop 时拼成", () => {
  const msg = assemble(fileLines(FIXTURE));
  assert.equal(msg.stop_reason, "tool_use");
  assert.deepEqual(msg.content[1].input, { path: "calc.py", content: "def add(a, b):\n    return a + b\n" });
  assert.deepEqual(msg.usage, { input_tokens: 412, output_tokens: 58 });
});

test("任意切分网络 chunk 结果都一样", () => {
  const data = readFileSync(FIXTURE);
  for (const size of [1, 3, 7, 64]) {
    // 1 字节一块：汉字的 UTF-8 也会被切开
    const chunks = [];
    for (let i = 0; i < data.length; i += size) chunks.push(data.subarray(i, i + size));
    assert.deepEqual(assemble(linesFromChunks(chunks)), assemble(fileLines(FIXTURE)));
  }
});

test("SSE 多行 data 和注释行", () => {
  const raw = [": keep-alive\n", "event: x\n", 'data: {"a":\n', "data: 1}\n", "\n"];
  assert.deepEqual([...parseSse(raw)], [["x", { a: 1 }]]);
});

test("和真实 SDK 的拼装结果一致", async () => {
  const [kinds, final] = await viaSdk();
  assert.ok(!kinds.includes("ping")); // SDK 把心跳吞掉了
  const ours = assemble(fileLines(FIXTURE));
  assert.deepEqual(dropNulls(final.content), ours.content);
});
