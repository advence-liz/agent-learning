/**
 * 不抓包也能看：直接读 ~/.claude/projects/*\/*.jsonl 的**结构**（不打印任何正文）。
 * 见 p3-agent-internals/01-http-analyzer.md、02-hi-request.md。
 *
 *     node http_analyzer/session_stats.ts types              # 记录类型分布
 *     node http_analyzer/session_stats.ts cache [N]          # 最近 N 个会话前几轮的 usage 链
 *     node http_analyzer/session_stats.ts compact            # 所有 compact_boundary 的元数据
 *     node http_analyzer/session_stats.ts shape              # 最近一次 api-request-shape 的骨架
 *
 * 注意：jsonl 是 Claude Code 的内部存储格式，没有官方 schema，字段随版本变化。
 * 本脚本只读结构字段（type / usage / 长度），不输出消息文本。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

type Obj = Record<string, any>;

export const ROOT = join(homedir(), ".claude", "projects");

const USAGE = `usage: node http_analyzer/session_stats.ts types | cache [N] | compact | shape`;

export function* iterRecords(files: string[]): Generator<[string, Obj]> {
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      try {
        const r = JSON.parse(line);
        if (r !== null && typeof r === "object") yield [f, r];
      } catch {
        continue;
      }
    }
  }
}

export function allFiles(): string[] {
  if (!existsSync(ROOT)) return [];
  const files: string[] = [];
  for (const proj of readdirSync(ROOT, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    for (const f of readdirSync(join(ROOT, proj.name))) {
      if (f.endsWith(".jsonl")) files.push(join(ROOT, proj.name, f));
    }
  }
  const mtime = new Map(files.map((f) => [f, statSync(f).mtimeMs]));
  return files.sort((a, b) => mtime.get(a)! - mtime.get(b)!);
}

/** 对应 collections.Counter(...).most_common()：按次数降序，同票保持首次出现的顺序。 */
function mostCommon(it: Iterable<unknown>): [string, number][] {
  const c = new Map<string, number>();
  for (const x of it) {
    const k = String(x ?? null);
    c.set(k, (c.get(k) ?? 0) + 1);
  }
  return [...c].sort((a, b) => b[1] - a[1]);
}

export function cmdTypes(): void {
  const rows = mostCommon((function* () {
    for (const [, r] of iterRecords(allFiles())) yield r.type;
  })());
  for (const [k, v] of rows) console.log(`${String(v).padStart(8)}  ${k}`);
}

/** 主线程（非 sidechain）每次 API 响应的 usage；同一 message.id 的多条记录只算一次。 */
export function usageChain(path: string, limit = 5): [number, number, number, number][] {
  const seen = new Set<unknown>();
  const rows: [number, number, number, number][] = [];
  for (const [, r] of iterRecords([path])) {
    if (r.type !== "assistant" || r.isSidechain) continue;
    const m = r.message || {};
    const u = m.usage;
    if (!u || seen.has(m.id)) continue;
    seen.add(m.id);
    rows.push([u.input_tokens ?? 0, u.cache_creation_input_tokens ?? 0,
      u.cache_read_input_tokens ?? 0, u.output_tokens ?? 0]);
    if (rows.length >= limit) break;
  }
  return rows;
}

export function cmdCache(n = 3): void {
  let shown = 0;
  for (const f of allFiles().reverse()) {
    const rows = usageChain(f);
    if (rows.length < 4) continue;
    console.log(`session ${basename(f, ".jsonl").slice(0, 8)}   input  cache_create  cache_read  output   read(n)==read(n-1)+create(n-1)?`);
    rows.forEach(([inp, cc, cr, out], i) => {
      const ok = i === 0 ? "" : cr === rows[i - 1][1] + rows[i - 1][2] ? "yes" : "no";
      const w = (x: number, width: number) => String(x).padStart(width);
      console.log(`  turn ${i + 1}  ${w(inp, 7)} ${w(cc, 13)} ${w(cr, 11)} ${w(out, 7)}   ${ok}`);
    });
    shown += 1;
    if (shown >= n) break;
  }
}

export function cmdCompact(): void {
  const rows: [any, any, any][] = [];
  for (const [, r] of iterRecords(allFiles())) {
    if (r.type === "system" && r.subtype === "compact_boundary") {
      const m = r.compactMetadata || {};
      rows.push([m.trigger, m.preTokens, m.postTokens]);
    }
  }
  console.log(`${rows.length} compact boundaries`);
  const by: Record<string, number> = {}; // 按首次出现的顺序计数（对应 dict(Counter)）
  for (const [t] of rows) by[String(t ?? null)] = (by[String(t ?? null)] ?? 0) + 1;
  console.log("by trigger:", JSON.stringify(by));
  const ratios = rows.filter(([, pre, post]) => pre && post).map(([, pre, post]) => post / pre).sort((a, b) => a - b);
  if (ratios.length) {
    const f = (x: number) => x.toFixed(3);
    console.log(`post/pre ratio: min ${f(ratios[0])}  median ${f(ratios[Math.floor(ratios.length / 2)])}  max ${f(ratios.at(-1)!)}`);
  }
  const pres = rows.filter(([t, pre]) => t === "auto" && pre).map(([, pre]) => pre as number).sort((a, b) => a - b);
  if (pres.length) {
    console.log(`auto preTokens: min ${pres[0]}  median ${pres[Math.floor(pres.length / 2)]}  max ${pres.at(-1)}`);
  }
}

export function cmdShape(): void {
  let last: Obj | null = null;
  for (const [, r] of iterRecords(allFiles().slice(-20))) {
    if (r.type === "api-request-shape") last = r;
  }
  if (!last) {
    console.log("no api-request-shape record found (this record type may not exist in your version)");
    return;
  }
  const s = last.shape;
  console.log("version", last.version);
  (s.system ?? []).forEach((b: Obj, i: number) => console.log(`system[${i}] ${(b.text ?? "").length} chars`));
  const names = (s.tools ?? []).map((t: Obj) => t.name);
  const builtin = names.filter((x: unknown) => !String(x).startsWith("mcp__"));
  console.log(`tools: ${names.length} total, ${names.length - builtin.length} mcp__*, built-in: ${JSON.stringify(builtin)}`);
  console.log("deferred:", (s.tools ?? []).filter((t: Obj) => t.defer_loading).length);
}

export function main(argv = process.argv.slice(2)): void {
  const cmd = argv[0] ?? "types";
  if (cmd === "types") cmdTypes();
  else if (cmd === "cache") cmdCache(argv.length > 1 ? Number(argv[1]) : 3);
  else if (cmd === "compact") cmdCompact();
  else if (cmd === "shape") cmdShape();
  else {
    console.error(USAGE);
    process.exit(1);
  }
}

if (import.meta.main) main();
