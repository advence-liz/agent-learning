/**
 * 第 1 章：Agent = 模型 + 一个 while 循环 + 一张工具表。
 *
 * 离线运行： node core/agent_loop.ts
 * 真实运行：把 new FakeAnthropic(...) 换成 new Anthropic()（读 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL）。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { FakeAnthropic, text, toolUse, type LLMClient } from "../fake_llm/index.ts";

export const MODEL = "claude-opus-5-5";

export type Handler = (args: any) => string | Promise<string>;

export async function runAgent(
  client: LLMClient,
  task: string,
  tools: Anthropic.Tool[],
  handlers: Record<string, Handler>,
  { system = "", maxTurns = 10, log = console.log }: { system?: string; maxTurns?: number; log?: (s: string) => void } = {},
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  for (let i = 0; i < maxTurns; i++) {
    const resp = await client.messages.create({ model: MODEL, max_tokens: 16000, system, tools, messages });
    messages.push({ role: "assistant", content: resp.content }); // 原样追加，别只留文字
    if (resp.stop_reason !== "tool_use") {
      // 模型不再要工具 → 这一轮就是最终回答
      return resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      log(`⏺ ${block.name}(${JSON.stringify(block.input)})`);
      let out: string, isError: boolean;
      try {
        [out, isError] = [await handlers[block.name](block.input), false];
      } catch (e) {
        // 工具失败也要回给模型，而不是让循环崩掉
        [out, isError] = [`${(e as Error).name}: ${(e as Error).message}`, true];
      }
      log(`✔ ${out.slice(0, 80)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: out, is_error: isError });
    }
    messages.push({ role: "user", content: results }); // 所有结果放进同一条 user 消息
  }
  throw new Error(`超过 ${maxTurns} 轮仍未结束`);
}

// ---------- 离线演示：一个假的 webapp 仓库 + 一个 fake 模型 ----------

const FAKE_REPO: Record<string, string> = {
  "apps/web/vitest.config.ts": "export default defineConfig({ test: { environment: 'jsdom', testTimeout: 15000 } })",
};

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "读取仓库里一个文本文件的全部内容。",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

export function readFile({ path }: { path: string }): string {
  if (!(path in FAKE_REPO)) throw Object.assign(new Error(path), { name: "FileNotFoundError" });
  return FAKE_REPO[path];
}

export async function demo(): Promise<[string, FakeAnthropic]> {
  const client = new FakeAnthropic([
    toolUse("read_file", { path: "apps/web/vitest.config.ts" }, { say: "我先看一下配置文件。" }),
    text("webapp 的 vitest 单测超时是 15000ms（15 秒），环境是 jsdom。"),
  ]);
  const task = "webapp 的 vitest 单测超时设的是多少？";
  console.log(`❯ ${task}`);
  const answer = await runAgent(client, task, TOOLS, { read_file: readFile });
  console.log(`⏺ ${answer}`);
  return [answer, client];
}

if (import.meta.main) {
  const [, client] = await demo();
  console.log(
    `\n[离线 fake 模型] 共请求模型 ${client.calls.length} 次；` +
      `第 2 次请求里 messages 的角色序列：${JSON.stringify(client.calls[1].messages.map((m) => m.role))}`,
  );
}
