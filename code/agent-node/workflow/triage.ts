/**
 * 第 5 章：同一个任务的两种写法——Workflow（代码决定控制流） vs Agent（模型决定控制流）。
 *
 * 任务：把一条用户反馈分诊：bug → 整理成工单草稿；咨询 → 查资料回答；其它 → 礼貌回复。
 *
 * 离线演示： node workflow/triage.ts
 */

import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "../coding_agent/agent.ts"; // 直接复用第 2 章的 agent 循环，只换工具
import { FakeAnthropic, text, toolUse, type LLMClient, type Message } from "../fake_llm/index.ts";
import { Index } from "../rag/rag.ts";

export const MODEL = "claude-opus-5-5";

const textOf = (resp: Message): string => resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");

// ---------------------------------------------------------------- Workflow
const CLASSIFY = '把用户反馈分类，只输出 JSON：{"label": "bug" | "question" | "other"}';
const BUG = "把 bug 反馈整理成工单草稿，必须包含「复现步骤」「期望」「实际」三个小节。";

export async function workflow(client: LLMClient, index: Index, feedback: string, trace: string[]): Promise<string> {
  // 步骤 1：分类（一次 LLM 调用，输出被代码解析）
  let resp = await client.messages.create({
    model: MODEL, max_tokens: 256, system: CLASSIFY, messages: [{ role: "user", content: feedback }],
  });
  const label: string = JSON.parse(textOf(resp)).label;
  trace.push(`classify → ${label}`);

  // 步骤 2：路由——if/else 写在代码里，模型无权改变
  if (label === "bug") {
    resp = await client.messages.create({
      model: MODEL, max_tokens: 2048, system: BUG, messages: [{ role: "user", content: feedback }],
    });
    let draft = textOf(resp);
    // 步骤 3：闸门（gate）——用代码校验，不合格就重试一次
    if (!["复现步骤", "期望", "实际"].every((k) => draft.includes(k))) {
      trace.push("gate ✗ → retry");
      resp = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: BUG,
        messages: [
          { role: "user", content: feedback },
          { role: "assistant", content: draft },
          { role: "user", content: "缺少必需小节，请按格式重写。" },
        ],
      });
      draft = textOf(resp);
    }
    trace.push("gate ✓");
    return draft;
  }
  if (label === "question") {
    const hits = index.search(feedback, 2);
    trace.push(`retrieve → ${JSON.stringify(hits.map(([, c]) => c.source))}`);
    const docs = hits.map(([, c]) => c.text).join("\n");
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: "只根据资料回答。",
      messages: [{ role: "user", content: `资料：\n${docs}\n\n问题：${feedback}` }],
    });
    return textOf(resp);
  }
  return "感谢反馈，我们已记录。";
}

// ---------------------------------------------------------------- Agent
export async function agent(client: LLMClient, index: Index, feedback: string, trace: string[]): Promise<string> {
  const tickets: string[] = [];

  const searchDocs = ({ query }: { query: string }) => index.search(query, 2).map(([, c]) => c.text).join("\n");

  const createTicket = ({ title }: { title: string; body: string }) => {
    tickets.push(title);
    return `已创建工单 #${100 + tickets.length}：${title}`;
  };

  const tools = { search_docs: searchDocs, create_ticket: createTicket };
  return runAgent(client, `处理这条用户反馈：${feedback}`, ".", { // cwd 用不上：工具全换掉了
    tools,
    toolSpecs: AGENT_TOOLS,
    system: AGENT_SYSTEM,
    log: (s) => trace.push(s),
  });
}

const AGENT_SYSTEM = "你是客服分诊 Agent。自己判断反馈类型：咨询就查资料回答，bug 就建工单，可以两件事都做。";
const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_docs",
    description: "在产品帮助文档里检索，返回最相关的两段。",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "create_ticket",
    description: "创建一张 bug 工单。body 需包含复现步骤、期望、实际。",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" } },
      required: ["title", "body"],
    },
  },
];

// ---------------------------------------------------------------- demo
export const FEEDBACK = "我是 Pro 会员，导出时一直转圈，到底 Pro 能导出几次？";

if (import.meta.main) {
  const index = Index.fromDir();

  console.log("=== Workflow：代码写死 classify → route → gate ===");
  const wfClient = new FakeAnthropic([
    text('{"label": "bug"}', { inputTokens: 40, outputTokens: 8 }),
    text("## 现象\n导出一直转圈", { inputTokens: 60, outputTokens: 40 }), // 故意缺小节，触发 gate
    text("## 复现步骤\n1. 设置-数据管理-导出\n## 期望\n收到下载链接\n## 实际\n一直转圈"),
  ]);
  let trace: string[] = [];
  let out = await workflow(wfClient, index, FEEDBACK, trace);
  console.log("trace:", trace.join(" | "));
  console.log(`LLM 调用 ${wfClient.calls.length} 次；输出：${JSON.stringify(out)}`);

  console.log("\n=== Agent：模型自己决定先查资料、再建工单 ===");
  const agClient = new FakeAnthropic([
    toolUse("search_docs", { query: "Pro 导出次数" }, { say: "先确认导出规则。" }),
    toolUse("create_ticket", { title: "Pro 用户导出卡在转圈", body: "复现步骤…期望…实际…" }),
    text("Pro 会员导出不限次数；转圈的问题已建工单 #101 跟进。"),
  ]);
  trace = [];
  out = await agent(agClient, index, FEEDBACK, trace);
  console.log("trace:\n  " + trace.join("\n  "));
  console.log(`LLM 调用 ${agClient.calls.length} 次；输出：${JSON.stringify(out)}`);
}
