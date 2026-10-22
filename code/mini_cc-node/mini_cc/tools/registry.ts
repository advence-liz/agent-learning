/**
 * 工具注册表：模型只认识 schema 列表，循环只认识 execute()。（第 1、3、5 章）
 */

import { type Args, type Tool, type ToolContext, ToolResult } from "./base.ts";
import { validate } from "./validate.ts";

export function toolError(msg: string): ToolResult {
  // 和 Claude Code 一样用 <tool_use_error> 包起来，模型一眼能区分「工具报错」和「命令输出里恰好有 error 字样」
  return new ToolResult(`<tool_use_error>${msg}</tool_use_error>`, true);
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const t of tools) this.register(t);
  }

  /** 运行时注册（第 15 章 MCP、第 17 章 sub agent 都走这里），下一次请求就带上新 schema。 */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  schemas(): Array<Record<string, any>> {
    // 顺序稳定（注册顺序）——工具列表在 prompt 最前面，顺序一变 prompt cache 就全废
    return [...this.tools.values()].map((t) => t.schema());
  }

  /** 防线 1：工具存在、参数合法。返回 null 表示通过。（权限判定要在这之后做，否则会拿着坏参数做判断） */
  checkInput(name: string, args: unknown): ToolResult | null {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return toolError(`Error: No such tool available: ${name}. Available: ${this.names().join(", ")}`);
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return toolError(`InputValidationError: ${name} input must be an object, got ${Array.isArray(args) ? "array" : typeof args}`);
    }
    const errors = validate(args, tool.inputSchema);
    if (errors.length) {
      return toolError(`InputValidationError: ${name} failed due to the following issues:\n` + errors.join("\n"));
    }
    return null;
  }

  /** 两道防线：执行前校验参数；执行时任何异常都变成 isError 的工具结果，绝不往外抛。 */
  async execute(name: string, args: Args, ctx: ToolContext, maxOutput = 30000): Promise<ToolResult> {
    const bad = this.checkInput(name, args);
    if (bad !== null) return bad;
    const tool = this.tools.get(name)!;
    // 防线 2：执行期异常（同步抛的、异步 reject 的都在这里接住）
    let result: ToolResult;
    try {
      result = await tool.run(args, ctx);
    } catch (e) {
      const err = e as Error;
      return toolError(`${err?.name ?? "Error"}: ${err?.message ?? String(e)}`);
    }
    return truncate(result, maxOutput);
  }
}

export function truncate(result: ToolResult, limit: number): ToolResult {
  if (typeof result.content === "string" && result.content.length > limit) {
    const head = result.content.slice(0, limit);
    const dropped = result.content.length - limit;
    return new ToolResult(`${head}\n\n[output truncated: ${dropped} more chars]`, result.isError);
  }
  return result;
}
