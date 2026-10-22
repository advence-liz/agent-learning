/**
 * 会话持久化：每个会话一个 JSONL 文件，按项目分目录，只追加。（第 4、13、14 章）
 *
 * 布局（模仿 Claude Code 的 ~/.claude/projects/<slug>/<session-id>.jsonl）：
 *     <home>/projects/<slug>/<session_id>.jsonl
 *
 * 每行一条记录：
 *     {"type": "user"|"assistant", "uuid", "parentUuid", "sessionId", "timestamp", "cwd", "message": {...}, "usage"?: {...}}
 * 其他 type（第 5 章的 permission-mode，第 13/14 章的 rewind、compact 会加）读取时默认忽略。
 *
 * 第 13 章起，读取不再是「从头到尾逐行」，而是从最新的叶子沿 parentUuid 往回走：
 * /rewind 之后新消息指回分叉点，被丢弃的分支还留在文件里（只追加），但不在链上。
 * 一条 {"type": "rewind", "leafUuid": ...} 记录把叶子挪回分叉点（回退后什么都没说就退出，恢复时也是回退后的样子）。
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Usage } from "./loop.ts";
import type { Message } from "./model.ts";
import { realResolve } from "./tools/base.ts";
import { splitLines } from "./tools/file_state.ts";

export type SessionRecord = Record<string, any>;

export function projectSlug(cwd: string): string {
  // /Users/liz/my.proj → -Users-liz-my-proj（和 Claude Code 一样：非字母数字都换成 -）
  return realResolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

function now(): string {
  // 和 Python 的 datetime.now(timezone.utc).isoformat(timespec="milliseconds") 同一个格式
  return new Date().toISOString().replace("Z", "+00:00");
}

function firstText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  for (const b of content ?? []) {
    if (b?.type === "text" && !String(b.text).startsWith("<system-reminder>")) return b.text;
  }
  return "";
}

export interface SessionInfo {
  id: string;
  path: string;
  title: string;
  messages: number;
  updated: Date;
}

/** 当前分支上的消息记录（按时间顺序）：找到最新的叶子，沿 parentUuid 往回走。 */
export function branch(recs: SessionRecord[]): SessionRecord[] {
  const byId = new Map<string, SessionRecord>();
  let leaf: string | null = null;
  for (const r of recs) {
    if ((r.type === "user" || r.type === "assistant") && r.uuid && "message" in r) {
      byId.set(r.uuid, r);
      leaf = r.uuid;
    } else if (r.type === "rewind") {
      leaf = r.leafUuid ?? null;
    }
  }
  const out: SessionRecord[] = [];
  while (leaf && byId.has(leaf)) {
    const r = byId.get(leaf)!;
    out.push(r);
    leaf = r.parentUuid ?? null;
  }
  return out.reverse();
}

export class Session {
  store: SessionStore;
  id: string;
  path: string;
  tasksPath: string; // 第 11 章：任务清单和历史分开存
  lastUuid: string | null = null;
  // 当前分支上每条消息的 uuid，和 Agent.messages 一一对应（/rewind 靠它把消息下标换成 uuid）
  chain: string[] = [];

  constructor(store: SessionStore, sessionId?: string) {
    this.store = store;
    this.id = sessionId ?? randomUUID();
    this.path = join(store.dir, `${this.id}.jsonl`);
    this.tasksPath = join(store.dir, `${this.id}.tasks.json`);
    if (existsSync(this.path)) {
      // 恢复的会话：新消息接在当前分支最后一条后面
      this.chain = branch(SessionStore.readRecords(this.path)).map((r) => r.uuid);
      this.lastUuid = this.chain.at(-1) ?? null;
    }
  }

  /** Agent.listeners 回调：每条新消息立刻追加一行。文件在第一条消息时才创建。 */
  record(msg: Message, meta: Record<string, any> = {}): void {
    if (meta.compact) {
      // 第 14 章：压缩边界。parentUuid 为空 = 链在这里断开，读取时不再往前走；logicalParentUuid 只作审计
      const boundary: SessionRecord = {
        type: "system", subtype: "compact_boundary", uuid: randomUUID(), parentUuid: null,
        logicalParentUuid: this.lastUuid, sessionId: this.id, timestamp: now(), compactMetadata: meta.compact,
      };
      this.appendRecord(boundary);
      this.lastUuid = boundary.uuid;
      this.chain = [];
    }
    const rec: SessionRecord = {
      type: msg.role,
      uuid: randomUUID(),
      parentUuid: this.lastUuid,
      sessionId: this.id,
      timestamp: now(),
      cwd: this.store.cwd,
      message: msg,
    };
    if (meta.usage) rec.usage = meta.usage;
    if (meta.compact) rec.isCompactSummary = true;
    this.appendRecord(rec);
    this.lastUuid = rec.uuid;
    this.chain.push(rec.uuid);
  }

  /** 只保留当前分支的前 keep 条消息。文件不改：追加一条 rewind 记录，之后的新消息从分叉点长出新分支。 */
  rewind(keep: number): void {
    this.chain = this.chain.slice(0, keep);
    this.lastUuid = this.chain.at(-1) ?? null;
    this.appendRecord({ type: "rewind", leafUuid: this.lastUuid, sessionId: this.id, timestamp: now() });
  }

  appendRecord(rec: SessionRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // 一次 write 一整行；O_APPEND 下多进程同时追加也不会交错成半行
    appendFileSync(this.path, JSON.stringify(rec) + "\n", "utf8");
  }
}

export class SessionStore {
  cwd: string;
  dir: string;

  constructor(home: string, cwd: string) {
    this.cwd = cwd;
    this.dir = join(home, "projects", projectSlug(cwd));
  }

  new(): Session {
    return new Session(this);
  }

  static readRecords(path: string): SessionRecord[] {
    const recs: SessionRecord[] = [];
    for (const line of splitLines(readFileSync(path, "utf8"))) {
      if (!line.trim()) continue;
      try {
        recs.push(JSON.parse(line));
      } catch {
        // 进程在写最后一行时被杀掉，会留下半行：跳过它，前面的都还能用
      }
    }
    return recs;
  }

  load(sessionId: string): [Session, Message[], Usage] {
    const path = join(this.dir, `${sessionId}.jsonl`);
    if (!existsSync(path)) throw new Error(`no session ${sessionId}`);
    const messages: Message[] = [];
    const usage = new Usage();
    for (const rec of branch(SessionStore.readRecords(path))) {
      messages.push(rec.message);
      if (rec.usage) usage.add(rec.usage);
    }
    return [new Session(this, sessionId), messages, usage];
  }

  list(): SessionInfo[] {
    if (!existsSync(this.dir)) return [];
    const infos: SessionInfo[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const p = join(this.dir, name);
      const msgs = branch(SessionStore.readRecords(p));
      const title = msgs.filter((r) => r.type === "user").map((r) => firstText(r.message.content)).find(Boolean) ?? "";
      infos.push({
        id: basename(name, ".jsonl"), path: p,
        title: title ? (splitLines(title.trim())[0] ?? "").slice(0, 50) : "(empty)",
        messages: msgs.length, updated: statSync(p).mtime,
      });
    }
    return infos.sort((a, b) => b.updated.getTime() - a.updated.getTime());
  }

  /** ref 可以是列表序号（1 开始）或 id 前缀。 */
  resolve(ref: string): string {
    const infos = this.list();
    if (/^\d+$/.test(ref) && Number(ref) >= 1 && Number(ref) <= infos.length) return infos[Number(ref) - 1].id;
    const hits = infos.filter((i) => i.id.startsWith(ref)).map((i) => i.id);
    if (hits.length !== 1) throw new Error(`${hits.length ? "有多个" : "没有"}会话匹配 '${ref}'`);
    return hits[0];
  }
}
