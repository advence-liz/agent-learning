/** 第 3 章：三层错误处理——API 重试、工具两道防线、主循环安全网。 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { APIError } from "@anthropic-ai/sdk";
import type { Settings } from "../mini_cc/config.ts";
import type { Event } from "../mini_cc/events.ts";
import { AnthropicClient, call, FakeTurn, ModelError, type ModelRequest, say, type Script, textBlock, toolBlock } from "../mini_cc/model.ts";
import { RetryPolicy } from "../mini_cc/retry.ts";
import { type Args, Tool, ToolResult } from "../mini_cc/tools/base.ts";
import { cleanupTmp, collect, makeApp, makeSettings } from "./conftest.ts";
import { StubSDK, textStream } from "./sdk_stub.ts";

const OVERLOADED = () => new ModelError("529 Overloaded", { retryable: true, kind: "overloaded", status: 529 });
const AUTH = () => new ModelError("401 invalid x-api-key", { retryable: false, kind: "auth", status: 401 });

let settings: Settings;
beforeEach(() => (settings = makeSettings()));
afterEach(cleanupTmp);

/** 同 Python 的 quiet fixture：sleep 换成记录器，重试不真等。 */
function quiet(...script: Script[]) {
  const made = makeApp(settings, script);
  const slept: number[] = [];
  made.app.agent.sleep = (s) => void slept.push(s);
  return { ...made, slept };
}

const lastToolResult = (req: ModelRequest) => (req.messages.at(-1)!.content as any[])[0];

// ---------------------------------------------------------------- 第一层：API 重试

test("重试两次后成功", async () => {
  const { app, client, slept } = quiet(OVERLOADED(), OVERLOADED(), say("终于好了"));
  const evs = await collect(app.agent.runTurn("hi"));
  const notices = evs.filter((e) => e.type === "Notice");
  assert.equal(notices.length, 2);
  assert.ok(notices[0].type === "Notice" && notices[0].text.includes("第 1/5 次重试"));
  assert.deepEqual(evs.at(-1), { type: "TurnEnd", stopReason: "end_turn", text: "终于好了", extra: {} });
  assert.equal(client.requests.length, 3);
  assert.equal(slept.length, 2);
});

test("退避增长，且尊重 retry-after", () => {
  const p = new RetryPolicy(5, 1.0, 30.0);
  const d1 = p.delay(1, OVERLOADED()), d3 = p.delay(3, OVERLOADED());
  assert.ok(d1 >= 1.0 && d1 < 1.5);
  assert.ok(d3 >= 4.0 && d3 < 4.5);
  assert.equal(p.delay(1, new ModelError("429", { retryable: true, retryAfter: 7 })), 7);
});

test("不可重试的错误立即失败，REPL 还能继续用", async () => {
  const { app, client, ui } = quiet(AUTH(), say("key 修好之后的回答"));
  await app.handleLine("hi");
  assert.ok(ui.text.includes("模型请求失败（auth）"));
  assert.equal(client.requests.length, 1); // 401 不重试
  await app.handleLine("再试一次"); // 进程还活着，可以继续聊
  assert.ok(ui.text.includes("key 修好之后的回答"));
});

test("重试次数用完就放弃", async () => {
  const { app, client } = quiet(...Array.from({ length: 6 }, OVERLOADED));
  const evs = await collect(app.agent.runTurn("hi"));
  const end = evs.at(-1)!;
  assert.ok(end.type === "TurnEnd" && end.stopReason === "error");
  assert.equal(client.requests.length, 6);
});

test("流到一半断开：半截输出丢弃，历史干净", async () => {
  const broken = new FakeTurn([textBlock("这句话说到一半")], {
    failAfter: 4, failWith: new ModelError("connection reset", { retryable: true, kind: "network" }),
  });
  const { app, ui } = quiet(broken, say("完整的回答"));
  await app.handleLine("hi");
  assert.ok(ui.text.includes("上面的输出不完整，已丢弃"));
  const assistantMsgs = app.agent.messages.filter((m) => m.role === "assistant");
  assert.deepEqual(assistantMsgs, [{ role: "assistant", content: [textBlock("完整的回答")] }]);
});

test("SDK 异常被翻译成 ModelError", async () => {
  // 真实的 SDK 异常对象：APIError.generate 按状态码选子类（529 → InternalServerError）
  const err = APIError.generate(529, { message: "Overloaded" }, "Overloaded", new Headers({ "retry-after": "3" }));
  const sdk = new StubSDK([err, textStream("ok")]);
  const c = new AnthropicClient("claude-opus-5-5", { sdkClient: sdk });
  const r: ModelRequest = { system: [], messages: [{ role: "user", content: "hi" }] };
  await assert.rejects(collect(c.stream(r)), (e: unknown) => {
    assert.ok(e instanceof ModelError);
    assert.ok(e.retryable && e.kind === "overloaded" && e.retryAfter === 3.0);
    return true;
  });
  await collect(c.stream(r));
  // fallbacks 默认开：走 beta 接口，带 server-side-fallback 头和 fallbacks="default"
  assert.equal(sdk.calls[1].fallbacks, "default");
  assert.deepEqual(sdk.calls[1].betas, ["server-side-fallback-2026-07-01"]);
});

test("流里解析不了的工具参数 JSON 可重试", async () => {
  // Node SDK 用 JSON.parse 解析工具参数，失败时抛 SyntaxError（Python 版是 ValueError）
  const sdk = new StubSDK([textStream("x", { error: new SyntaxError("Unterminated string in JSON") }), textStream("ok")]);
  const c = new AnthropicClient("claude-opus-5-5", { sdkClient: sdk, fallbacks: false });
  await assert.rejects(collect(c.stream({ system: [], messages: [] })), (e: unknown) => {
    assert.ok(e instanceof ModelError && e.retryable && e.kind === "invalid_json");
    return true;
  });
});

// ---------------------------------------------------------------- 第二层：工具防线

class Boom extends Tool {
  override name = "Boom";
  override inputSchema = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };

  override run(args: Args): ToolResult {
    // JS 里 1/0 是 Infinity 不抛错，这里显式抛一个，模拟 Python 版的 ZeroDivisionError
    if (args.n === 0) throw new RangeError("division by zero");
    return new ToolResult(String(1 / args.n));
  }
}

test("工具异常变成错误结果", async () => {
  const { app, client } = quiet(call("Boom", { n: 0 }), say("除零了，换个数"));
  app.agent.tools.register(new Boom());
  const evs = await collect(app.agent.runTurn("算 1/0"));
  const end = evs.find((e) => e.type === "ToolEnd")!;
  assert.ok(end.type === "ToolEnd" && end.result.isError && String(end.result.content).includes("RangeError"));
  const sent = lastToolResult(client.requests[1]);
  assert.equal(sent.is_error, true);
  assert.ok(sent.content.startsWith("<tool_use_error>"));
});

test("参数校验错误回给模型", async () => {
  const { app, client } = quiet(call("Boom", { n: "zero" }), say("参数类型错了"));
  app.agent.tools.register(new Boom());
  await collect(app.agent.runTurn("go"));
  const content = lastToolResult(client.requests[1]).content;
  assert.ok(content.includes("InputValidationError") && content.includes("input.n should be integer"));
});

test("未知工具", async () => {
  const { app, client } = quiet(call("Nope", {}), say("ok"));
  await collect(app.agent.runTurn("go"));
  assert.ok(lastToolResult(client.requests[1]).content.includes("No such tool available: Nope"));
});

test("Bash 超时", async () => {
  const { app, client } = quiet(call("Bash", { command: "sleep 5", timeout: 1 }), say("超时了"));
  await collect(app.agent.runTurn("go"));
  assert.ok(lastToolResult(client.requests[1]).content.includes("timed out after 1s"));
});

test("超长输出被截断", async () => {
  const { app, client } = quiet(call("Bash", { command: `node -e 'console.log("x".repeat(50000))'` }), say("ok"));
  app.settings.maxToolOutput = 1000;
  await collect(app.agent.runTurn("go"));
  const content = lastToolResult(client.requests[1]).content;
  assert.ok(content.length < 1100 && content.includes("output truncated"));
});

// ---------------------------------------------------------------- 第三层：安全网

test("max_tokens 截断的工具调用不执行", async () => {
  const trunc = new FakeTurn([toolBlock("Write", { file_path: "a.txt" })], { stopReason: "max_tokens" });
  const { app, client } = quiet(trunc, say("我分块写"));
  await collect(app.agent.runTurn("写大文件"));
  assert.equal(existsSync(join(app.settings.cwd, "a.txt")), false);
  assert.ok(lastToolResult(client.requests[1]).content.includes("NOT executed"));
});

test("refusal 结束本轮", async () => {
  const { app } = quiet(new FakeTurn([], { stopReason: "refusal" }));
  const evs = await collect(app.agent.runTurn("..."));
  const end = evs.at(-1)!;
  assert.ok(end.type === "TurnEnd" && end.stopReason === "refusal");
});

test("中断后修复悬空的 tool_use", async () => {
  const { app } = quiet(call("Bash", { command: "echo hi" }));
  for await (const ev of app.agent.runTurn("go")) {
    // 模拟 Ctrl+C：在工具开始后、结果写回前提前结束迭代（break 会调用生成器的 return()）
    if (ev.type === "ToolStart") break;
  }
  const last = app.agent.messages.at(-1)!;
  const block = (last.content as any[])[0];
  assert.equal(last.role, "user");
  assert.equal(block.type, "tool_result");
  assert.ok(block.content.includes("Interrupted"));
});

test("我们自己代码里的意外错误也不逃逸", async () => {
  const explode = () => {
    throw new TypeError("bug in our code");
  };
  const { app } = quiet(explode);
  const evs: Event[] = await collect(app.agent.runTurn("go"));
  const end = evs.at(-1)!, before = evs.at(-2)!;
  assert.ok(end.type === "TurnEnd" && end.stopReason === "error");
  assert.ok(before.type === "Notice" && before.text.includes("内部错误"));
});
