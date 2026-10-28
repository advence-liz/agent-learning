/** 第 15 章：按 .mcp.json 注册 MCP server（真实 stdio 子进程，不联网）。 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { App } from "../mini_cc/cli.ts";
import type { Settings } from "../mini_cc/config.ts";
import { convertContent, loadConfig, mcpToolName } from "../mini_cc/mcp_client.ts";
import { type Block, call, FakeClient, type Script, say } from "../mini_cc/model.ts";
import { BufferUI } from "../mini_cc/ui.ts";
import { cleanupTmp, makeSettings, tmpPath } from "./conftest.ts";

const SERVER = join(import.meta.dirname, "..", "examples", "mcp_tracker_server.ts");

function writeMcpJson(cwd: string, servers: Record<string, unknown>): void {
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
}

const tracker = () => ({ command: process.execPath, args: [SERVER] });

let settings: Settings;
const apps: App[] = []; // 同 Python 版的 apps fixture：测试结束时关掉所有连接（杀掉 server 子进程）
beforeEach(() => (settings = makeSettings()));
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  cleanupTmp();
});

async function makeMcpApp(script: Script[], answers: string[]): Promise<{ app: App; client: FakeClient; ui: BufferUI }> {
  const client = new FakeClient(script);
  const ui = new BufferUI(answers);
  const app = new App(settings, client, { ui });
  apps.push(app);
  await app.startMcp();
  return { app, client, ui };
}

test("loadConfig 展开环境变量、合并两级配置", () => {
  const old = process.env.TRACKER_TOKEN;
  process.env.TRACKER_TOKEN = "t0k";
  try {
    const root = tmpPath();
    const proj = join(root, "p"), home = join(root, "h");
    mkdirSync(proj);
    mkdirSync(home);
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: {
      notes: { command: "notes-server" }, tracker: { command: "old" } } }));
    writeMcpJson(proj, { tracker: { command: "python", args: ["s.py", "${TRACKER_TOKEN}", "${MISSING:-dflt}"] } });
    const cfg = loadConfig(proj, home);
    assert.equal(cfg.get("tracker")!.scope, "project");
    assert.deepEqual(cfg.get("tracker")!.args, ["s.py", "t0k", "dflt"]);
    assert.equal(cfg.get("notes")!.scope, "user");
  } finally {
    if (old === undefined) delete process.env.TRACKER_TOKEN;
    else process.env.TRACKER_TOKEN = old;
  }
});

test("工具名符合 API 规则", () => {
  assert.equal(mcpToolName("my server", "do.thing"), "mcp__my_server__do_thing");
  assert.equal(mcpToolName("s".repeat(40), "t".repeat(40)).length, 64);
});

test("convertContent 保留图片", () => {
  const out = convertContent([{ type: "text", text: "hi" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
  assert.deepEqual(out[0], { type: "text", text: "hi" });
  assert.deepEqual(out[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
});

test("真实 stdio server 端到端", async () => {
  writeMcpJson(settings.cwd, { tracker: tracker() });
  const script = [call("mcp__tracker__list_issues", {}),
    call("mcp__tracker__add_comment", { issue_id: "BUG-101", body: "已加分页" }),
    say("查到了，也回复了")];
  const { app, client, ui } = await makeMcpApp(script, ["1", "1"]); // 第 1 个 1：批准项目 server；第 2 个 1：允许 add_comment
  assert.ok(ui.text.includes("项目 .mcp.json 声明了 MCP server tracker"));
  await app.handleLine("看看有哪些 issue，给 BUG-101 回复一下");
  const req = client.requests;
  const names = new Set(req[0].tools!.map((t) => t.name));
  for (const n of ["mcp__tracker__list_issues", "mcp__tracker__get_issue", "mcp__tracker__add_comment"]) assert.ok(names.has(n));
  // 只读工具（readOnlyHint）免审批；写操作要问
  assert.equal(ui.text.split("是否允许").length - 1, 1);
  assert.ok(ui.text.includes("是否允许 mcp__tracker__add_comment"));
  const first = (req[1].messages.at(-1)!.content as Block[])[0];
  assert.ok(first.content[0].text.includes("BUG-101 [Todo]") && !first.is_error);
  assert.ok((req[2].messages.at(-1)!.content as Block[])[0].content[0].text.includes("Comment added to BUG-101"));
  // server 的 instructions 进了 system
  const system = req[0].system.map((b) => b.text).join("\n");
  assert.ok(system.includes("# MCP server instructions") && system.includes("## tracker"));
  await app.handleLine("/mcp");
  assert.ok(ui.text.includes("tracker") && ui.text.includes("connected") && ui.text.includes("3 tools"));
});

test("工具报错原样回给模型", async () => {
  writeMcpJson(settings.cwd, { tracker: tracker() });
  const { app, client } = await makeMcpApp([call("mcp__tracker__get_issue", { issue_id: "NOPE" }), say("没有")], ["1"]);
  await app.handleLine("看看 NOPE");
  const r = (client.requests[1].messages.at(-1)!.content as Block[])[0];
  assert.ok(r.is_error && JSON.stringify(r).includes("No issue NOPE"));
});

test("连不上的 server 不影响启动", async () => {
  writeMcpJson(settings.cwd, { broken: { command: "definitely-not-a-real-binary-xyz" }, tracker: tracker() });
  const { app, ui } = await makeMcpApp([], ["1", "1"]);
  const st = app.mcp.servers;
  assert.ok(st.get("broken")!.status === "failed" && st.get("broken")!.error);
  assert.equal(st.get("tracker")!.status, "connected");
  await app.handleLine("/mcp");
  assert.ok(ui.text.includes("failed"));
});

test("项目级 server 要批准，批准后记住", async () => {
  writeMcpJson(settings.cwd, { tracker: tracker() });
  const { app } = await makeMcpApp([], ["2"]); // 2 = 不启动
  assert.equal(app.mcp.servers.get("tracker")!.status, "disabled");
  assert.ok(!app.agent.tools.names().some((n) => n.startsWith("mcp__")));
  const { app: app2 } = await makeMcpApp([], ["1"]); // 换个进程再问，这次批准
  assert.equal(app2.mcp.servers.get("tracker")!.status, "connected");
  const { app: app3, ui: ui3 } = await makeMcpApp([], []); // 批准过且配置没变：不再问
  assert.ok(!ui3.text.includes("是否启动"));
  assert.equal(app3.mcp.servers.get("tracker")!.status, "connected");
});
