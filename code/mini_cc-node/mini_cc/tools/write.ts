/**
 * Write：新建或整体覆盖文件。已存在的文件必须先读且读后未变。（第 1 章朴素版，第 7 章加 guardWrite）
 */

import { existsSync } from "node:fs";
import { type Args, Tool, type ToolContext, ToolResult } from "./base.ts";
import { guardWrite, splitLines, writeText } from "./file_state.ts";

export class WriteTool extends Tool {
  override name = "Write";
  override kind = "edit";
  override pathArg = "file_path";
  override description =
    "Create a new file or completely overwrite an existing one. " +
    "If the file exists you must Read it first. Prefer Edit for changing part of a file.";
  override inputSchema = {
    type: "object",
    properties: {
      file_path: { type: "string" },
      content: { type: "string" },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  };

  override run(args: Args, ctx: ToolContext): ToolResult {
    const path = ctx.resolve(args.file_path);
    const err = guardWrite(ctx.fileState, path);
    if (err) return new ToolResult(`<tool_use_error>${err}</tool_use_error>`, true);
    ctx.beforeWrite(path);
    const existed = existsSync(path);
    writeText(path, args.content);
    ctx.fileState.remember(path, args.content); // 自己写的内容 = 已知最新状态，接着 Edit 不用重读
    const verb = existed ? "Overwrote" : "Created";
    return new ToolResult(`${verb} ${ctx.rel(path)} (${splitLines(args.content).length} lines)`);
  }
}
