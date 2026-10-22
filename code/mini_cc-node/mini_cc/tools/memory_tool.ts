/**
 * Memory 工具：模型保存 / 更新 / 删除一条长期记忆。（第 12 章）
 */

import { basename } from "node:path";
import { type MemoryStore, slugify, TYPES } from "../memory.ts";
import { type Args, Tool, type ToolContext, ToolResult } from "./base.ts";

export class MemoryTool extends Tool {
  override name = "Memory";
  override kind = "memory";
  override description =
    "Save, update or delete a persistent memory for this project (see the # Memory section of the system " +
    "prompt for what is worth remembering). action=save writes a topic file and its one-line entry in " +
    "MEMORY.md; saving with an existing slug updates that memory. action=delete removes it.";
  override inputSchema = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["save", "delete"] },
      type: { type: "string", enum: [...TYPES] },
      name: { type: "string", description: "Short title, e.g. 'Commit message prefixes'" },
      description: { type: "string", description: "One line for the index: when is this relevant?" },
      body: { type: "string", description: "The memory itself. For feedback, add **Why:** and **How to apply:**" },
      slug: { type: "string", description: "Existing slug to update or delete (file name without .md)" },
    },
    required: ["action"],
    additionalProperties: false,
  };

  override selfCheck(_args: Args): "allow" {
    // 不是只读，但只写 agent 自己的记忆目录、不碰项目文件：和任务清单一样免审批
    return "allow";
  }

  override summary(args: Args): string {
    return `Memory(${args.action} ${args.slug || (args.name ?? "")})`;
  }

  override run(args: Args, ctx: ToolContext): ToolResult {
    const store: MemoryStore | undefined = ctx.extras.memory;
    if (store === undefined) return new ToolResult("Memory is not available in this session.", true);
    if (args.action === "delete") {
      const slug: string = args.slug || slugify(args.name ?? "");
      if (!store.delete(slug)) {
        return new ToolResult(`No memory with slug '${slug}'. Check the MEMORY.md index for slugs.`, true);
      }
      return new ToolResult(`Deleted memory ${slug}.`);
    }
    const missing = ["type", "name", "description", "body"].filter((k) => !args[k]);
    if (missing.length) return new ToolResult(`action=save needs: ${missing.join(", ")}`, true);
    const [path, note] = store.save(args.type, args.name, args.description, args.body, args.slug);
    return new ToolResult(`Saved memory ${basename(path, ".md")} to ${path}. Its index line is in MEMORY.md and will be ` +
      `loaded into future sessions (you already know it in this one).${note}`);
  }
}
