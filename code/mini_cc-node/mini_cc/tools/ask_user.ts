/**
 * AskUserQuestion：模型拿不准、而决定权在用户手里时，反过来问用户。（第 10 章）
 *
 * 和权限弹窗一样，工具执行时循环停在这里等待 UI 返回答案；答案作为普通的 tool_result 回给模型。
 */

import { type Args, Tool, type ToolContext, ToolResult } from "./base.ts";

export interface QuestionOption {
  label: string;
  description?: string;
}

export class Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;

  constructor(question: string, header: string, options: QuestionOption[], multiSelect = false) {
    this.question = question;
    this.header = header;
    this.options = options;
    this.multiSelect = multiSelect;
  }
}

export class Answer {
  question: string;
  choices: string[]; // 选中的 label，或者用户自己输入的文本
  skipped: boolean;

  constructor(question: string, choices: string[] = [], skipped = false) {
    this.question = question;
    this.choices = choices;
    this.skipped = skipped;
  }
}

/** UI 提供的回调：拿到问题列表，返回同样长度的答案列表。 */
export type Asker = (questions: Question[]) => Answer[] | Promise<Answer[]>;

const DESCRIPTION = `Ask the user 1-4 multiple-choice questions when you are blocked on a decision that is genuinely
the user's to make (tech stack, scope, naming, trade-offs) and cannot be resolved from the request, the code,
or sensible defaults. Ask all open questions in ONE call instead of one at a time.
- Each question has a short header (<=12 chars), 2-4 options with a label and a one-line description.
- Set multiSelect: true when several options can apply together.
- Put the recommended option first and add "(Recommended)" to its label.
- Do not add an "Other" option: the user can always type a custom answer.
Do not use this tool to ask for permission to proceed or to confirm a plan you could just execute.`;

export class AskUserQuestionTool extends Tool {
  override name = "AskUserQuestion";
  override readOnly = true; // 不碰文件系统；问用户本身不需要再经过权限审批
  override kind = "meta";
  override description = DESCRIPTION;
  override inputSchema = {
    type: "object",
    properties: {
      questions: {
        type: "array", minItems: 1, maxItems: 4,
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            header: { type: "string" },
            multiSelect: { type: "boolean" },
            options: {
              type: "array", minItems: 2, maxItems: 4,
              items: {
                type: "object",
                properties: { label: { type: "string" }, description: { type: "string" } },
                required: ["label"],
              },
            },
          },
          required: ["question", "header", "options"],
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  };

  override summary(args: Args): string {
    const qs: Args[] = args.questions ?? [];
    return `AskUserQuestion(${qs.length} 个问题：${qs.map((q) => q.header ?? "?").join(" / ")})`;
  }

  override async run(args: Args, ctx: ToolContext): Promise<ToolResult> {
    const asker: Asker | undefined = ctx.extras.ask_user;
    if (asker === undefined) {
      return new ToolResult("The user is not available to answer questions in this mode. " +
        "Proceed with sensible defaults and state your assumptions explicitly.", true);
    }
    const questions = (args.questions as Args[]).map((q) => new Question(q.question, q.header, q.options, q.multiSelect ?? false));
    const answers = await asker(questions);
    if (answers.every((a) => a.skipped)) {
      return new ToolResult("User declined to answer questions. Ask what they want instead of guessing, " +
        "or proceed only with clearly reversible defaults.");
    }
    const parts = answers.map((a) => (a.skipped ? `"${a.question}"=(no answer)` : `"${a.question}"="${a.choices.join(", ")}"`));
    // 措辞参考 Claude Code：先列出答案，再提示模型据此继续
    return new ToolResult("Your questions have been answered: " + parts.join(", ") +
      ". You can now continue with these answers in mind.");
  }
}

/** 把用户输入解析成答案。'1' / '1,3'（多选）/ 文本（Other）/ 空（跳过）。返回 null 表示输入无效。 */
export function parseAnswer(raw: string, q: Question): Answer | null {
  raw = raw.trim();
  if (!raw) return new Answer(q.question, [], true);
  const parts = raw.replaceAll("，", ",").split(",").map((p) => p.trim());
  if (parts.every((p) => /^\d+$/.test(p))) {
    const idx = parts.map(Number);
    if (!q.multiSelect && idx.length > 1) return null;
    if (!idx.every((i) => i >= 1 && i <= q.options.length)) return null;
    return new Answer(q.question, idx.map((i) => q.options[i - 1].label));
  }
  return new Answer(q.question, [raw]); // 不是序号：当作「其他」，用户自己写的答案
}

export function renderQuestion(q: Question, n: number, total: number): string[] {
  const lines = [`[${q.header}] (${n}/${total}) ${q.question}` + (q.multiSelect ? "（可多选，用逗号分隔）" : "")];
  q.options.forEach((o, i) => {
    const desc = o.description ? ` — ${o.description}` : "";
    lines.push(`  ${i + 1}. ${o.label}${desc}`);
  });
  lines.push("  或直接输入你自己的答案；回车跳过");
  return lines;
}
