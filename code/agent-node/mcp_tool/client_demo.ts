/**
 * 用官方 @modelcontextprotocol/sdk 客户端拉起 notes_server（真实 stdio 子进程），列工具、调工具。
 *
 * node mcp_tool/client_demo.ts
 */

import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

export const SERVER = join(import.meta.dirname, "notes_server.ts");

/** 拉起 server 子进程并完成握手（connect 里自动发 initialize + notifications/initialized）。 */
export async function connect(): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] });
  const client = new Client({ name: "client-demo", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

async function main(): Promise<void> {
  const session = await connect();
  try {
    const info = session.getServerVersion()!;
    // Node 客户端不暴露协商结果；它请求的是 LATEST_PROTOCOL_VERSION，server 支持就原样回这个版本
    console.log(`已连接：${info.name} ${info.version}，协议 ${LATEST_PROTOCOL_VERSION}`);
    const tools = await session.listTools();
    for (const t of tools.tools) {
      console.log(`- ${t.name}: ${t.description!.slice(0, 30)}…  参数=${JSON.stringify(Object.keys(t.inputSchema.properties ?? {}))}`);
    }
    let r = await session.callTool({ name: "search_notes", arguments: { query: "nginx" } });
    console.log("search_notes(nginx) →", JSON.stringify(r.structuredContent));
    r = await session.callTool({ name: "read_note", arguments: { path: "../../../etc/passwd" } });
    console.log("read_note(越界) → isError =", r.isError, "|", (r.content as any[])[0].text);
  } finally {
    await session.close();
  }
}

if (import.meta.main) {
  await main();
}
