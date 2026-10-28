import assert from "node:assert/strict";
import { test } from "node:test";

import { edgeCases, session } from "./raw_client.ts";

test("完整会话的报文", async () => {
  const c = await session(false);
  await c.close();
  const sent = c.log.filter(([d]) => d === "→").map(([, m]) => m);
  const got = new Map(c.log.filter(([d]) => d === "←").map(([, m]) => [m.id, m]));
  assert.deepEqual(sent.map((m) => m.method), [
    "initialize", "notifications/initialized", "tools/list", "tools/call", "tools/call",
    "resources/subscribe_everything", "ping"]);
  assert.ok(!("id" in sent[1])); // 通知没有 id
  assert.equal(got.size, 6); // 7 条发出，通知那条没有回应

  const init = got.get(1)!.result;
  assert.equal(init.protocolVersion, "2025-11-25");
  assert.equal(init.serverInfo.name, "notes");
  const tools = Object.fromEntries(got.get(2)!.result.tools.map((t: any) => [t.name, t]));
  assert.deepEqual(tools.search_notes.inputSchema.required, ["query"]);
  // Python SDK 成功时显式回 isError: false；Node SDK 成功时干脆不带这个字段
  assert.ok(!got.get(3)!.result.isError);
  assert.equal(got.get(3)!.result.structuredContent.result[0].path, "claude-hooks.md");
  assert.equal(got.get(4)!.result.isError, true);
  assert.ok(!("error" in got.get(4)!));
  assert.equal(got.get(5)!.error.code, -32601);
  assert.deepEqual(got.get(6)!.result, {});
});

test("边界情况", async () => {
  const out = await edgeCases(false);
  // 和 Python SDK 不同：Node 版 McpServer 不校验握手，没 initialize 也照样回 tools/list
  assert.ok("result" in out.no_handshake);
  assert.equal(out.bad_version.result.protocolVersion, "2025-11-25");
});
