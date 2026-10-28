/**
 * 读抓包目录，把一次 /v1/messages 请求拆成「system / tools / messages / cache 断点 / usage」。
 * 见 p3-agent-internals/01-http-analyzer.md。
 *
 *     node http_analyzer/analyze.ts captures/                # 所有请求的一行摘要
 *     node http_analyzer/analyze.ts captures/ --show 3       # 拆开第 3 个请求
 *     node http_analyzer/analyze.ts captures/ --prefix 3 4   # 两次请求的公共前缀（解释缓存命中）
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Obj = Record<string, any>;

export function load(capdir: string, idx: number): [Obj, Obj] {
  const dirs = readdirSync(capdir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const d = join(capdir, dirs[idx - 1]);
  const req = JSON.parse(readFileSync(join(d, "request.json"), "utf8"));
  const resp = JSON.parse(readFileSync(join(d, "response.json"), "utf8"));
  return [req, resp];
}

function blocks(content: any): Obj[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content || [];
}

function size(b: Obj): number {
  return JSON.stringify(b).length;
}

const isObj = (x: any): x is Obj => x !== null && typeof x === "object" && !Array.isArray(x);

/** 对应 Python 的 json.dumps(sort_keys=True)：键排好序再序列化，同样的内容总得到同样的字符串。 */
export function sortedJson(x: any): string {
  return JSON.stringify(x, (_k, v) =>
    isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v,
  );
}

const withoutCache = (b: Obj): Obj => {
  const { cache_control: _, ...rest } = b;
  return rest;
};

/** 按 API 的前缀顺序 tools → system → messages 找出所有 cache_control 位置。 */
export function cacheBreakpoints(body: Obj): string[] {
  const out: string[] = [];
  (body.tools ?? []).forEach((t: Obj, i: number) => {
    if ("cache_control" in t) out.push(`tools[${i}](${t.name})`);
  });
  const sysp = body.system;
  (sysp ? blocks(sysp) : []).forEach((b, i) => {
    if ("cache_control" in b) out.push(`system[${i}] ${JSON.stringify(b.cache_control)}`);
  });
  (body.messages ?? []).forEach((m: Obj, i: number) => {
    blocks(m.content).forEach((b, j) => {
      if (isObj(b) && "cache_control" in b) out.push(`messages[${i}].content[${j}] ${JSON.stringify(b.cache_control)}`);
    });
  });
  return out;
}

export function show(req: Obj, resp: Obj): string {
  const body = req.body;
  const lines = [`${req.method} ${req.path}  body=${req.body_bytes} bytes  model=${body.model}`];
  const beta = req.headers["anthropic-beta"] || req.headers["Anthropic-Beta"];
  if (beta) lines.push(`anthropic-beta: ${beta}`);
  lines.push("-- system");
  blocks(body.system).forEach((b, i) => {
    const head = (b.text ?? "").slice(0, 60).replaceAll("\n", " ");
    lines.push(`  [${i}] ${(b.text ?? "").length} chars  ${JSON.stringify(head)}`);
  });
  const tools: Obj[] = body.tools ?? [];
  lines.push(`-- tools (${tools.length})`);
  for (const t of tools) {
    const flag = t.defer_loading ? " defer_loading" : "";
    lines.push(`  ${t.name ?? t.type}: ${size(t)} bytes${flag}`);
  }
  lines.push(`-- messages (${(body.messages ?? []).length})`);
  (body.messages ?? []).forEach((m: Obj, i: number) => {
    const parts = blocks(m.content).filter(isObj).map((b) => `${b.type}:${size(b)}`);
    lines.push(`  [${i}] ${m.role}: ${parts.join(", ")}`);
  });
  lines.push("-- cache_control breakpoints");
  const bps = cacheBreakpoints(body).map((x) => `  ${x}`);
  lines.push(...(bps.length ? bps : ["  (none)"]));
  const msg = resp.message || resp.body || {};
  if (isObj(msg) && msg.usage) lines.push(`-- usage ${JSON.stringify(msg.usage)}`);
  return lines.join("\n");
}

/** 把请求按缓存前缀顺序展开成一串「块」，用来比较两次请求的公共前缀。 */
export function linearize(body: Obj): string[] {
  const seq = (body.tools ?? []).map((t: Obj) => sortedJson(t));
  seq.push(...blocks(body.system).map((b) => sortedJson(withoutCache(b))));
  for (const m of body.messages ?? []) {
    for (let b of blocks(m.content)) {
      if (isObj(b)) b = withoutCache(b);
      seq.push(m.role + ":" + sortedJson(b));
    }
  }
  return seq;
}

export function commonPrefix(a: Obj, b: Obj): [number, number, number] {
  const sa = linearize(a);
  const sb = linearize(b);
  let n = 0;
  while (n < Math.min(sa.length, sb.length) && sa[n] === sb[n]) n++;
  return [n, sa.length, sb.length];
}

export function main(argv = process.argv.slice(2)): void {
  // 参数很少，手写解析：capdir [--show N] [--prefix A B]
  let capdir: string | undefined;
  let showIdx: number | undefined;
  let prefix: [number, number] | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--show") showIdx = Number(argv[++i]);
    else if (argv[i] === "--prefix") prefix = [Number(argv[++i]), Number(argv[++i])];
    else capdir = argv[i];
  }
  if (!capdir) {
    console.error("usage: node http_analyzer/analyze.ts CAPDIR [--show N] [--prefix A B]");
    process.exit(2);
  }
  if (showIdx) {
    console.log(show(...load(capdir, showIdx)));
  } else if (prefix) {
    const [ra] = load(capdir, prefix[0]);
    const [rb] = load(capdir, prefix[1]);
    const [n, la, lb] = commonPrefix(ra.body, rb.body);
    console.log(`request ${prefix[0]}: ${la} blocks, request ${prefix[1]}: ${lb} blocks, ` +
      `shared prefix: ${n} blocks`);
  } else {
    const idx = join(capdir, "index.jsonl");
    for (const line of readFileSync(idx, "utf8").split("\n")) if (line) console.log(line);
  }
}

if (import.meta.main) main();
