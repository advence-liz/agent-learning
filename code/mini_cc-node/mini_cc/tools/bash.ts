/**
 * Bash：在项目目录跑一条 shell 命令。（第 1 章朴素版；第 2 章整理输出；第 3 章超时；第 5 章只读判定与高危检查；
 * 第 16 章 run_in_background）
 */

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { type Args, Tool, type ToolContext, ToolResult } from "./base.ts";

// 只读命令白名单：这些命令（且不带危险参数、不含重定向）可以免审批
const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "pwd", "echo", "grep", "rg", "wc", "which", "stat", "file", "tree",
  "du", "df", "date", "whoami", "uname", "env", "printenv", "basename", "dirname", "realpath", "sort", "uniq",
]);
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "remote", "blame", "ls-files"]);
const DANGEROUS = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\$HOME|\*)(\s|$)/, // rm -rf / ~ *
  /\bsudo\b/, /\bmkfs\b/, /\bdd\s+.*of=\/dev\//, />\s*\/dev\/sd/, /:\(\)\s*\{.*\};\s*:/, // fork bomb
  /\bgit\s+push\b.*--force/, /\bcurl\b.*\|\s*(ba)?sh/, /\bchmod\s+-R\s+777\s+\//,
];

const PUNCT = "|&;";

/**
 * 按 POSIX shell 规则分词，连续的 | & ; 合成一个记号（对应 Python 的
 * shlex.shlex(posix=True, punctuation_chars="|&;", whitespace_split=True)）。引号没闭合返回 null。
 */
function shlexSplit(command: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let inWord = false;
  let i = 0;
  const flush = () => {
    if (inWord) tokens.push(cur);
    cur = "";
    inWord = false;
  };
  while (i < command.length) {
    const ch = command[i];
    if (/\s/.test(ch)) {
      flush();
      i++;
    } else if (ch === "#") {
      // shlex 默认把 # 当注释开头：这一行剩下的都丢掉
      flush();
      while (i < command.length && command[i] !== "\n") i++;
    } else if (PUNCT.includes(ch)) {
      flush();
      let p = "";
      while (i < command.length && PUNCT.includes(command[i])) p += command[i++];
      tokens.push(p);
    } else if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (ch === '"') {
      i++;
      for (;;) {
        if (i >= command.length) return null;
        const c = command[i];
        if (c === '"') break;
        if (c === "\\" && i + 1 < command.length && '"\\'.includes(command[i + 1])) {
          cur += command[i + 1];
          i += 2;
        } else {
          cur += c;
          i++;
        }
      }
      inWord = true;
      i++;
    } else if (ch === "\\") {
      if (i + 1 >= command.length) return null;
      cur += command[i + 1];
      inWord = true;
      i += 2;
    } else {
      cur += ch;
      inWord = true;
      i++;
    }
  }
  flush();
  return tokens;
}

/** 按 | && || ; 拆成子命令并分词。含重定向、命令替换等复杂语法时返回 null（看不懂就不放行）。 */
export function splitCommands(command: string): string[][] | null {
  if (["`", "$(", ">", "<", "&>", "\n"].some((tok) => command.includes(tok))) return null;
  const tokens = shlexSplit(command);
  if (tokens === null) return null;
  const parts: string[][] = [[]];
  for (const t of tokens) {
    if (["|", "||", "&&", ";"].includes(t)) parts.push([]);
    else if ([...t].every((c) => PUNCT.includes(c))) return null; // 后台 & 之类
    else parts.at(-1)!.push(t);
  }
  const nonEmpty = parts.filter((p) => p.length);
  return nonEmpty.length ? nonEmpty : null;
}

export function isReadOnly(command: string): boolean {
  const parts = splitCommands(command);
  if (!parts) return false;
  for (const argv of parts) {
    const prog = argv[0];
    if (prog === "git") {
      if (argv.length < 2 || !READ_ONLY_GIT.has(argv[1])) return false;
    } else if (prog === "find") {
      if (argv.some((a) => ["-exec", "-execdir", "-delete", "-ok"].includes(a))) return false;
    } else if (!READ_ONLY_COMMANDS.has(prog)) {
      return false;
    }
  }
  return true;
}

interface ShellResult {
  stdout: string;
  stderr: string;
  code: number | null; // 被信号杀掉时是 null
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * 跑一条 shell 命令并收集输出（对应 Python 的 subprocess.run(shell=True, capture_output=True, timeout=...)）。
 * 子进程自成一个进程组（detached），超时 / 取消时整组杀掉，`sleep 99 | cat` 这种管道也不会留下孤儿。
 */
export function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    // stdin 接 /dev/null：命令不会和 REPL 抢键盘输入（Python 版前台命令继承 stdin）
    const child = spawn(command, { shell: true, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const errs: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* 已经退出了 */
      }
    };
    const timer = setTimeout(() => ((timedOut = true), killGroup()), timeoutMs);
    const onAbort = () => ((aborted = true), killGroup());
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => errs.push(b));
    child.on("error", (e) => (clearTimeout(timer), reject(e)));
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(errs).toString("utf8"), code, signal: sig, timedOut, aborted });
    });
  });
}

export class BashTool extends Tool {
  override name = "Bash";
  override kind = "exec";
  override description =
    "Run a shell command in the project directory and return stdout/stderr. " +
    "For commands that run long or never exit on their own (dev servers, watchers, full test suites, big " +
    "installs), set run_in_background=true: you get a task id and an output file immediately, keep working, " +
    "and a <task-notification> arrives when the command exits. Read the output file to check progress; " +
    "stop it with TaskStop. Do not poll with sleep.";
  override inputSchema = {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "integer", description: "Seconds, default 30 (foreground only)" },
      description: { type: "string", description: "5-10 words on what this command does" },
      run_in_background: { type: "boolean", description: "Run without waiting; notified on exit" },
    },
    required: ["command"],
  };

  override async run(args: Args, ctx: ToolContext): Promise<ToolResult> {
    if (args.run_in_background) {
      const jobs = ctx.extras.jobs;
      if (!jobs) return new ToolResult("Background tasks are not available here; run the command in the foreground.", true);
      const job = jobs.startBash(args.command, ctx.cwd, args.description ?? "", ctx.toolUseId);
      // 措辞参考 Claude Code：告诉模型 id、输出在哪、什么时候会被通知、别去轮询
      return new ToolResult(`Command running in background with ID: ${job.id}. Output is being written to: ` +
        `${job.outputFile}. You will be notified when it completes. ` +
        "To check interim output, use Read on that file path.");
    }
    const timeout: number = args.timeout ?? 30;
    const r = await runShell(args.command, ctx.cwd, timeout * 1000, ctx.signal);
    if (r.timedOut) {
      return new ToolResult((`${r.stdout.trimEnd()}\n[timed out after ${timeout}s; the process was killed. ` +
        "If it is expected to run long, use run_in_background=true]").trim(), true);
    }
    if (r.aborted) return new ToolResult(`${r.stdout.trimEnd()}\n[interrupted by user]`.trim(), true);
    // 被信号杀掉时按 Python 的习惯记成负数退出码（SIGKILL → -9）
    const code = r.code ?? -(constants.signals[r.signal!] ?? 1);
    const parts = [r.stdout.trimEnd()];
    if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
    if (code !== 0) parts.push(`[exit code ${code}]`);
    const out = parts.filter(Boolean).join("\n") || "(no output)";
    return new ToolResult(out, code !== 0);
  }

  override selfCheck(args: Args): "allow" | "ask" | null {
    const cmd: string = args.command ?? "";
    if (DANGEROUS.some((p) => p.test(cmd))) return "ask";
    if (isReadOnly(cmd)) return "allow";
    return null;
  }

  override ruleKey(args: Args): string {
    return `Bash(${args.command ?? ""})`;
  }

  override summary(args: Args): string {
    return `Bash(${args.command ?? ""})`;
  }
}
