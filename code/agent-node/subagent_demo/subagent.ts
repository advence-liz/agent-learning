#!/usr/bin/env node
/**
 * Sub Agent 的最小实现：父子是两个独立的 messages 数组，子 agent 只把最后一段文字交回去。
 *
 * 结构：
 *   runAgent(client, system, messages, tools)  —— 标准的 tool-use 循环（和 Messages API 同形）
 *   Agent 工具                                  —— 在父循环里被调用时，新建一个**空的** messages，
 *                                                 只放一条 user=任务描述，跑完取最后的 text 当 tool_result
 *
 * 离线运行：node subagent_demo/subagent.ts
 *   用 ScriptedClient 按剧本返回 tool_use / text，读的是本仓库真实文件。
 * 真实运行：把 client 换成 new Anthropic()（读 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL），本 demo 不发请求。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FakeAnthropic, type CreateParams, type LLMClient, type Message, type Step } from "../fake_llm/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // code/agent-node

// ---------------- 工具 ----------------

type Tool = (input: any) => string | Promise<string>;

export function toolReadFile({ path }: { path: string }): string {
  return readFileSync(join(ROOT, path), "utf8");
}

export function toolGrep({ pattern }: { pattern: string }): string {
  const hits: string[] = [];
  for (const p of globSync("*_demo/*.ts", { cwd: ROOT }).sort()) {
    readFileSync(join(ROOT, p), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.includes(pattern)) hits.push(`${p}:${i + 1}: ${line.trim()}`);
      });
  }
  return hits.join("\n") || "(no match)";
}

export const CHILD_TOOLS: Record<string, Tool> = { read_file: toolReadFile, grep: toolGrep };

// ---------------- 通用 agent 循环 ----------------

export class RunStats {
  requests = 0;
  toolCalls = 0;
}

export async function runAgent(
  client: LLMClient,
  system: string,
  messages: Anthropic.MessageParam[],
  tools: Record<string, Tool>,
  stats: RunStats,
): Promise<string> {
  while (true) {
    const resp = await client.messages.create({
      model: "claude-sonnet-5-5",
      max_tokens: 4096,
      system,
      tools: Object.keys(tools).map((n) => ({ name: n }) as Anthropic.Tool), // demo：只给名字
      messages,
    });
    stats.requests += 1;
    messages.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") {
      return resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of resp.content) {
      if (b.type === "tool_use") {
        stats.toolCalls += 1;
        const out = await tools[b.name](b.input);
        results.push({ type: "tool_result", tool_use_id: b.id, content: out });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

/** 父 agent 看到的 Agent 工具。关键就三行：新数组、只放任务、只回结论。 */
export function makeAgentTool(client: LLMClient, childStats: RunStats, childTranscripts: Anthropic.MessageParam[][]): Tool {
  return async ({ description, prompt }: { description: string; prompt: string }) => {
    const childMessages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }]; // ← 全新的 messages，看不到父历史
    const childSystem = "你是代码探索子 agent。只读不写，最后用 5 行以内给出结论和文件:行号。";
    const result = await runAgent(client, childSystem, childMessages, CHILD_TOOLS, childStats);
    childTranscripts.push(childMessages); // 子历史落盘（Claude Code 存到 subagents/agent-*.jsonl）
    return result; // ← 父亲只拿到这一段
  };
}

// ---------------- 离线剧本 client ----------------

type Block = Step["content"][number];

export function tu(id: string, name: string, input: Record<string, unknown>): Block {
  return { type: "tool_use", id, name, input };
}

export function tx(text: string): Block {
  return { type: "text", text };
}

function step(blocks: Block[]): Step {
  const stop = blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  return { content: blocks, stop_reason: stop, usage: { input_tokens: 0, output_tokens: 0 } };
}

const who = (params: CreateParams) => (String(params.system).includes("子 agent") ? "child" : "parent");

/** 按 system prompt 区分父/子，各自按顺序吐剧本里的响应（父、子各一个 FakeAnthropic）。 */
export class ScriptedClient implements LLMClient {
  fakes: Record<string, FakeAnthropic>;
  requests: Array<{ who: string; nMessages: number; chars: number }> = [];
  messages: { create: (params: CreateParams) => Promise<Message> };

  constructor(scripts: Record<string, Block[][]>) {
    this.fakes = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, new FakeAnthropic(v.map(step))]));
    this.messages = { create: (params) => this.create(params) }; // 走原型方法，测试才能 spy
  }

  create(params: CreateParams): Promise<Message> {
    this.requests.push({ who: who(params), nMessages: params.messages.length, chars: size(params.messages) });
    return this.fakes[who(params)].messages.create(params);
  }
}

export function size(messages: unknown[]): number {
  return JSON.stringify(messages).length;
}

export const FILES = ["hooks_demo/guard_bash.ts", "hooks_demo/hook_runner.ts", "hooks_demo/stop_gate.ts"];
export const CONCLUSION =
  "exit 2 的处理在 hooks_demo/hook_runner.ts 的 dispatch()：code === 2 时对阻断类事件置 blocked，" +
  "stderr 作理由；guard_bash.ts 对 rm -rf / 返回 2。";

/** 不用子 agent：父亲自己 grep + 读 3 个文件。 */
export async function scenarioInline(): Promise<[number, RunStats]> {
  const c = new ScriptedClient({
    parent: [
      [tu("p1", "grep", { pattern: "exit" })],
      [tu("p2", "read_file", { path: FILES[0] }), tu("p3", "read_file", { path: FILES[1] }), tu("p4", "read_file", { path: FILES[2] })],
      [tx(CONCLUSION)],
    ],
  });
  const msgs: Anthropic.MessageParam[] = [{ role: "user", content: "hook 的 exit 2 在 demo 里是在哪处理的？" }];
  const st = new RunStats();
  await runAgent(c, "你是主 agent。", msgs, CHILD_TOOLS, st);
  return [size(msgs), st];
}

export async function scenarioSubagent(): Promise<[number, number, RunStats, RunStats]> {
  const c = new ScriptedClient({
    parent: [
      [tu("p1", "agent", { description: "找 exit 2 处理", prompt: "在 *_demo 里找 hook exit 2 的处理位置，给文件:行号" })],
      [tx(CONCLUSION)],
    ],
    child: [
      [tu("c1", "grep", { pattern: "exit" })],
      [tu("c2", "read_file", { path: FILES[0] }), tu("c3", "read_file", { path: FILES[1] }), tu("c4", "read_file", { path: FILES[2] })],
      [tx(CONCLUSION)],
    ],
  });
  const [childStats, transcripts] = [new RunStats(), [] as Anthropic.MessageParam[][]];
  const parentTools = { agent: makeAgentTool(c, childStats, transcripts) };
  const msgs: Anthropic.MessageParam[] = [{ role: "user", content: "hook 的 exit 2 在 demo 里是在哪处理的？" }];
  const st = new RunStats();
  await runAgent(c, "你是主 agent。", msgs, parentTools, st);
  return [size(msgs), size(transcripts[0]), st, childStats];
}

if (import.meta.main) {
  const [inlineChars, s1] = await scenarioInline();
  const [parentChars, childChars, s2, cs] = await scenarioSubagent();
  const n = (x: number) => String(x).padStart(6);
  console.log(`[inline]   父 messages = ${n(inlineChars)} 字符  (父请求 ${s1.requests} 次, 工具 ${s1.toolCalls} 次)`);
  console.log(`[subagent] 父 messages = ${n(parentChars)} 字符  (父请求 ${s2.requests} 次, 工具 ${s2.toolCalls} 次)`);
  console.log(`           子 messages = ${n(childChars)} 字符  (子请求 ${cs.requests} 次, 工具 ${cs.toolCalls} 次，用完即弃)`);
  console.log(`父上下文缩小到 inline 的 ${((parentChars / inlineChars) * 100).toFixed(1)}%`);
}
