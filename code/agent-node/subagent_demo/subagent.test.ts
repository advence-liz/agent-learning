import assert from "node:assert/strict";
import { test } from "node:test";

import * as subagent from "./subagent.ts";
import type { CreateParams } from "../fake_llm/index.ts";

test("父上下文远小于 inline", async () => {
  const [inline] = await subagent.scenarioInline();
  const [parent, child, ps, cs] = await subagent.scenarioSubagent();
  assert.ok(parent < inline / 5);
  assert.ok(child > parent); // 探索的体积留在了子数组里
  assert.ok(ps.toolCalls === 1 && cs.toolCalls === 4);
});

test("子 agent 从全新的 messages 开始", async () => {
  const seen: unknown[][] = [];
  const proto = subagent.ScriptedClient.prototype;
  const orig = proto.create;
  proto.create = function (params: CreateParams) {
    if (String(params.system).includes("子 agent")) seen.push(params.messages.map((m) => m.content).slice(0, 1));
    return orig.call(this, params);
  };
  try {
    await subagent.scenarioSubagent();
  } finally {
    proto.create = orig;
  }
  // 子 agent 第一次请求只有一条消息：任务描述；看不到父亲的原始提问
  assert.deepEqual(seen[0], ["在 *_demo 里找 hook exit 2 的处理位置，给文件:行号"]);
});
