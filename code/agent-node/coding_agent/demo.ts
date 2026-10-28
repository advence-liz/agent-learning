/**
 * 离线演示：在临时目录里放一个有 bug 的函数，让 fake 模型按脚本走完「读 → 改 → 测 → 总结」。
 *
 * 工具是真的在执行（真的读写文件、真的跑 node），只有「模型的决定」是预先写好的。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "./agent.ts";
import { FakeAnthropic, text, toolUse } from "../fake_llm/index.ts";

export const BUGGY = "export const add = (a, b) => a - b;\n";
export const FIXED = "export const add = (a, b) => a + b;\n";
// 不用 node:assert：它失败时最后一行是「Node.js v24.x」，日志里只看得到最后一行
const TEST =
  'import { add } from "./calc.mjs";\n' +
  'if (add(2, 3) !== 5) { console.error("AssertionError:", add(2, 3)); process.exit(1); }\n' +
  'console.log("ok");\n';

export function script() {
  return [
    toolUse("run_command", { command: "node test_calc.mjs" }, { say: "先跑一下测试看看现状。" }),
    toolUse("read_file", { path: "calc.mjs" }),
    toolUse("write_file", { path: "calc.mjs", content: FIXED }, { say: "add 写成了减法，修正。" }),
    toolUse("run_command", { command: "node test_calc.mjs" }),
    text("修复完成：calc.add 把 `a - b` 改成了 `a + b`，test_calc.mjs 通过。"),
  ];
}

export function setup(d: string): void {
  writeFileSync(join(d, "calc.mjs"), BUGGY);
  writeFileSync(join(d, "test_calc.mjs"), TEST);
}

if (import.meta.main) {
  const d = mkdtempSync(join(tmpdir(), "coding-agent-"));
  try {
    setup(d);
    const client = new FakeAnthropic(script());
    const task = "test_calc.mjs 挂了，帮我修好";
    console.log(`❯ ${task}`);
    const final = await runAgent(client, task, d);
    console.log(`⏺ ${final}`);
    console.log("---- 第 2 次请求时 messages 的角色序列 ----");
    console.log(client.calls[1].messages.map((m) => m.role));
    console.log("---- calc.mjs 现在的内容 ----");
    process.stdout.write(readFileSync(join(d, "calc.mjs"), "utf8"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
