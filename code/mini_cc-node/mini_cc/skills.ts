/**
 * Skills 渐进式加载（第 20 章）。
 *
 * 三层，按需进上下文：
 * 1. 目录：每个 skill 一行「name: description」，放 system（会话开始时算一次）。总长度超预算时，
 *    先把最少被调用的 skill 的描述砍掉，只留名字。
 * 2. 正文：模型调 Skill 工具（或你敲 /skill-name）时，渲染 SKILL.md（替换参数、执行 !`cmd`），作为一条
 *    普通文本追加进上下文，之后一直留着。
 * 3. 附录：references/、scripts/ 里的文件不自动加载，正文里只给路径，模型需要时自己 Read / Bash。
 *
 * 位置：<home>/skills/<name>/SKILL.md（用户级）、<cwd>/.mini_cc/skills/<name>/SKILL.md（项目级，同名覆盖用户级）。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Args, Tool, type ToolContext, ToolResult } from "./tools/base.ts";

export const MAX_DESCRIPTION = 1536; // 单个 skill 在目录里最多保留的描述长度（Claude Code 文档的数字）
const CMD = /!`([^`]+)`/g;
const POS = /\$(\d)/g;

export class Skill {
  name: string;
  description: string;
  dir: string;
  body: string;
  scope: string; // user | project
  modelInvocable: boolean;

  constructor(name: string, description: string, dir: string, body: string, scope: string, modelInvocable = true) {
    this.name = name;
    this.description = description;
    this.dir = dir;
    this.body = body;
    this.scope = scope;
    this.modelInvocable = modelInvocable;
  }

  get path(): string {
    return join(this.dir, "SKILL.md");
  }
}

function frontmatter(text: string): [Record<string, string>, string] {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return [{}, text];
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i >= 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']+|["']+$/g, "");
  }
  return [meta, m[2]];
}

export function loadSkills(cwd: string, home: string): Map<string, Skill> {
  const out = new Map<string, Skill>();
  for (const [scope, root] of [["user", join(home, "skills")], ["project", join(cwd, ".mini_cc", "skills")]]) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    for (const d of readdirSync(root).sort()) {
      const f = join(root, d, "SKILL.md");
      if (!existsSync(f) || !statSync(f).isFile()) continue;
      const [meta, body] = frontmatter(readFileSync(f, "utf8"));
      const name = meta.name || d;
      out.set(name, new Skill(name, meta.description ?? "", join(root, d), body, scope,
        (meta["disable-model-invocation"] ?? "").toLowerCase() !== "true"));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 第 1 层：目录

/** 模型可调用的 skill 目录。超预算时按调用次数从少到多砍描述（名字永远保留）。 */
export function listing(skills: Iterable<Skill>, budgetChars: number, usage: Record<string, number> = {}): string {
  const byName = (a: Skill, b: Skill) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const items = [...skills].filter((s) => s.modelInvocable).sort(byName);
  const desc = new Map(items.map((s) => [s.name, s.description.slice(0, MAX_DESCRIPTION)]));
  const line = (s: Skill) => (desc.get(s.name) ? `- ${s.name}: ${desc.get(s.name)}` : `- ${s.name}`);
  let dropped = 0;
  const leastUsedFirst = [...items].sort((a, b) => (usage[a.name] ?? 0) - (usage[b.name] ?? 0) || byName(a, b));
  for (const s of leastUsedFirst) {
    if (items.reduce((n, x) => n + line(x).length + 1, 0) <= budgetChars) break;
    if (desc.get(s.name)) {
      desc.set(s.name, "");
      dropped++;
    }
  }
  const lines = items.map(line);
  if (dropped) lines.push(`(${dropped} descriptions omitted to fit the listing budget; the names are still invocable)`);
  return lines.join("\n");
}

export const GUIDE = `# Skills
Skills are packaged instructions for specific tasks. Below is the list of skills you can invoke with the Skill
tool: name and a one-line description of when to use it. When a request matches a skill, invoke it BEFORE
starting the work; its full instructions will be added to the conversation. Do not guess a skill's contents
from its name. Files a skill mentions (references/, scripts/) are not loaded: Read or run them when needed.

{listing}`;

// ---------------------------------------------------------------- 第 2 层：正文

export class SkillError extends Error {
  override name = "SkillError";
}

/** 跑一条预处理命令（同 Python 的 subprocess.run(shell=True, capture_output=True, timeout=...)）。 */
function runCommand(cmd: string, cwd: string, timeout: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => ((timedOut = true), child.kill("SIGKILL")), timeout * 1000);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => (clearTimeout(timer), reject(e)));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut });
    });
  });
}

/** 替换参数和目录占位符，执行 !`cmd`（输出替换占位符；任一失败则整个调用失败）。 */
export async function renderBody(skill: Skill, args: string, cwd: string, timeout = 15): Promise<string> {
  let text = skill.body.replaceAll("${SKILL_DIR}", skill.dir);
  const hadPlaceholder = text.includes("$ARGUMENTS") || /\$(\d)/.test(text);
  const parts = args.split(/\s+/).filter(Boolean);
  text = text.replaceAll("$ARGUMENTS", () => args); // 用函数替换：args 里的 $ 不会被当成替换模式
  text = text.replace(POS, (_m, d: string) => parts[Number(d)] ?? "");

  // !`cmd` 依次执行（Python 版 re.sub 的回调是同步的；这里先跑完所有命令，再一次性替换）
  const outputs: string[] = [];
  for (const m of text.matchAll(CMD)) {
    const p = await runCommand(m[1], cwd, timeout);
    if (p.timedOut) throw new SkillError(`preprocess command \`${m[1]}\` timed out after ${timeout}s`);
    if (p.code !== 0) {
      throw new SkillError(`preprocess command \`${m[1]}\` failed with exit code ${p.code}: ` +
        `${(p.stderr || p.stdout).trim().slice(0, 200)}`);
    }
    outputs.push(p.stdout.trim());
  }
  let i = 0;
  text = text.replace(CMD, () => outputs[i++]);
  if (args && !hadPlaceholder) text = text.replace(/\n+$/, "") + `\n\nARGUMENTS: ${args}\n`;
  return `Base directory for this skill: ${skill.dir}\n\n${text}`;
}

export class SkillTool extends Tool {
  override name = "Skill";
  override kind = "skill";
  override description = "Invoke a skill from the # Skills list in the system prompt. Its full instructions are then " +
    "added to the conversation; follow them. Use the exact skill name.";
  override inputSchema = {
    type: "object",
    properties: {
      skill: { type: "string", description: "Skill name from the list" },
      args: { type: "string", description: "Optional arguments" },
    },
    required: ["skill"],
    additionalProperties: false,
  };

  override selfCheck(_args: Args): "allow" {
    return "allow"; // 加载说明书本身不碰任何东西（!`cmd` 是 skill 作者写的，和装 skill 一样是信任决定）
  }

  override summary(args: Args): string {
    return `Skill(${args.skill}${args.args ? " " + args.args : ""})`;
  }

  override async run(args: Args, ctx: ToolContext): Promise<ToolResult> {
    const rt: SkillRuntime | undefined = ctx.extras.skills;
    if (rt === undefined) return new ToolResult("Skills are not available here.", true);
    const skill = rt.skills.get(args.skill);
    if (skill === undefined) {
      const names = [...rt.skills.values()].filter((s) => s.modelInvocable).map((s) => s.name);
      return new ToolResult(`Unknown skill '${args.skill}'. Available: ${names.join(", ")}`, true);
    }
    if (!skill.modelInvocable) return new ToolResult(`Skill ${skill.name} can be invoked only by the user (as /${skill.name}).`, true);
    let body: string;
    try {
      body = await rt.invoke(skill, args.args ?? "", ctx.cwd);
    } catch (e) {
      if (e instanceof SkillError) return new ToolResult(`Skill ${skill.name} failed: ${e.message}`, true);
      throw e;
    }
    // 正文不放在 tool_result 里，而是作为一条普通文本紧跟在结果后面（同一条 user 消息）
    ctx.followupBlocks.push({ type: "text", text: body });
    return new ToolResult(`Launching skill: ${skill.name}`);
  }
}

/** 会话级状态：可用的 skill、调用次数（决定目录预算里谁先被砍描述）、本会话调用过的正文（压缩后挂回）。 */
export class SkillRuntime {
  skills: Map<string, Skill>;
  usagePath: string;
  usage: Record<string, number>;
  invoked = new Map<string, string>();

  constructor(skills: Map<string, Skill>, usagePath: string) {
    this.skills = skills;
    this.usagePath = usagePath;
    this.usage = existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, "utf8")) : {};
  }

  async invoke(skill: Skill, args: string, cwd: string): Promise<string> {
    const body = await renderBody(skill, args, cwd);
    this.invoked.set(skill.name, body);
    this.usage[skill.name] = (this.usage[skill.name] ?? 0) + 1;
    mkdirSync(dirname(this.usagePath), { recursive: true });
    writeFileSync(this.usagePath, JSON.stringify(this.usage));
    return body;
  }

  systemSection(budgetChars: number): string | null {
    const text = listing(this.skills.values(), budgetChars, this.usage);
    return text ? GUIDE.replace("{listing}", () => text) : null;
  }
}
