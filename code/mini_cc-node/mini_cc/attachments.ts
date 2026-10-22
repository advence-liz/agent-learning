/**
 * 附件：客户端主动塞进上下文的东西（@ 文件、环境信息、提醒……）。（第 8 章；第 19 章加图片块）
 *
 * 统一渲染成 <system-reminder> 包裹的文本块，追加在 user 消息里。第 8 章用于 @ 文件，第 9 章推广到所有注入。
 */

import type { Block } from "./model.ts";

export class Attachment {
  kind: string; // file | directory | env | instructions | reminder | image | ...
  title: string; // 给人看的一行，比如 "@config.py（5 行）"
  text: string; // 给模型看的正文
  blocks: Block[]; // 第 19 章：紧跟在说明后面的非文本块（图片）

  constructor(kind: string, title: string, text: string, blocks: Block[] = []) {
    this.kind = kind;
    this.title = title;
    this.text = text;
    this.blocks = blocks;
  }
}

export function render(att: Attachment): Block {
  return { type: "text", text: `<system-reminder>\n${att.text}\n</system-reminder>` };
}

export function isReminder(block: Block): boolean {
  return block.type === "text" && String(block.text ?? "").startsWith("<system-reminder>");
}
