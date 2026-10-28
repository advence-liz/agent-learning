import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import * as demo from "./demo.ts";
import { makeTools, runAgent } from "./agent.ts";
import { FakeAnthropic, text, toolUse } from "../fake_llm/index.ts";

const quiet = { log: () => {} };
let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "coding-agent-test-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("agent 按脚本修好 bug", async () => {
  demo.setup(dir);
  const client = new FakeAnthropic(demo.script());
  const final = await runAgent(client, "修好测试", dir, quiet);

  assert.equal(readFileSync(join(dir, "calc.mjs"), "utf8"), demo.FIXED);
  assert.match(final, /通过/);
  assert.equal(client.calls.length, 5); // 4 次工具轮 + 1 次总结

  // 第一次工具结果是失败的测试输出，它被真实地喂回了模型
  const first = (client.calls[1].messages[2].content as any[])[0];
  assert.equal(first.type, "tool_result");
  assert.match(first.content, /AssertionError/);
  // 最后一次工具结果是测试通过
  const last = (client.calls[4].messages.at(-1)!.content as any[])[0];
  assert.match(last.content, /exit=0/);
  assert.match(last.content, /ok/);
});

test("工具出错被回报而不是抛出", async () => {
  const client = new FakeAnthropic([toolUse("read_file", { path: "nope.txt" }), text("文件不存在")]);
  await runAgent(client, "读 nope.txt", dir, quiet);
  const result = (client.calls[1].messages.at(-1)!.content as any[])[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /ENOENT/);
});

test("路径越界被拦下", () => {
  const tools = makeTools(dir);
  assert.throws(() => tools.read_file({ path: "../../etc/passwd" }), RangeError);
});

test("maxTurns 拦住失控循环", async () => {
  const client = new FakeAnthropic([1, 2, 3].map(() => toolUse("run_command", { command: "true" })));
  const out = await runAgent(client, "x", dir, { ...quiet, maxTurns: 3 });
  assert.match(out, /maxTurns/);
});
