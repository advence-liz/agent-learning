/**
 * Read：cat -n 风格读文本文件，读完登记文件状态。（第 1 章朴素版，第 7 章加行号 / offset / limit，第 19 章读图片）
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { ImageError, isImagePath, loadImage, sniff } from "../images.ts";
import { type Args, Tool, type ToolContext, ToolResult } from "./base.ts";
import { readText, splitLines } from "./file_state.ts";

export const MAX_LINES = 2000;
export const MAX_LINE_CHARS = 2000;

/** cat -n 风格：右对齐 6 位行号 + 制表符。模型据此定位，但编辑时绝不能把行号抄进 old_string。 */
export function numberLines(lines: string[], start: number): string {
  return lines.map((ln, i) => `${String(i + start).padStart(6)}\t${ln}`).join("\n");
}

export class ReadTool extends Tool {
  override name = "Read";
  override readOnly = true;
  override kind = "read";
  override description =
    "Read a text file. Output is numbered like `cat -n` (line number, a tab, then the line). " +
    `Reads up to ${MAX_LINES} lines; use offset/limit for large files. ` +
    "You must Read a file before you Edit or overwrite it.";
  override inputSchema = {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute or project-relative path" },
      offset: { type: "integer", description: "1-based line to start from" },
      limit: { type: "integer", description: "Number of lines to read" },
    },
    required: ["file_path"],
    additionalProperties: false,
  };

  override run(args: Args, ctx: ToolContext): ToolResult {
    const path = ctx.resolve(args.file_path);
    if (existsSync(path) && statSync(path).isDirectory()) {
      return new ToolResult(`${ctx.rel(path)} is a directory. Use Bash \`ls\` to list it.`, true);
    }
    const raw = readFileSync(path); // 不存在就抛 ENOENT，由 registry 变成 is_error 结果
    if (isImagePath(path) || sniff(raw.subarray(0, 16))) {
      // 第 19 章：图片作为 image 块放进 tool_result（content 是块列表）
      try {
        const [block, meta] = loadImage(path);
        return new ToolResult([{ type: "text", text: `Image: ${ctx.rel(path)} (${meta.note()})` }, block]);
      } catch (e) {
        if (e instanceof ImageError) return new ToolResult(e.message, true);
        throw e;
      }
    }
    if (raw.subarray(0, 8000).includes(0)) {
      return new ToolResult(`${ctx.rel(path)} looks like a binary file; not reading it.`, true);
    }
    const text = readText(path);
    const lines = splitLines(text);
    const offset = Math.max(args.offset ?? 1, 1);
    const limit: number = args.limit ?? MAX_LINES;
    const chunk = lines.slice(offset - 1, offset - 1 + limit);
    const partial = offset > 1 || offset - 1 + limit < lines.length;
    ctx.fileState.remember(path, text, partial);
    if (lines.length === 0) return new ToolResult("(file is empty)");
    let body = numberLines(chunk.map((ln) => ln.slice(0, MAX_LINE_CHARS)), offset);
    if (partial) body += `\n\n[showing lines ${offset}-${offset + chunk.length - 1} of ${lines.length}]`;
    return new ToolResult(body);
  }
}
