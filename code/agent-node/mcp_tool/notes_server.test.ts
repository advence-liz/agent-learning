import assert from "node:assert/strict";
import { test } from "node:test";

import { connect } from "./client_demo.ts";

test("真实 stdio 子进程往返", async () => {
  const s = await connect(); // 和 client_demo 一样：node 拉起 notes_server.ts 子进程
  let names: string[], hit: any, note: any, bad: any;
  try {
    names = (await s.listTools()).tools.map((t) => t.name).sort();
    hit = await s.callTool({ name: "search_notes", arguments: { query: "permissionDecision" } });
    note = await s.callTool({ name: "read_note", arguments: { path: "claude-hooks.md" } });
    bad = await s.callTool({ name: "read_note", arguments: { path: "../notes_server.py" } });
  } finally {
    await s.close();
  }

  assert.deepEqual(names, ["read_note", "search_notes"]);
  assert.equal(hit.structuredContent.result[0].path, "claude-hooks.md");
  assert.ok(note.content[0].text.startsWith("# Claude Code hooks"));
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /只能读取/);
});
