/**
 * 离线演示：假上游 + 抓包代理 + 两次「像 Claude Code 一样」的请求，然后拆解抓包结果。
 * 见 p3-agent-internals/01-http-analyzer.md。
 *
 *     node http_analyzer/demo.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as analyze from "./analyze.ts";
import { makeServer } from "./fake_upstream.ts";
import { serve } from "./proxy.ts";

type Obj = Record<string, any>;

const TOOLS = [
  {
    name: "Read", description: "Reads a file from the local filesystem.".repeat(5),
    input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
  },
  {
    name: "Bash", description: "Executes a bash command.".repeat(8),
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
];
const SYSTEM = [
  { type: "text", text: "You are a coding agent." },
  { type: "text", text: "# 行为规范\n" + "规则……".repeat(200), cache_control: { type: "ephemeral" } },
];

function body(messages: Obj[]): Obj {
  const msgs = messages.map((m) => ({ ...m }));
  // 和 Claude Code 一样：在最后一条消息的最后一个块上打断点，让下一轮能读到这一轮的缓存
  const last = msgs[msgs.length - 1];
  let content: Obj[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  content = content.map((b) => ({ ...b }));
  content[content.length - 1].cache_control = { type: "ephemeral" };
  msgs[msgs.length - 1] = { role: last.role, content };
  return { model: "claude-sonnet-5-5", max_tokens: 1024, stream: true, system: SYSTEM, tools: TOOLS, messages: msgs };
}

async function main(): Promise<void> {
  const up = await makeServer(0);
  const out = mkdtempSync(join(tmpdir(), "cap-"));
  const px = await serve(0, `http://127.0.0.1:${up.port}`, out);
  const base = `http://127.0.0.1:${px.port}`;
  const headers = {
    "x-api-key": "sk-ant-api03-THIS-IS-A-FAKE-KEY-0000000000",
    "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-demo",
    "content-type": "application/json",
  };

  const turn1 = [{ role: "user", content: "hi" }];
  const turn2 = [
    ...turn1,
    { role: "assistant", content: [{ type: "text", text: "你好！我是离线假模型。" }] },
    { role: "user", content: "再说一句" },
  ];
  console.log("== proxy stdout");
  for (const msgs of [turn1, turn2]) {
    const r = await fetch(base + "/v1/messages", { method: "POST", body: JSON.stringify(body(msgs)), headers });
    const text = await r.text();
    assert.ok(r.status === 200 && text.includes("message_stop"));
  }

  console.log("\n== analyze --show 1");
  console.log(analyze.show(...analyze.load(out, 1)));
  console.log("\n== analyze --prefix 1 2");
  const [ra] = analyze.load(out, 1);
  const [rb] = analyze.load(out, 2);
  console.log("shared prefix blocks: %d / %d / %d", ...analyze.commonPrefix(ra.body, rb.body));
  console.log("\n== request.json headers (redacted)");
  const first = readdirSync(out).sort()[0];
  console.log(JSON.stringify(JSON.parse(readFileSync(join(out, first, "request.json"), "utf8")).headers, null, 1).slice(0, 400));
  for (const s of [px.server, up.server]) {
    s.closeAllConnections();
    s.close();
  }
}

if (import.meta.main) await main();
