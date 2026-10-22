/**
 * 终端渲染：把 agent 事件流画出来。（第 1、2、5、6、9、10、11、21 章）
 *
 * ConsoleUI 用 ANSI 转义实时打印（Python 版用 rich）；BufferUI 把同样的内容记成纯文本行，供测试使用。
 * 输出格式：❯ 用户输入 / ● 模型文本 / ✻ 思考 / ⏺ 工具调用 / ✔ 工具返回（✘ 表示出错）。
 */

import type { Event } from "./events.ts";
import type { PermissionReply, PermissionRequest } from "./permissions.ts";
import type { PlanChoice } from "./plan_mode.ts";
import { Answer, parseAnswer, type Question, renderQuestion } from "./tools/ask_user.ts";

export function preview(content: unknown, maxLines = 3, width = 100): string {
  if (Array.isArray(content)) {
    // content block 列表（MCP 结果、图片）：文本拼起来，其余显示占位
    content = content.map((b) => (b?.type === "text" ? b.text : `[${b?.type}]`)).join("\n");
  }
  const text = typeof content === "string" ? content : "[non-text content]";
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop(); // 和 str.splitlines() 一样，末尾换行不算一行
  const head = lines.slice(0, maxLines).map((ln) => ln.slice(0, width));
  const more = lines.length > maxLines ? `  …(+${lines.length - maxLines} lines)` : "";
  return head.join("\n  ") + more;
}

export class BufferUI {
  lines: string[] = [];
  protected streamKind: "text" | "thinking" | null = null; // 正在流式输出的块
  // 交互问题的预置答案（测试用）。用完之后默认回答 "1"
  answers: string[];

  constructor(answers: string[] = []) {
    this.answers = [...answers];
  }

  // ---- 交互输入：BufferUI 从 answers 里取，ConsoleUI 读键盘 / 管道
  async ask(prompt: string): Promise<string> {
    const ans = this.answers.length ? this.answers.shift()! : "1";
    this.emit(`${prompt}${ans}`);
    return ans;
  }

  async askPermission(req: PermissionRequest): Promise<PermissionReply> {
    this.info(`是否允许 ${req.summary}？（${req.reason}）`);
    this.emit("  1. 允许");
    this.emit(`  2. 允许，且本会话不再询问 ${req.ruleKey}`);
    this.emit("  3. 拒绝（可以附一句话告诉模型该怎么做）");
    const ans = (await this.ask("选择 [1/2/3]: ")).trim();
    if (ans.startsWith("2")) return { choice: "always", feedback: "" };
    if (ans.startsWith("3")) {
      const inline = ans.slice(1).replace(/^[:： ]+/, "").trim();
      const feedback = inline || (await this.ask("说明（可留空，回车跳过）: ")).trim();
      return { choice: "deny", feedback };
    }
    return { choice: "once", feedback: "" };
  }

  /** 第 21 章：ExitPlanMode 的审批界面。返回 [auto | manual | keep, 反馈]。 */
  async askPlanApproval(plan: string): Promise<[PlanChoice, string]> {
    this.info("─".repeat(20) + " 计划 " + "─".repeat(20));
    for (const line of plan.split("\n")) this.info(`  ${line}`);
    this.info("─".repeat(46));
    this.info("  1. 批准，之后的编辑自动通过（acceptEdits）");
    this.info("  2. 批准，每次编辑仍然逐个确认（default）");
    this.info("  3. 继续规划（可以附一句话说要改什么）");
    const ans = (await this.ask("选择 [1/2/3]: ")).trim();
    if (ans.startsWith("1")) return ["auto", ""];
    if (ans.startsWith("2")) return ["manual", ""];
    return ["keep", ans.startsWith("3") ? ans.slice(1).replace(/^[:： ]+/, "").trim() : ans];
  }

  /** AskUserQuestion 的界面：逐题显示选项，读答案；输入无效就重问一次，再无效当作跳过。 */
  async askQuestions(questions: Question[]): Promise<Answer[]> {
    const answers: Answer[] = [];
    for (const [i, q] of questions.entries()) {
      for (const line of renderQuestion(q, i + 1, questions.length)) this.info(line);
      let ans = parseAnswer(await this.ask("› "), q);
      if (ans === null) {
        this.info("  输入无效，请输入选项序号或你自己的答案");
        ans = parseAnswer(await this.ask("› "), q) ?? new Answer(q.question, [], true);
      }
      answers.push(ans);
    }
    return answers;
  }

  // ---- 基础输出
  protected emit(line: string): void {
    this.lines.push(line);
  }

  info(msg: string): void {
    this.endStream();
    this.emit(msg);
  }

  error(msg: string): void {
    this.endStream();
    this.emit(`✗ ${msg}`);
  }

  assistant(text: string): void {
    this.endStream();
    this.emit(`● ${text}`);
  }

  table(rows: Array<[string, string]>): void {
    this.endStream();
    const w = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) this.emit(`${k.padEnd(w)}  ${v}`);
  }

  // ---- 流式片段
  protected startStream(kind: "text" | "thinking", prefix: string): void {
    if (this.streamKind !== kind) {
      this.endStream();
      this.streamKind = kind;
      this.lines.push(prefix);
    }
  }

  protected write(piece: string): void {
    this.lines[this.lines.length - 1] += piece;
  }

  protected endStream(): void {
    this.streamKind = null;
  }

  // ---- 事件分发
  render(ev: Event): void {
    switch (ev.type) {
      case "TextDelta":
        this.startStream("text", "● ");
        this.write(ev.text);
        break;
      case "ThinkingDelta":
        this.startStream("thinking", "✻ ");
        this.write(ev.text);
        break;
      case "ToolStart":
        this.info(`⏺ ${ev.summary}`);
        break;
      case "ToolEnd":
        if ((ev.name === "TaskCreate" || ev.name === "TaskUpdate") && !ev.result.isError) {
          break; // 清单本身会由 TasksUpdated 画出来，结果行就不重复了
        }
        this.info(`${ev.result.isError ? "✘" : "✔"} ${ev.name} -> ${preview(ev.result.content)}`);
        break;
      case "TasksUpdated":
        for (const line of ev.rendered.split("\n")) this.info(`  ${line}`);
        break;
      case "ContextInjected":
        this.info(`◇ system  ${ev.title}`);
        break;
      case "PermissionDecision":
        if (ev.source === "classifier") {
          const verb = ev.behavior === "allow" ? "放行" : "拦截";
          this.info(`  ⎿ auto 审查员${verb}：${ev.reason.replace(/^auto reviewer blocked: /, "")}`);
        } else if (ev.behavior === "deny" && ev.source !== "user") {
          this.info(`  ⎿ 权限拒绝：${ev.reason}`);
        }
        break;
      case "Notice":
        (ev.level === "error" ? this.error : this.info).call(this, ev.text);
        break;
      case "TurnEnd":
        this.endStream();
        break;
    }
  }

  get text(): string {
    return this.lines.join("\n");
  }
}

// ANSI 样式（对应 Python 版 rich 的 style 名）；stdout 不是终端或设了 NO_COLOR 时不上色
const STYLES: Record<string, string> = { green: "32", dim: "2", red: "31", "bold red": "1;31", "dim italic": "2;3" };
const LINE_STYLE: Record<string, string> = { "⏺": "green", "✔": "dim", "✘": "red", "✗": "bold red" };

/** 读一行输入：显示 prompt、等用户（或管道）给一行，返回 null 表示输入结束（EOF）。由 cli.ts 的 REPL 提供。 */
export type LineSource = (prompt: string) => Promise<string | null>;

/** 同样的状态机，只是把每次 emit/write 立刻打到终端；交互问题从 lineSource 读。 */
export class ConsoleUI extends BufferUI {
  out: NodeJS.WriteStream;
  color: boolean;
  lineSource: LineSource | null = null;

  constructor(out: NodeJS.WriteStream = process.stdout) {
    super();
    this.out = out;
    this.color = Boolean(out.isTTY) && !process.env.NO_COLOR;
  }

  private paint(s: string, style: string | undefined): string {
    return this.color && style ? `\x1b[${STYLES[style]}m${s}\x1b[0m` : s;
  }

  override async ask(prompt: string): Promise<string> {
    this.endStream();
    // 没有 REPL 提供输入（比如 -p 且 stdin 已关闭）：当作空回答
    const line = this.lineSource ? await this.lineSource(prompt) : "";
    const ans = (line ?? "").replace(/\r?\n$/, "");
    this.lines.push(`${prompt}${ans}`);
    return ans;
  }

  protected override emit(line: string): void {
    super.emit(line);
    this.out.write(this.paint(line, LINE_STYLE[line.slice(0, 1)]) + "\n");
  }

  protected override startStream(kind: "text" | "thinking", prefix: string): void {
    if (this.streamKind !== kind) {
      super.startStream(kind, prefix);
      this.out.write(this.paint(prefix, kind === "thinking" ? "dim italic" : undefined));
    }
  }

  protected override write(piece: string): void {
    super.write(piece);
    this.out.write(this.paint(piece, this.streamKind === "thinking" ? "dim italic" : undefined));
  }

  protected override endStream(): void {
    if (this.streamKind !== null) this.out.write("\n");
    super.endStream();
  }
}
