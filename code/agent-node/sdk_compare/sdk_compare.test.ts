import assert from "node:assert/strict";
import { test } from "node:test";

test("Vercel AI SDK 离线跑通（对应 Python 版的 Pydantic AI）", async () => {
  const m = await import("./ai_sdk_agent.ts");
  const r = await m.agent.generate({ prompt: "修好 calc.py" });
  assert.ok(r.output.fixed && m.FILES["calc.py"].includes("a + b"));
  assert.equal(r.steps.flatMap((s) => s.toolCalls).length, 2);
  assert.equal(m.model.doGenerateCalls.length, 3);
});

test("LangGraph 离线跑通", async () => {
  const m = await import("./langgraph_agent.ts");
  const final = await m.app.invoke({ messages: [{ role: "user", content: "x" }], step: 0 });
  assert.deepEqual(final.messages.map((x) => x.role), ["user", "assistant", "tool", "assistant", "tool", "assistant"]);
  assert.ok(m.FILES["calc.py"].includes("a + b"));
});
