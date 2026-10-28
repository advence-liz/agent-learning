/** 离线自测：假上游 + 代理。运行：node --test http_analyzer/tests/ */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { cacheBreakpoints, commonPrefix } from "../analyze.ts";
import { makeServer, type FakeAnthropic } from "../fake_upstream.ts";
import { serve } from "../proxy.ts";
import { redactText } from "../redact.ts";
import { assembleMessage, parseSse } from "../sse.ts";
import type { Server } from "node:http";

const FAKE_KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ-123456";

function walk(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((p) => join(dir, p))
    .filter((p) => statSync(p).isFile());
}

describe("ProxyTest", () => {
  let up: Server, px: Server, state: FakeAnthropic, out: string, base: string;

  before(async () => {
    const u = await makeServer(0);
    up = u.server;
    state = u.state;
    out = mkdtempSync(join(tmpdir(), "cap-test-"));
    const p = await serve(0, `http://127.0.0.1:${u.port}`, out);
    px = p.server;
    base = `http://127.0.0.1:${p.port}`;
  });

  after(() => {
    for (const s of [px, up]) {
      s.closeAllConnections();
      s.close();
    }
  });

  async function post(body: unknown, key: string | null = FAKE_KEY): Promise<[number, Headers, string]> {
    const h: Record<string, string> = { "anthropic-version": "2023-06-01", "content-type": "application/json" };
    if (key) h["x-api-key"] = key;
    const r = await fetch(base + "/v1/messages?beta=true", { method: "POST", body: JSON.stringify(body), headers: h });
    return [r.status, r.headers, await r.text()];
  }

  test("SSE 原样透传；上游拿到真 key，磁盘上脱敏", async () => {
    const body = {
      model: "m", stream: true, max_tokens: 10,
      system: [{ type: "text", text: "S".repeat(400), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    };
    const [status, headers, text] = await post(body);
    assert.equal(status, 200);
    assert.match(headers.get("content-type")!, /text\/event-stream/);
    const msg = assembleMessage(parseSse(text))!;
    assert.equal(msg.content[0].text, "你好！我是离线假模型。");
    // 上游拿到的是真 key（代理只在落盘时脱敏）
    assert.equal(state.receivedHeaders.at(-1)!["x-api-key"], FAKE_KEY);
    // 磁盘上任何文件都不含 key
    for (const f of walk(out)) assert.ok(!readFileSync(f, "utf8").includes(FAKE_KEY), f);
    const dirs = readdirSync(out, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const resp = JSON.parse(readFileSync(join(out, dirs.at(-1)!, "response.json"), "utf8"));
    assert.equal(resp.message.stop_reason, "end_turn");
    assert.equal(resp.sse_event_counts.content_block_delta, 2);
  });

  test("同一前缀第二次请求读缓存", async () => {
    const sysb = [{ type: "text", text: "X".repeat(800), cache_control: { type: "ephemeral" } }];
    const b1 = { model: "m", stream: true, system: sysb, messages: [{ role: "user", content: "a" }] };
    await post(b1);
    await post(b1);
    const rows = readFileSync(join(out, "index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const last2 = rows.slice(-2).map((r) => r.usage);
    assert.ok(last2[0].cache_creation_input_tokens > 0);
    assert.equal(last2[1].cache_creation_input_tokens, 0);
    assert.ok(last2[1].cache_read_input_tokens > 0);
  });

  test("上游的错误状态码原样透传", async () => {
    const [status, , text] = await post({ model: "m", messages: [] }, null);
    assert.equal(status, 401);
    assert.match(text, /authentication_error/);
  });
});

describe("UnitTest", () => {
  test("正则兜底抹掉 key 和 Bearer token", () => {
    const s = redactText(`{"k": "${FAKE_KEY}", "auth": "Bearer abcdefghijklmnopqrstu"}`);
    assert.ok(!s.includes("ABCDEFGHIJ"));
    assert.ok(!s.includes("abcdefghijklmnop"));
  });

  test("tool_use 的分片 JSON 能拼回入参", () => {
    const raw =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"x","role":"assistant","content":[],"usage":{"input_tokens":3}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Read","input":{}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_pa"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"th\\": \\"/a.py\\"}"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}\n\n';
    const m = assembleMessage(parseSse(raw))!;
    assert.deepEqual(m.content[0].input, { file_path: "/a.py" });
    assert.equal(m.stop_reason, "tool_use");
    assert.deepEqual(m.usage, { input_tokens: 3, output_tokens: 9 });
  });

  test("缓存断点定位和公共前缀", () => {
    const a = {
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    };
    const b = { system: a.system, messages: [...a.messages, { role: "assistant", content: "yo" }] };
    assert.deepEqual(cacheBreakpoints(a), ['system[0] {"type":"ephemeral"}']);
    assert.deepEqual(commonPrefix(a, b), [2, 2, 3]);
  });
});
