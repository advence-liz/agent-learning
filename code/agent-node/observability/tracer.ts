/**
 * 第 8 章：给第 2 章的 Coding Agent 加 trace —— 不改 agent 一行代码，只包两层。
 *
 *   invoke_agent            ← 根 span：整个任务
 *    ├─ chat claude-opus-5-5   ← 每次 messages.create：耗时 + token + stop_reason
 *    ├─ execute_tool read_file ← 每次工具执行：耗时 + 参数 + 是否出错
 *    └─ ...
 *
 * 导出格式是 OTLP/JSON（OpenTelemetry 的线上格式），属性名沿用 GenAI 语义约定（gen_ai.*）。
 * 离线演示： node observability/tracer.ts
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { makeTools, runAgent, type Tools } from "../coding_agent/agent.ts";
import type { CreateParams, LLMClient, Message } from "../fake_llm/index.ts";

type Attrs = Record<string, unknown>;

/** 当前墙钟时间（纳秒，bigint）。Number 装不下 19 位纳秒，拆成「起点微秒 + 相对纳秒」再相加。 */
function nowNs(): bigint {
  return BigInt(Math.round(performance.timeOrigin * 1e3)) * 1000n + BigInt(Math.round(performance.now() * 1e6));
}

export class Span {
  name: string;
  traceId: string;
  spanId: string;
  parentId: string | null;
  kind: number; // 1=INTERNAL 3=CLIENT（OTLP 枚举值）
  startNs: bigint;
  endNs = 0n;
  attrs: Attrs;
  error: string | null = null;
  seq: number; // 开始顺序：startNs 撞车时用来排序

  constructor(name: string, traceId: string, parentId: string | null, kind: number, attrs: Attrs, seq: number) {
    this.name = name;
    this.traceId = traceId;
    this.spanId = randomBytes(8).toString("hex");
    this.parentId = parentId;
    this.kind = kind;
    this.startNs = nowNs();
    this.attrs = { ...attrs };
    this.seq = seq;
  }

  get ms(): number {
    return Number(this.endNs - this.startNs) / 1e6;
  }
}

const byStart = (a: Span, b: Span) => (a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : a.seq - b.seq);

export class Tracer {
  service: string;
  spans: Span[] = [];
  // AsyncLocalStorage ≈ Python 的 contextvars：沿着同步调用和 await 链自动传「当前 span」
  private current = new AsyncLocalStorage<Span>();
  private traceId = randomBytes(16).toString("hex");
  private seq = 0;

  constructor(service = "mini-coding-agent") {
    this.service = service;
  }

  /** 在一个新 span 里执行 fn；fn 同步或返回 Promise 都行，抛错会记到 span.error 再继续抛。 */
  span<T>(name: string, { kind = 1, attrs = {} }: { kind?: number; attrs?: Attrs }, fn: (s: Span) => T): T {
    const parent = this.current.getStore();
    const s = new Span(name, this.traceId, parent ? parent.spanId : null, kind, attrs, this.seq++);
    const finish = () => {
      s.endNs = nowNs();
      this.spans.push(s);
    };
    const fail = (e: unknown) => {
      s.error = `${(e as Error).name}: ${(e as Error).message}`;
      finish();
      throw e;
    };
    let out: T;
    try {
      out = this.current.run(s, fn, s); // run 结束后自动恢复成父 span，不用手动 reset
    } catch (e) {
      return fail(e);
    }
    if (out instanceof Promise) {
      return out.then((v) => (finish(), v), fail) as T;
    }
    finish();
    return out;
  }

  // ---------- 导出 ----------
  toOtlp(): any {
    const kv = (d: Attrs) =>
      Object.entries(d).map(([key, v]) => {
        let value: Record<string, unknown>;
        if (typeof v === "boolean") value = { boolValue: v };
        else if (typeof v === "number" && Number.isInteger(v)) value = { intValue: String(v) }; // OTLP/JSON 里 int64 用字符串
        else if (typeof v === "number") value = { doubleValue: v };
        else if (Array.isArray(v)) value = { arrayValue: { values: v.map((x) => ({ stringValue: String(x) })) } };
        else value = { stringValue: String(v) };
        return { key, value };
      });

    const spans = [...this.spans].sort(byStart).map((s) => {
      const d: Record<string, unknown> = {
        traceId: s.traceId, spanId: s.spanId, name: s.name, kind: s.kind,
        startTimeUnixNano: String(s.startNs), endTimeUnixNano: String(s.endNs),
        attributes: kv(s.attrs),
        status: s.error ? { code: 2, message: s.error } : { code: 1 },
      };
      if (s.parentId) d.parentSpanId = s.parentId;
      return d;
    });
    return {
      resourceSpans: [{
        resource: { attributes: kv({ "service.name": this.service }) },
        scopeSpans: [{ scope: { name: "agentlab.tracer", version: "0.1" }, spans }],
      }],
    };
  }

  printTree(log: (s: string) => void = console.log): void {
    const children = new Map<string | null, Span[]>();
    for (const s of [...this.spans].sort(byStart)) {
      if (!children.has(s.parentId)) children.set(s.parentId, []);
      children.get(s.parentId)!.push(s);
    }

    const walk = (pid: string | null, depth: number): void => {
      for (const s of children.get(pid) ?? []) {
        const a = s.attrs;
        let extra = "";
        if ("gen_ai.usage.input_tokens" in a) {
          extra = `in=${a["gen_ai.usage.input_tokens"]} out=${a["gen_ai.usage.output_tokens"]} stop=${(a["gen_ai.response.finish_reasons"] as string[])[0]}`;
        } else if ("gen_ai.tool.name" in a) {
          extra = s.error ? `ERROR ${s.error.slice(0, 40)}…` : "ok";
        } else if ("agent.turns" in a) {
          extra = `turns=${a["agent.turns"]} total_in=${a["agent.usage.input_tokens"]} total_out=${a["agent.usage.output_tokens"]}`;
        }
        log(`${"  ".repeat(depth)}${s.name.padEnd(34 - 2 * depth)} ${s.ms.toFixed(1).padStart(7)} ms  ${extra}`);
        walk(s.spanId, depth + 1);
      }
    };

    walk(null, 0);
  }
}

// ---------- 两层包装：模型调用 & 工具调用 ----------
/** 包住任意有 .messages.create 的 client（真的 new Anthropic() 或 FakeAnthropic）。 */
export class TracedClient implements LLMClient {
  inner: LLMClient;
  tracer: Tracer;
  messages: { create: (params: CreateParams) => Promise<Message> };
  pendingToolIds = new Map<string, string[]>(); // 给工具 span 关联 tool_use_id
  turn = 0;
  totalIn = 0;
  totalOut = 0;

  constructor(inner: LLMClient, tracer: Tracer) {
    this.inner = inner;
    this.tracer = tracer;
    this.messages = { create: (params) => this.create(params) };
  }

  create(params: CreateParams): Promise<Message> {
    this.turn += 1;
    const attrs = {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": params.model,
      "gen_ai.request.max_tokens": params.max_tokens ?? 0,
      "agent.turn": this.turn,
      "agent.request.messages": params.messages.length, // 上下文在膨胀：每轮多 2 条
    };
    return this.tracer.span(`chat ${params.model}`, { kind: 3, attrs }, async (s) => {
      const resp = await this.inner.messages.create(params);
      const u = resp.usage;
      Object.assign(s.attrs, {
        "gen_ai.response.id": resp.id,
        "gen_ai.response.model": resp.model,
        "gen_ai.response.finish_reasons": [resp.stop_reason],
        "gen_ai.usage.input_tokens": u.input_tokens,
        "gen_ai.usage.output_tokens": u.output_tokens,
      });
      this.totalIn += u.input_tokens;
      this.totalOut += u.output_tokens;
      for (const b of resp.content) {
        if (b.type === "tool_use") {
          if (!this.pendingToolIds.has(b.name)) this.pendingToolIds.set(b.name, []);
          this.pendingToolIds.get(b.name)!.push(b.id);
        }
      }
      return resp;
    });
  }
}

export function tracedTools(tools: Tools, tracer: Tracer, client: TracedClient): Tools {
  const wrap =
    (name: string, fn: Tools[string]) =>
    (args: Record<string, unknown>): string => {
      const ids = client.pendingToolIds.get(name) ?? [];
      const attrs = {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": name,
        "gen_ai.tool.call.id": ids.shift() ?? "",
        "gen_ai.tool.call.arguments": JSON.stringify(args).slice(0, 500),
      };
      return tracer.span(`execute_tool ${name}`, { attrs }, (s) => {
        const out = fn(args);
        s.attrs["tool.result.chars"] = out.length;
        return out;
      });
    };

  return Object.fromEntries(Object.entries(tools).map(([n, f]) => [n, wrap(n, f)]));
}

export async function runTraced(
  client: LLMClient,
  task: string,
  cwd: string,
  tracer: Tracer,
  opts: Omit<Parameters<typeof runAgent>[3], "tools"> = {},
): Promise<string> {
  const tc = new TracedClient(client, tracer);
  const attrs = { "gen_ai.operation.name": "invoke_agent", "agent.task": task };
  return tracer.span("invoke_agent coding_agent", { attrs }, async (root) => {
    const out = await runAgent(tc, task, cwd, { ...opts, tools: tracedTools(makeTools(cwd), tracer, tc) });
    Object.assign(root.attrs, {
      "agent.turns": tc.turn,
      "agent.usage.input_tokens": tc.totalIn,
      "agent.usage.output_tokens": tc.totalOut,
    });
    return out;
  });
}

if (import.meta.main) {
  const demo = await import("../coding_agent/demo.ts");
  const { FakeAnthropic, text, toolUse } = await import("../fake_llm/index.ts");

  const script = [ // 让 input_tokens 随轮次增长，模拟真实上下文膨胀
    toolUse("run_command", { command: "node test_calc.mjs" }, { inputTokens: 820, outputTokens: 45 }),
    toolUse("read_file", { path: "calc.mjs" }, { inputTokens: 1010, outputTokens: 30 }),
    toolUse("read_file", { path: "missing.mjs" }, { inputTokens: 1090, outputTokens: 28 }),
    toolUse("write_file", { path: "calc.mjs", content: demo.FIXED }, { inputTokens: 1160, outputTokens: 60 }),
    toolUse("run_command", { command: "node test_calc.mjs" }, { inputTokens: 1250, outputTokens: 40 }),
    text("修好了：a - b → a + b，测试通过。", { inputTokens: 1330, outputTokens: 35 }),
  ];
  const tracer = new Tracer();
  const d = mkdtempSync(join(tmpdir(), "tracer-"));
  try {
    demo.setup(d);
    await runTraced(new FakeAnthropic(script, { latency: 0.08 }), "修好测试", d, tracer, { log: () => {} });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  tracer.printTree();
  const out = join(import.meta.dirname, "trace.json");
  writeFileSync(out, JSON.stringify(tracer.toOtlp(), null, 2));
  const spans = tracer.toOtlp().resourceSpans[0].scopeSpans[0].spans;
  const { attributes, ...firstChat } = spans.find((s: any) => s.name.startsWith("chat"));
  console.log(`\n已写出 ${basename(out)}（${tracer.spans.length} 个 span）。其中第一个 chat span：`);
  const flat = Object.fromEntries(attributes.map((a: any) => [a.key, Object.values(a.value)[0]]));
  console.log(JSON.stringify({ ...firstChat, "attributes(展平显示)": flat }, null, 2));
}
