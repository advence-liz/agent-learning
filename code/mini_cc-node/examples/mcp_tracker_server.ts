/**
 * 第 15 章演示用的 stdio MCP server：一个假的 issue tracker（数据在内存里，不联网）。
 *
 *     node examples/mcp_tracker_server.ts      # 一般不直接跑，由 mini-cc 按 .mcp.json 拉起
 *
 * 用 @modelcontextprotocol/sdk 的 McpServer + zod（Python 版是 mcp 2.x 的 MCPServer）。stdout 是协议通道，日志只能写 stderr。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ISSUES: Record<string, { title: string; status: string; comments: string[] }> = {
  "BUG-101": { title: "list_posts 没有分页，首页一次返回 5000 条", status: "Todo", comments: [] },
  "BUG-102": { title: "登录页在 Safari 上按钮错位", status: "In Progress", comments: [] },
};

export const mcp = new McpServer(
  { name: "tracker", version: "0.1.0" },
  {
    instructions: "Issue tracker for this project. Use list_issues to find an issue id, get_issue for details, " +
      "and add_comment only when the user asks you to report back.",
  },
);

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

mcp.registerTool(
  "list_issues",
  {
    description: 'List issues as `ID [status] title` lines. Optional status filter, e.g. "Todo".',
    inputSchema: { status: z.string().default("") },
    annotations: { readOnlyHint: true },
  },
  ({ status }) => {
    const rows = Object.entries(ISSUES).filter(([, v]) => !status || v.status === status)
      .map(([k, v]) => `${k} [${v.status}] ${v.title}`);
    console.error(`[tracker] list_issues ${JSON.stringify(status)} -> ${rows.length}`); // 日志走 stderr
    return text(rows.join("\n") || "(no issues)");
  },
);

mcp.registerTool(
  "get_issue",
  {
    description: "Get one issue with its comments.",
    inputSchema: { issue_id: z.string() },
    annotations: { readOnlyHint: true },
  },
  ({ issue_id }) => {
    const v = ISSUES[issue_id];
    // McpServer 会把异常的 message 包成 isError 结果回给模型（Python 版要抛 ToolError）
    if (!v) throw new Error(`No issue ${issue_id}. Use list_issues to see ids.`);
    const comments = v.comments.map((c) => `- ${c}`).join("\n") || "(no comments)";
    return text(`${issue_id}: ${v.title}\nstatus: ${v.status}\ncomments:\n${comments}`);
  },
);

mcp.registerTool(
  "add_comment",
  {
    description: "Add a comment to an issue (visible to the whole team).",
    inputSchema: { issue_id: z.string(), body: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ({ issue_id, body }) => {
    const v = ISSUES[issue_id];
    if (!v) throw new Error(`No issue ${issue_id}.`);
    v.comments.push(body);
    return text(`Comment added to ${issue_id} (${v.comments.length} total).`);
  },
);

if (import.meta.main) {
  await mcp.connect(new StdioServerTransport()); // 对应 Python 的 mcp.run()（默认 stdio）
}
