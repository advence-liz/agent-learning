/** 第 2 章：循环变成事件流，模型输出逐步可见。 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Settings } from "../mini_cc/config.ts";
import type { Event } from "../mini_cc/events.ts";
import { AnthropicClient, FakeTurn, type ModelRequest, say, textBlock, toolBlock } from "../mini_cc/model.ts";
import { Tool, ToolResult } from "../mini_cc/tools/index.ts";
import { cleanupTmp, collect, makeApp, makeSettings } from "./conftest.ts";
import { StubSDK, textStream } from "./sdk_stub.ts";

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

class Probe extends Tool {
  override name = "Probe";
  override inputSchema = { type: "object", properties: {} };
  ran = false;

  override run(): ToolResult {
    this.ran = true;
    return new ToolResult("probed");
  }
}

test("事件顺序", async () => {
  const { app } = makeApp(settings, [
    new FakeTurn([{ type: "thinking", thinking: "先看看目录", signature: "s" },
      textBlock("我先列一下文件。"), toolBlock("Bash", { command: "echo hi" })]),
    say("完成"),
  ]);
  const kinds = (await collect(app.agent.runTurn("go"))).map((e) => e.type);
  // 思考、文本先流出来，然后才是工具，最后是下一轮文本和 TurnEnd
  assert.ok(kinds.indexOf("ThinkingDelta") < kinds.indexOf("TextDelta"));
  assert.ok(kinds.indexOf("TextDelta") < kinds.indexOf("ToolStart"));
  assert.equal(kinds.at(-1), "TurnEnd");
  assert.equal(kinds.filter((k) => k === "ToolStart").length, 1);
  assert.equal(kinds.filter((k) => k === "ToolEnd").length, 1);
});

test("增量先到，工具后跑（生成器是惰性的）", async () => {
  const { app } = makeApp(settings, [new FakeTurn([textBlock("马上调用探针"), toolBlock("Probe", {})]), say("ok")]);
  const probe = new Probe();
  app.agent.tools.register(probe);
  const gen = app.agent.runTurn("go");
  let ev: IteratorResult<Event>;
  do ev = await gen.next(); while (ev.value.type !== "TextDelta"); // 第 9 章起前面会先有 ContextInjected
  assert.equal(probe.ran, false); // 文本已经到了，工具还没执行
  const rest = await collect(gen);
  assert.equal(probe.ran, true);
  assert.ok(rest.some((e) => e.type === "ToolEnd" && e.result.content === "probed"));
});

test("调工具前那句话出现在 UI 里", async () => {
  // 第 1 章的毛病：调工具前那句话丢了。现在它应该出现在 UI 里。
  const { app, ui } = makeApp(settings, [new FakeTurn([textBlock("我先看看目录。"), toolBlock("Bash", { command: "true" })]), say("看完了")]);
  await app.handleLine("看目录");
  const text = ui.text;
  assert.ok(text.indexOf("● 我先看看目录。") < text.indexOf("⏺ Bash(true)"));
  assert.ok(text.indexOf("⏺ Bash(true)") < text.indexOf("● 看完了"));
  assert.ok(text.includes("✔ Bash -> (no output)"));
});

test("请求带 summarized thinking", async () => {
  const { app, client } = makeApp(settings, [say("ok")]);
  await collect(app.agent.runTurn("hi"));
  assert.deepEqual(client.requests[0].thinking, { type: "adaptive", display: "summarized" });
});

test("run() 便捷封装收集事件", async () => {
  const { app } = makeApp(settings, [say("hello world")]);
  const r = await app.agent.run("hi");
  assert.equal(r.text, "hello world");
  assert.equal(r.events.at(-1)!.type, "TurnEnd");
});

test("AnthropicClient 适配层转换流事件", async () => {
  const sdk = new StubSDK([textStream("你好世界", { thinking: "想一下" })]);
  const c = new AnthropicClient("claude-opus-5-5", { sdkClient: sdk });
  const req: ModelRequest = {
    system: [], messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "Bash", description: "", input_schema: { type: "object" } }],
  };
  const evs = await collect(c.stream(req));
  assert.deepEqual(evs.map((e) => e.type), ["ThinkingDelta", "TextDelta", "TextDelta", "MessageDone"]);
  const done = evs.at(-1)!;
  assert.ok(done.type === "MessageDone");
  assert.deepEqual(done.content.at(-1), { type: "text", text: "你好世界" });
  assert.equal(done.content[0].signature, "sig"); // thinking 块原样保留
  const kw = sdk.calls[0];
  assert.equal(kw.model, "claude-opus-5-5");
  assert.equal(kw.tools[0].eager_input_streaming, true);
});
