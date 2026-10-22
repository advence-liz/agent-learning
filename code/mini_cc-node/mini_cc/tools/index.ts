/**
 * 工具包入口（对应 Python 的 tools/__init__.py）：默认工具列表 + 常用类型的再导出。
 */

import { AskUserQuestionTool } from "./ask_user.ts";
import { type Tool } from "./base.ts";
import { BashTool } from "./bash.ts";
import { EditTool } from "./edit.ts";
import { MemoryTool } from "./memory_tool.ts";
import { MonitorTool } from "./monitor.ts";
import { ReadTool } from "./read.ts";
import { TaskStopTool } from "./task_stop.ts";
import { TaskCreateTool, TaskListTool, TaskUpdateTool } from "./task_tools.ts";
import { WriteTool } from "./write.ts";

export { Tool, ToolContext, ToolResult } from "./base.ts";
export { ToolRegistry } from "./registry.ts";

export function defaultTools(): Tool[] {
  // 顺序 = 发给模型的 tools 顺序，后续章节追加在末尾不破坏已有前缀（第 16 章 TaskStop，第 18 章 Monitor）
  return [new ReadTool(), new WriteTool(), new EditTool(), new BashTool(), new AskUserQuestionTool(),
    new TaskCreateTool(), new TaskUpdateTool(), new TaskListTool(), new MemoryTool(),
    new TaskStopTool(), new MonitorTool()];
}
