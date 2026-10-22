/**
 * 第 1 章：最小聊天机器人。记忆 = messages 数组；人设 = system prompt。
 *
 * 真实运行：  node chatbot/bot.ts            （需 ANTHROPIC_API_KEY，可选 ANTHROPIC_BASE_URL）
 * 离线演示：  node chatbot/bot.ts --fake
 */

import { createInterface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { makeClient, text, type LLMClient } from "../fake_llm/index.ts";

export const MODEL = "claude-opus-5-5";

export class Chatbot {
  client: LLMClient;
  system: string;
  maxTokens: number;
  messages: Anthropic.MessageParam[] = []; // ← 这就是「记忆」的全部
  lastUsage?: Anthropic.Usage;

  constructor(client: LLMClient, { system = "你是一个简洁的中文助手。", maxTokens = 2048 } = {}) {
    this.client = client;
    this.system = system;
    this.maxTokens = maxTokens;
  }

  async send(userText: string): Promise<string> {
    this.messages.push({ role: "user", content: userText });
    const resp = await this.client.messages.create({
      model: MODEL,
      max_tokens: this.maxTokens,
      system: this.system, //       人设：每次请求都重新发一遍
      messages: this.messages, //   历史：每次请求都完整发一遍
    });
    const reply = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    // 把 assistant 回复也写回数组，下一轮模型才「记得」自己说过什么
    this.messages.push({ role: "assistant", content: resp.content });
    this.lastUsage = resp.usage;
    return reply;
  }

  reset(system?: string): void {
    this.messages.length = 0;
    if (system !== undefined) this.system = system;
  }
}

/** 命令：/reset 清空记忆；/system <文本> 换人设并清空记忆；/quit 退出。 */
export async function repl(bot: Chatbot, lines?: string[]): Promise<void> {
  const rl = lines ? null : createInterface({ input: process.stdin, output: process.stdout });
  // 给了 lines 就按脚本回放；否则一行行读终端（Ctrl-D 结束）
  const src: AsyncIterable<string> | Iterable<string> = lines ?? rl!;
  rl?.setPrompt("❯ ");
  rl?.prompt();
  try {
    for await (const line of src) {
      if (lines) console.log(`❯ ${line}`);
      if (line === "/quit") break;
      if (line === "/reset") {
        bot.reset();
        console.log("（记忆已清空）");
      } else if (line.startsWith("/system ")) {
        bot.reset(line.slice("/system ".length));
        console.log(`（人设已切换为：${bot.system}）`);
      } else {
        const reply = await bot.send(line);
        const u = bot.lastUsage!;
        console.log(`⏺ ${reply}   [in=${u.input_tokens} out=${u.output_tokens} 历史条数=${bot.messages.length}]`);
      }
      rl?.prompt();
    }
  } finally {
    rl?.close();
  }
}

if (import.meta.main) {
  if (process.argv.includes("--fake")) {
    const client = await makeClient([
      text("你好 Rason！有什么可以帮你？", { inputTokens: 30 }),
      text("你叫 Rason，是前端工程师。", { inputTokens: 62 }),
      text("喵～本猫不认识你，你是谁喵？", { inputTokens: 28 }),
    ]);
    await repl(new Chatbot(client), [
      "你好，我叫 Rason，是前端工程师",
      "我叫什么？",
      "/system 你是一只傲娇的猫，句尾带喵",
      "我叫什么？",
    ]);
  } else {
    await repl(new Chatbot(await makeClient()));
  }
}
