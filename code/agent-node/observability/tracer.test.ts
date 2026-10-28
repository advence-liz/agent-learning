import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as demo from "../coding_agent/demo.ts";
import { FakeAnthropic, text, toolUse } from "../fake_llm/index.ts";
import { Tracer, runTraced } from "./tracer.ts";

test("trace 树结构和 OTLP 导出", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "tracer-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  demo.setup(tmp);
  const script = [
    toolUse("read_file", { path: "calc.mjs" }, { inputTokens: 100, outputTokens: 10 }),
    toolUse("read_file", { path: "nope.mjs" }, { inputTokens: 150, outputTokens: 10 }),
    text("done", { inputTokens: 200, outputTokens: 5 }),
  ];
  const tr = new Tracer();
  await runTraced(new FakeAnthropic(script), "x", tmp, tr, { log: () => {} });

  const names = [...tr.spans].sort((a, b) => (a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : a.seq - b.seq)).map((s) => s.name);
  assert.deepEqual(names, ["invoke_agent coding_agent", "chat claude-opus-5-5", "execute_tool read_file",
    "chat claude-opus-5-5", "execute_tool read_file", "chat claude-opus-5-5"]);
  const root = tr.spans.find((s) => s.parentId === null)!;
  assert.ok(tr.spans.filter((s) => s !== root).every((s) => s.parentId === root.spanId));
  assert.equal(root.attrs["agent.usage.input_tokens"], 450);
  assert.equal(root.attrs["agent.turns"], 3);

  const tools = tr.spans.filter((s) => s.name.startsWith("execute_tool")).sort((a, b) => a.seq - b.seq);
  assert.equal(tools[0].error, null);
  assert.match(tools[1].error!, /ENOENT/); // Node 的「文件不存在」是 ENOENT，对应 Python 的 FileNotFoundError
  assert.match(tools[0].attrs["gen_ai.tool.call.id"] as string, /^toolu_/);

  const otlp = tr.toOtlp().resourceSpans[0];
  const spans = otlp.scopeSpans[0].spans;
  assert.deepEqual(otlp.resource.attributes[0], { key: "service.name", value: { stringValue: "mini-coding-agent" } });
  assert.deepEqual(new Set(spans.map((s: any) => s.status.code)), new Set([1, 2]));
  assert.ok(spans.every((s: any) => s.traceId.length === 32 && s.spanId.length === 16));
  // 导出按开始时间排序，和上面的创建顺序一致
  assert.deepEqual(spans.map((s: any) => s.name), names);
});
