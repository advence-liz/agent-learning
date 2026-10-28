/**
 * TaskStop：停掉一个后台任务（第 16 章：bash；第 17 章：sub agent；第 18 章：monitor）。
 */

import type { JobManager } from "../jobs.ts";
import { type Args, Tool, type ToolContext, ToolResult } from "./base.ts";

export class TaskStopTool extends Tool {
  override name = "TaskStop";
  override kind = "tasks";
  override description = "Stop a running background task (background command, sub agent or monitor) by its task id.";
  override inputSchema = {
    type: "object",
    properties: { task_id: { type: "string", description: "e.g. b1" } },
    required: ["task_id"],
    additionalProperties: false,
  };

  override selfCheck(_args: Args): "allow" {
    return "allow"; // 只停 agent 自己启动的任务
  }

  override summary(args: Args): string {
    return `TaskStop(${args.task_id})`;
  }

  override async run(args: Args, ctx: ToolContext): Promise<ToolResult> {
    const jobs: JobManager | undefined = ctx.extras.jobs;
    const job = jobs?.get(args.task_id);
    if (job === undefined) {
      return new ToolResult(`No task ${args.task_id}. Running: ` +
        `${jobs ? jobs.running().map((j) => j.id).join(", ") : "none"}`, true);
    }
    if (job.status !== "running") return new ToolResult(`Task ${job.id} is not running (status: ${job.status}).`, true);
    await jobs!.stop(job.id);
    return new ToolResult(`Stopped task ${job.id} (${job.description}).`);
  }
}
