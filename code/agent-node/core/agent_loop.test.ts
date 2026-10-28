import assert from "node:assert/strict";
import { test } from "node:test";

import { TOOLS, readFile, runAgent } from "./agent_loop.ts";
import { FakeAnthropic, text, toolUse } from "../fake_llm/index.ts";

const quiet = { log: () => {} };

test("工具结果被喂回模型", async () => {
  const client = new FakeAnthropic([toolUse("read_file", { path: "apps/web/vitest.config.ts" }), text("15 秒")]);
  const answer = await runAgent(client, "超时多少？", TOOLS, { read_file: readFile }, quiet);
  assert.equal(answer, "15 秒");
  const second = client.calls[1].messages;
  assert.deepEqual(second.map((m) => m.role), ["user", "assistant", "user"]);
  const result = (second[2].content as any[])[0];
  assert.equal(result.type, "tool_result");
  assert.match(result.content, /testTimeout: 15000/);
  assert.equal(result.tool_use_id, (second[1].content as any[])[0].id);
});

test("工具出错时回给模型，而不是让循环崩掉", async () => {
  const client = new FakeAnthropic([toolUse("read_file", { path: "nope.ts" }), text("文件不存在")]);
  await runAgent(client, "读 nope.ts", TOOLS, { read_file: readFile }, quiet);
  const result = (client.calls[1].messages[2].content as any[])[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /FileNotFoundError/);
});

test("超过 maxTurns 抛错", async () => {
  const step = toolUse("read_file", { path: "apps/web/vitest.config.ts" });
  const client = new FakeAnthropic([step, step, step]);
  await assert.rejects(runAgent(client, "x", TOOLS, { read_file: readFile }, { ...quiet, maxTurns: 3 }), /3/);
});
