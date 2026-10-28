/**
 * 上下文压缩（第 14 章）。
 *
 * 做法是 claude-api 文档推荐的「简单压缩」（simple compaction）：
 * 1. 用**同一个** system、同一套工具、完整历史，再追加一条「请写摘要」的指令，请求模型一次（前缀能命中 prompt cache）；
 * 2. 新历史只有一条 user 消息：摘要 + 程序重新挂回的东西（最近读过的文件、项目说明、任务清单……）；
 * 3. 旧的 thinking 块、旧的轮次一律不带过去——它们绑定在旧对话上，带过去反而会让 API 拒绝（preserved thinking）。
 *
 * 手动 /compact 发生在两轮之间：之后用户的下一条消息会紧跟在摘要后面。API 要求 user/assistant 交替，
 * 所以 Agent.request() 发请求前把相邻的 user 消息合并（mergeConsecutiveUsers）。合并是历史的确定性函数，
 * 每次请求得到的前缀逐字节相同，不破坏 prompt cache。
 */

import { existsSync, statSync } from "node:fs";
import { Attachment, render } from "./attachments.ts";
import { type Event, notice } from "./events.ts";
import type { Agent } from "./loop.ts";
import { fileAttachment } from "./mentions.ts";
import { type Block, complete, type Message, ModelError } from "./model.ts";

export const SUMMARY_HEADER = "This session is being continued from a previous conversation that ran out of context. " +
  "The summary below covers the earlier portion of the conversation.";
export const CONTINUE = "Continue from where you left off without asking the user further questions. " +
  "Do not acknowledge or recap the summary; pick up the last task directly.";
export const SUMMARY_PROMPT = `Your context window is almost full. Write a summary of the conversation so far that lets a fresh
context window continue the work without redoing anything or asking the user again. Use these sections:

1. User requests: every request, constraint and preference the user stated, kept close to their own words.
2. Decisions: what was decided, ruled out or agreed, and why.
3. Files and code: files read or changed, with the key snippets or line references that matter.
4. Problems: errors hit and how they were fixed (or that they are still open).
5. Current state: exactly what has been done and what was in progress at the moment of this summary.
6. Next step: the immediate next action, if the task is not finished.

Keep exact names, paths, numbers and error messages. Condense your own explanations; never drop the user's words.
Put the whole summary inside <summary></summary> tags.
Do not call any tools while writing this summary; respond with text only.`;

export const REATTACH_FILES = 5; // 压缩后重新挂回最近读过的几个文件（Claude Code 文档：最多 5 个）
export const REATTACH_LINES = 400; // 每个文件最多挂回多少行

export function extractSummary(text: string): string {
  const m = /<summary>([\s\S]*?)<\/summary>/.exec(text);
  return (m ? m[1] : text).trim();
}

function blocks(content: string | Block[]): Block[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
}

/** 请求视图：相邻的 user 消息合并成一条（不修改传入的历史）。 */
export function mergeConsecutiveUsers(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    const prev = out.at(-1);
    if (prev && m.role === "user" && prev.role === "user") {
      out[out.length - 1] = { role: "user", content: [...blocks(prev.content), ...blocks(m.content)] };
    } else {
      out.push(m);
    }
  }
  return out;
}

/**
 * 粗估（4 字符 ≈ 1 token）。只用于压缩后更新 lastInput，避免下一次请求前又被判定为「快满了」。
 * JSON.stringify 不带空格，比 Python 版 json.dumps 的结果短一点，估出来的数也略小。
 */
export function estimateTokens(obj: unknown): number {
  return Math.floor(JSON.stringify(obj).length / 4);
}

/** 最近读过的文件重新放进上下文，文件状态表也只保留这几个：压缩后模型看不见的文件，就当没读过。 */
function reattachFiles(agent: Agent): Block[] {
  const fs = agent.ctx.fileState;
  const recent = fs.paths().filter((p) => existsSync(p) && statSync(p).isFile()).slice(-REATTACH_FILES);
  fs.clear();
  return recent.map((p) => {
    const att = fileAttachment(p, agent.ctx.rel(p), agent.ctx, REATTACH_LINES);
    att.text = att.text.replace("The user mentioned", "Re-attached after compaction:");
    return render(att);
  });
}

export const REATTACH_SKILL_CHARS = 20_000; // 每个 skill 正文最多挂回这么多字符（Claude Code 文档：每个 5000 token）

/** 第 20 章：本会话调用过的 skill 正文不交给摘要，原样挂回（只保留开头部分，所以要点要写在最前面）。 */
function reattachSkills(agent: Agent): Block[] {
  const rt = agent.ctx.extras.skills as { invoked: Map<string, string> } | undefined;
  if (rt === undefined) return [];
  return [...rt.invoked].map(([name, body]) => render(new Attachment("skill", name,
    `Re-attached skill after compaction: ${name}\n\n${body.slice(0, REATTACH_SKILL_CHARS)}`)));
}

/** 压缩当前历史。异步生成器：产出给 UI 的事件；失败时历史保持不变。 */
export async function* compact(agent: Agent, trigger: "manual" | "auto" = "manual", instructions = ""): AsyncGenerator<Event> {
  const pre = agent.usage.lastInput || estimateTokens(agent.messages);
  const ask = SUMMARY_PROMPT + (instructions ? `\n\nAdditional instructions from the user for this summary:\n${instructions}` : "");
  const req = agent.request();
  let history = mergeConsecutiveUsers(agent.messages);
  const last = history.at(-1);
  if (last && last.role === "user") {
    // 自动压缩发生在工具结果之后：指令并进最后一条 user 消息，保持交替（只改请求副本）
    history = [...history.slice(0, -1), { role: "user", content: [...blocks(last.content), { type: "text", text: ask }] }];
  } else {
    history = [...history, { role: "user", content: [{ type: "text", text: ask }] }];
  }
  req.messages = history;
  yield notice(`${trigger === "auto" ? "自动" : ""}压缩上下文中（当前约 ${pre} tokens）…`);
  let done;
  try {
    done = await complete(agent.client, req);
  } catch (e) {
    if (!(e instanceof ModelError)) throw e;
    yield notice(`压缩失败：${e.message}；历史保持不变`, "warn");
    return;
  }
  agent.usage.add(done.usage);
  const summary = extractSummary(done.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""));
  if (!summary) {
    yield notice("压缩失败：模型没有给出摘要；历史保持不变", "warn");
    return;
  }

  const text = `${SUMMARY_HEADER}\n\n${summary}` + (trigger === "auto" ? `\n\n${CONTINUE}` : "");
  const content: Block[] = [{ type: "text", text }, ...reattachFiles(agent), ...reattachSkills(agent)];
  agent.loadHistory([], agent.usage);
  // 用 "user" 触发 providers：历史空了，项目说明 / 日期 / 任务清单会自动重新注入
  const [merged, atts] = await agent.context.inject(content, "user");
  for (const a of atts) yield { type: "ContextInjected", kind: a.kind, title: a.title };
  const msg: Message = { role: "user", content: merged };
  const post = estimateTokens(msg);
  agent.append(msg, { compact: { trigger, preTokens: pre, postTokens: post } });
  agent.usage.lastInput = post;
  yield notice(`已压缩：${pre} → 约 ${post} tokens（摘要 ${summary.length} 字符，挂回 ${content.length - 1} 个文件 / skill）`);
}

/** 挂在 Agent.beforeRequest：上一次请求的输入已经逼近窗口，就先压缩再请求。 */
export async function autoCompactHook(agent: Agent): Promise<Event[]> {
  const s = agent.settings;
  if (!s.autoCompact || agent.usage.lastInput < s.contextWindow - s.autoCompactBuffer) return [];
  if (!agent.messages.length || agent.messages.at(-1)!.role !== "user") {
    return []; // 只在「即将请求」的位置压缩；悬空的 tool_use 不能拆开
  }
  const evs: Event[] = [];
  for await (const ev of compact(agent, "auto")) evs.push(ev);
  return evs;
}
