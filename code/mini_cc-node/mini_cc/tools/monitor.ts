/**
 * Monitor 工具（第 18 章）：启动一个长期运行的命令，它的每一行 stdout 都作为事件推给模型。
 */

import type { JobManager } from "../jobs.ts";
import { type Args, Tool, type ToolContext, ToolResult } from "./base.ts";
import { BashTool } from "./bash.ts";

const MAX_TIMEOUT_MS = 1_800_000; // 30 分钟（和 Claude Code 的 Monitor 一样封顶）
const DEFAULT_TIMEOUT_MS = 300_000;

export class MonitorTool extends Tool {
  override name = "Monitor";
  override kind = "exec";
  override description =
    "Start a background monitor: run a long-lived command whose stdout lines are events. Each line (lines " +
    "within 200ms are batched) arrives as a notification while you keep working.\n" +
    "Use it for 'tell me EVERY time X happens' (tail -F log | grep --line-buffered ERROR, a poll loop that " +
    "prints one line per change). For 'tell me when X is done' (one notification), use Bash with " +
    "run_in_background instead.\n" +
    "Rules: every pipe stage must flush per line (grep --line-buffered); filter to the lines you would act " +
    "on, including failure signatures, not only good news; stderr is not an event. Monitors expire after " +
    "timeout_ms (default 5 min, max 30 min) and are stopped automatically if they flood. Stop early with " +
    "TaskStop. Events are not replies from the user.";
  override inputSchema = {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command; each stdout line is an event" },
      description: { type: "string", description: "Specific, shown in every notification" },
      timeout_ms: { type: "integer", description: "Default 300000, capped at 1800000" },
    },
    required: ["command", "description"],
    additionalProperties: false,
  };

  // 权限和 Bash 一样按命令判断：tail | grep 这种只读命令免审批，其余要问
  override selfCheck(args: Args): "allow" | "ask" | null {
    return BashTool.prototype.selfCheck.call(this, args);
  }

  override ruleKey(args: Args): string {
    return `Monitor(${args.command ?? ""})`;
  }

  override summary(args: Args): string {
    return `Monitor(${args.description || args.command || ""})`;
  }

  override run(args: Args, ctx: ToolContext): ToolResult {
    const jobs: JobManager | undefined = ctx.extras.jobs;
    if (!jobs) return new ToolResult("Monitors are not available here.", true);
    const ms = Math.min(Math.trunc(args.timeout_ms || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
    const job = jobs.startMonitor(args.command, ctx.cwd, args.description, ms / 1000, ctx.toolUseId);
    return new ToolResult(
      `Monitor started (task ${job.id}, expires in ${ms / 60000}m unless the source ends first; ` +
      "you get one notice at expiry, re-arm if you still need the watch). You will be notified on each event. " +
      "Keep working, do not poll or sleep. Events may arrive while you are waiting for the user: " +
      "an event is not their reply.");
  }
}
