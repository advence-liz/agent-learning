/**
 * 第 10 章：一个查本地 markdown 笔记的 stdio MCP server（@modelcontextprotocol/sdk 的 McpServer + zod）。
 *
 *     NOTES_DIR=~/notes node <本项目>/code/agent-node/mcp_tool/notes_server.ts
 *
 * stdio 传输：client 把本进程当子进程拉起，stdin 收 JSON-RPC，stdout 回 JSON-RPC。
 * 所以**绝对不能往 stdout 打日志（console.log）**——那会混进协议流，日志一律走 stderr（console.error）。
 * 示例笔记直接用 Python 版目录里的 code/agent/mcp_tool/sample_notes。
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const expandUser = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

export const NOTES_DIR = resolve(
  expandUser(process.env.NOTES_DIR ?? join(import.meta.dirname, "..", "..", "agent", "mcp_tool", "sample_notes")),
);

export const mcp = new McpServer(
  { name: "notes", version: "0.1.0" },
  { instructions: "查询用户本地的 markdown 笔记。先用 search_notes 找到文件，再用 read_note 读全文。" },
);

const Hit = z.object({ path: z.string(), line: z.number().int(), text: z.string() });
type Hit = z.infer<typeof Hit>;

mcp.registerTool(
  "search_notes",
  {
    description:
      "在笔记里按关键词搜索（大小写不敏感，空格分隔的多个词需同时出现在一行）。返回命中的文件、行号和该行内容。",
    inputSchema: { query: z.string(), limit: z.number().int().default(5) },
    // Python 版返回 list[Hit]，SDK 自动包成 {"result": [...]}；Node 版的 outputSchema 必须是对象，手动包同样一层
    outputSchema: { result: z.array(Hit) },
  },
  ({ query, limit }) => {
    const words = query.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
    const hits: Hit[] = [];
    const files = readdirSync(NOTES_DIR, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".md")).sort();
    for (const f of files) {
      const lines = readFileSync(join(NOTES_DIR, f), "utf8").split(/\r?\n/);
      for (const [i, line] of lines.entries()) {
        if (words.every((w) => line.toLowerCase().includes(w))) {
          hits.push({ path: f, line: i + 1, text: line.trim() });
          if (hits.length >= limit) break;
        }
      }
    }
    console.error(`[notes] search ${JSON.stringify(query)} → ${hits.length} hits`); // 日志走 stderr
    const result = hits.slice(0, limit);
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { result } };
  },
);

mcp.registerTool(
  "read_note",
  {
    description: "读取一篇笔记的全文。path 是 search_notes 返回的相对路径。",
    inputSchema: { path: z.string() },
  },
  ({ path }) => {
    const p = resolve(NOTES_DIR, path);
    const rel = relative(NOTES_DIR, p);
    if (rel.startsWith("..") || isAbsolute(rel) || extname(p) !== ".md") {
      // Node 版 McpServer 会把任何异常的 message 原样包成 isError 结果回给模型（Python 版只有 ToolError 才这样）
      throw new Error(`只能读取笔记目录下的 .md 文件：${path}`);
    }
    return { content: [{ type: "text", text: readFileSync(p, "utf8") }] };
  },
);

if (import.meta.main) {
  await mcp.connect(new StdioServerTransport()); // 对应 Python 的 mcp.run()（默认 stdio）
}
