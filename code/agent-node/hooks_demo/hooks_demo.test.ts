import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as guardBash from "./guard_bash.ts";
import * as hookRunner from "./hook_runner.ts";
import * as stopGate from "./stop_gate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function pre(cmd: string) {
  return { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd } };
}

test("rm -rf / 走 exit 2", () => {
  const [code, out, err] = guardBash.decide(pre("rm -rf /"));
  assert.ok(code === 2 && out === "" && err.includes("根目录"));
});

test("git push --force 走 JSON deny", () => {
  const [code, out] = guardBash.decide(pre("git push --force"));
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});

test("--force-with-lease 放行", () => {
  assert.deepEqual(guardBash.decide(pre("git push --force-with-lease")), [0, "", ""]);
});

test("updatedInput 改写参数", () => {
  const [, out] = guardBash.decide(pre("python3 a.py"));
  const hso = JSON.parse(out).hookSpecificOutput;
  assert.equal(hso.updatedInput.command, "python3 -I a.py");
});

test("stop_gate 的防死循环", () => {
  const tp = join(mkdtempSync(join(tmpdir(), "stop-gate-")), "t.jsonl");
  writeFileSync(tp, "nothing");
  assert.equal(stopGate.decide({ transcript_path: tp })?.decision, "block");
  assert.equal(stopGate.decide({ transcript_path: tp, stop_hook_active: true }), null);
  writeFileSync(tp, "ℹ pass 3");
  assert.equal(stopGate.decide({ transcript_path: tp }), null);
});

test("hook_runner 端到端", () => {
  process.chdir(dirname(HERE)); // demo_settings.json 里的命令按 code/agent-node 的相对路径写
  const settings = JSON.parse(readFileSync(join(HERE, "demo_settings.json"), "utf8"));
  let v = hookRunner.dispatch(settings, pre("rm -rf /"));
  assert.ok(v.blocked && v.permission === "deny");
  v = hookRunner.dispatch(settings, { hook_event_name: "SessionStart" });
  assert.deepEqual(v.context, ["本仓库：先跑 npm test 再交付"]);
  // matcher 不命中：Edit 不触发 Bash 守卫
  v = hookRunner.dispatch(settings, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} });
  assert.ok(!v.blocked);
  assert.deepEqual(v.log, []);
});
