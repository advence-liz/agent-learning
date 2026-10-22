/**
 * Edit：精确字符串替换。语义照 Claude Code 的 Edit 工具：（第 7 章）
 *
 * - old_string 必须在文件里**恰好出现一次**；出现多次要么给更多上下文，要么显式 replace_all=true
 * - old_string === new_string 拒绝（没有意义的编辑）
 * - 先读后改、读后未变（见 file_state.guardWrite）
 * - old_string 为空 + 文件不存在 = 新建文件
 * 失败时的报错要告诉模型「下一步该怎么做」，这比报错本身重要。
 */

import { existsSync } from "node:fs";
import { type Args, Tool, type ToolContext, ToolResult } from "./base.ts";
import { guardWrite, readText, splitLines, writeText } from "./file_state.ts";
import { numberLines } from "./read.ts";

const LINE_PREFIX = /^ *\d+\t/m; // Read 输出的「行号+tab」前缀
const straighten = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const count = (text: string, sub: string) => text.split(sub).length - 1; // 不重叠计数，同 str.count

function err(msg: string): ToolResult {
  return new ToolResult(`<tool_use_error>${msg}</tool_use_error>`, true);
}

/** 找不到 old_string 时，猜一猜模型是怎么抄错的，给出具体建议。 */
function diagnoseNotFound(text: string, old: string): string {
  const hints: string[] = [];
  if (LINE_PREFIX.test(old) && text.includes(old.replace(/^ *\d+\t/gm, ""))) {
    hints.push("old_string contains line-number prefixes copied from Read output (e.g. '    12\\t'). " +
      "Remove them; the line numbers are not part of the file.");
  } else if (straighten(text).includes(straighten(old))) {
    hints.push("The text matches only if curly quotes are replaced by straight quotes (or vice versa). " +
      "Copy the quotes exactly as they appear in the file.");
  } else if (old.trim() && text.includes(old.trim())) {
    hints.push("The text exists but leading/trailing whitespace or indentation differs. " +
      "Preserve the exact indentation (tabs vs spaces).");
  } else {
    hints.push("Re-read the file and copy the exact surrounding text.");
  }
  return `String to replace not found in file.\nString: ${old}\n(hint: ${hints.join(" ")})`;
}

function snippet(text: string, pos: number, replacement: string, ctxLines = 3): string {
  const lines = splitLines(text);
  const first = count(text.slice(0, pos), "\n");
  const last = first + count(replacement, "\n");
  const lo = Math.max(first - ctxLines, 0);
  const hi = Math.min(last + ctxLines + 1, lines.length);
  return numberLines(lines.slice(lo, hi), lo + 1);
}

export class EditTool extends Tool {
  override name = "Edit";
  override kind = "edit";
  override pathArg = "file_path";
  override description =
    "Replace an exact string in a file. Rules: (1) Read the file first. (2) old_string must match the file " +
    "exactly, including indentation, and must be unique; add surrounding lines to make it unique, or set " +
    "replace_all=true to change every occurrence. (3) Never include the line-number prefix from Read output. " +
    "(4) To create a new file, use an empty old_string.";
  override inputSchema = {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text (must differ from old_string)" },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  };

  override summary(args: Args): string {
    return `Edit(${args.file_path ?? ""})`;
  }

  override run(args: Args, ctx: ToolContext): ToolResult {
    const path = ctx.resolve(args.file_path);
    let old: string = args.old_string;
    let replacement: string = args.new_string;
    const replaceAll: boolean = args.replace_all ?? false;
    if (old === replacement) return err("No changes to make: old_string and new_string are exactly the same.");

    if (!existsSync(path)) {
      if (old === "") {
        ctx.beforeWrite(path);
        writeText(path, replacement);
        ctx.fileState.remember(path, replacement);
        return new ToolResult(`Created ${ctx.rel(path)}`);
      }
      return err(`File does not exist: ${ctx.rel(path)}`);
    }
    if (old === "") {
      return err("old_string is empty but the file already exists. Use Write to overwrite, " +
        "or give the exact text to replace.");
    }

    const guard = guardWrite(ctx.fileState, path);
    if (guard) return err(guard);

    const text = readText(path);
    if (!text.includes(old) && text.includes("\r\n") && !old.includes("\r\n")) {
      // 文件是 CRLF、模型给的是 LF：按文件的换行风格对齐
      old = old.replaceAll("\n", "\r\n");
      replacement = replacement.replaceAll("\n", "\r\n");
    }
    const n = count(text, old);
    if (n === 0) return err(diagnoseNotFound(text, old));
    if (n > 1 && !replaceAll) {
      return err(`Found ${n} matches of the string to replace, but replace_all is false. ` +
        "To replace all occurrences, set replace_all to true. To replace only one occurrence, " +
        `please provide more context to uniquely identify the instance.\nString: ${old}`);
    }

    const pos = text.indexOf(old);
    // 用 split/join 和 slice 拼接，不用 String.replace：替换文本里的 $& 之类不会被当成特殊模式
    const updated = replaceAll ? text.split(old).join(replacement) : text.slice(0, pos) + replacement + text.slice(pos + old.length);
    ctx.beforeWrite(path);
    writeText(path, updated);
    ctx.fileState.remember(path, updated);
    const k = replaceAll ? n : 1;
    return new ToolResult(`The file ${ctx.rel(path)} has been updated (${k} replacement${k > 1 ? "s" : ""}). ` +
      `Snippet:\n${snippet(updated, pos, replacement)}`);
  }
}
