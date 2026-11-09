/**
 * 补充章「工具设计」：同一个 webapp 后端，两套写给模型用的工具。
 *
 * 任务：「给张伟最近买的耳机退款」。
 *   坏工具集：按后端 REST 接口一比一包装（api_get_users / api_get_orders / api_post_refunds），
 *            原样返回大 JSON，出错把后端的 HTTP 响应和堆栈直接丢给模型。
 *   好工具集：按任务设计（webapp_find_orders / webapp_refund_order），返回精简文字，
 *            参数先过 schema 校验，错误信息写清「哪里错、怎么改、下一步调什么」。
 * 两套工具背后是同一份假数据和同一个 refund 函数，差别只在「模型看到什么」。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { dumps } from "./budget.ts";

export const TODAY = "2026-11-09"; // 固定「今天」，退款期判断才可复现

type Args = Record<string, any>;
export type Handler = (args: Args) => string;

// ---------- 假后端：数据 + 一个会抛错的退款接口 ----------

const hex4 = (n: number) => ((n * 40503 + 12345) % 65536).toString(16).padStart(4, "0");
const pad = (n: number, w: number) => String(n).padStart(w, "0");

const NAMES = ["李娜", "王芳", "张伟", "刘洋", "陈静", "杨磊", "赵敏", "黄强", "周婷", "吴昊", "徐丽", "孙鹏"];

export const USERS = NAMES.map((name, i) => ({
  id: `usr_${hex4(i)}9c1e-4b7a-8f2d-${hex4(i * 7)}a0b3e5`,
  name,
  email: `user${pad(i + 1, 2)}@example.com`,
  phone: `138${pad(i, 4)}${pad((i * 37) % 10000, 4)}`,
  created_at: `2025-${pad((i % 12) + 1, 2)}-${pad(((i * 3) % 28) + 1, 2)}T08:00:00Z`,
  status: "active",
  tier: ["free", "plus", "pro"][i % 3],
  address: { province: "上海市", city: "上海市", district: "浦东新区", line1: `世纪大道 ${100 + i} 号` },
  preferences: { locale: "zh-CN", currency: "CNY", marketing_email: i % 2 === 0, sms: i % 3 === 0 },
  last_login_ip: `10.0.${i}.${(i * 7) % 255}`,
}));

const ZW = USERS[2]; // 张伟

// [订单号, 下单日, 商品, 实付分, 退款截止日]
const ORDER_ROWS: Array<[string, string, string, number, string]> = [
  ["1042", "2026-10-30", "降噪耳机 Pro", 89900, "2026-11-13"],
  ["1038", "2026-10-21", "机械键盘", 59900, "2026-11-04"],
  ["1011", "2026-09-15", "显示器支架", 19900, "2026-09-29"],
  ["0987", "2026-08-12", "运动耳机", 29900, "2026-08-26"],
  ["0950", "2026-07-03", "USB-C 扩展坞", 39900, "2026-07-17"],
  ["0901", "2026-05-20", "手机壳", 4900, "2026-06-03"],
];

export interface Refund {
  id: string;
  order_id: string;
  amount_cents: number;
  reason: string;
  status: string;
  created_at: string;
}

export const ORDERS = ORDER_ROWS.map(([num, day, title, cents, until], k) => ({
  id: `ord_${hex4(100 + k)}${hex4(200 + k)}-${hex4(300 + k)}`,
  number: `ORD-${num}`,
  user_id: ZW.id,
  created_at: `${day}T10:24:00Z`,
  status: "delivered",
  items: [{ sku: `SKU-${hex4(400 + k).toUpperCase()}`, title, qty: 1, unit_price_cents: cents, warehouse: "WH-SH-03" }],
  payment: { method: "card", txn_id: `txn_${hex4(500 + k)}${hex4(600 + k)}`, captured_cents: cents },
  shipping: { carrier: "SF", tracking: `SF14${hex4(700 + k)}${hex4(800 + k)}`.toUpperCase(), address: ZW.address },
  refundable_until: until,
  refunds: [] as Refund[],
}));

export const REASONS = ["damaged", "not_as_described", "no_longer_needed", "other"];

/** 后端原样返回的错误：HTTP 状态 + 错误码 + 服务端堆栈，给人排查用，不是给模型看的。 */
export class BackendError extends Error {
  code: string;
  constructor(code: string) {
    const trace =
      `RefundValidationError: ${code}\\n` +
      "    at validateRefund (/srv/payments/refund.js:88:11)\\n" +
      "    at RefundController.create (/srv/payments/controller.js:41:5)\\n" +
      "    at Layer.handle (/srv/node_modules/express/lib/router/layer.js:95:5)";
    super(`HTTP 422 Unprocessable Entity\n{"code":"${code}","trace":"${trace}"}`);
    this.code = code;
  }
}

export function backendRefund(orderId: string, amountCents: unknown, reason: string): Refund {
  const order = ORDERS.find((o) => o.id === orderId);
  if (!order) throw new BackendError("E_REFUND_4001"); // 订单不存在
  if (!Number.isInteger(amountCents) || !((amountCents as number) > 0 && (amountCents as number) <= order.payment.captured_cents))
    throw new BackendError("E_REFUND_4002"); // 金额非法
  if (!REASONS.includes(reason)) throw new BackendError("E_REFUND_4003"); // 原因不在枚举里
  if (TODAY > order.refundable_until) throw new BackendError("E_REFUND_4004"); // 过了退款期
  const refund: Refund = {
    id: `rfd_${order.number.slice(4)}_${order.refunds.length + 1}`,
    order_id: orderId,
    amount_cents: amountCents as number,
    reason,
    status: "pending",
    created_at: `${TODAY}T12:00:00Z`,
  };
  order.refunds.push(refund);
  return refund;
}

/** 演示和测试之间清掉退款记录。 */
export function resetBackend(): void {
  for (const o of ORDERS) o.refunds.length = 0;
}

// ---------- 坏工具集：后端接口一比一包装 ----------

export const BAD_TOOLS: Anthropic.Tool[] = [
  { name: "api_get_users", description: "GET /users", input_schema: { type: "object", properties: {} } },
  {
    name: "api_get_orders",
    description: "GET /users/{user_id}/orders",
    input_schema: { type: "object", properties: { user_id: { type: "string" } }, required: ["user_id"] },
  },
  {
    name: "api_post_refunds",
    description: "POST /refunds",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string" }, amount: { type: "number" }, reason: { type: "string" } },
      required: ["order_id", "amount", "reason"],
    },
  },
];

export const BAD_HANDLERS: Record<string, Handler> = {
  api_get_users: () => dumps(USERS),
  api_get_orders: ({ user_id }) => dumps(ORDERS.filter((o) => o.user_id === user_id)),
  // 后端抛的 BackendError 不接，循环会把它的原文（HTTP 响应 + 堆栈）当工具结果回给模型
  api_post_refunds: ({ order_id, amount, reason }) => dumps(backendRefund(order_id, amount, reason)),
};

// ---------- 好工具集：按任务设计 ----------

/** 要回给模型的错误：消息本身就是写给模型看的「改法」。 */
export class ToolError extends Error {}

export function formatToolError(what: string, problems: string[], nextStep: string): string {
  return [`${what}：`, ...problems.map((p) => `- ${p}`), nextStep].join("\n");
}

interface PropSpec {
  type?: string;
  description?: string;
  enum?: string[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
}
interface Schema {
  type: "object";
  properties: Record<string, PropSpec>;
  required?: string[];
  additionalProperties?: boolean;
  [k: string]: unknown; // 和 SDK 的 Tool.InputSchema 兼容，可以直接放进 input_schema
}

/**
 * 最小 JSON Schema 校验：required / type / enum / pattern / minimum / maximum / additionalProperties=false。
 * 返回的每一条都要能直接指导模型改参数，所以带上收到的值和该怎么填。
 */
export function validate(schema: Schema, args: Args): string[] {
  const props = schema.properties;
  const problems: string[] = [];
  if (schema.additionalProperties === false) {
    for (const k of Object.keys(args))
      if (!(k in props)) problems.push(`不认识的参数 ${k}（只接受：${Object.keys(props).join("、")}）`);
  }
  for (const [k, spec] of Object.entries(props)) {
    if (!(k in args)) {
      if (schema.required?.includes(k)) problems.push(`缺少必填参数 ${k}：${spec.description ?? ""}`);
      continue;
    }
    const v = args[k];
    const t = spec.type;
    const ok =
      t === "string" ? typeof v === "string"
      : t === "integer" ? Number.isInteger(v)
      : t === "number" ? typeof v === "number"
      : t === "boolean" ? typeof v === "boolean"
      : true;
    if (!ok) {
      problems.push(`${k} 应为 ${t}，收到 ${dumps(v)}`);
      continue;
    }
    if (spec.enum && !spec.enum.includes(v)) problems.push(`${k}=${dumps(v)} 不在可选值里，可选：${spec.enum.join(" / ")}`);
    if (spec.pattern && !new RegExp(`^(?:${spec.pattern})$`).test(v))
      problems.push(`${k}=${dumps(v)} 格式不对。${spec.description ?? ""}`);
    if ((spec.minimum !== undefined && v < spec.minimum) || (spec.maximum !== undefined && v > spec.maximum))
      problems.push(`${k}=${dumps(v)} 超出范围 [${spec.minimum}, ${spec.maximum}]`);
  }
  return problems;
}

export const FIND_ORDERS_SCHEMA: Schema = {
  type: "object",
  properties: {
    customer: { type: "string", description: "客户姓名或邮箱，例如「张伟」或 user03@example.com" },
    query: { type: "string", description: "可选，按商品名过滤的关键词，例如「耳机」" },
    limit: { type: "integer", minimum: 1, maximum: 20, description: "每页条数，默认 5" },
    offset: { type: "integer", minimum: 0, maximum: 1000, description: "翻页偏移，默认 0" },
    response_format: {
      type: "string",
      enum: ["concise", "detailed"],
      description: "concise（默认）每单一行；detailed 额外给出 SKU、物流单号、内部 ID",
    },
  },
  required: ["customer"],
  additionalProperties: false,
};

export const REFUND_SCHEMA: Schema = {
  type: "object",
  properties: {
    order_number: {
      type: "string",
      pattern: "ORD-\\d{4}",
      description: "订单号，形如 ORD-1042，从 webapp_find_orders 的结果里原样复制，不要自己编",
    },
    reason: {
      type: "string",
      enum: REASONS,
      description: "damaged=商品损坏或故障；not_as_described=与描述不符；no_longer_needed=不想要了；other=其他",
    },
    amount_yuan: {
      type: "number",
      minimum: 0.01,
      maximum: 100000,
      description: "部分退款时填，单位元，例如 99.5；全额退款不要填",
    },
  },
  required: ["order_number", "reason"],
  additionalProperties: false,
};

export const GOOD_TOOLS: Anthropic.Tool[] = [
  {
    name: "webapp_find_orders",
    description:
      "按客户查 webapp 的订单，按下单时间倒序。用户提到某人的订单、要退款或查物流时，先用它拿到订单号。" +
      "只读，不会修改任何数据。不用于查商品库存或客户资料。" +
      "结果默认每单一行（订单号 · 日期 · 商品 · 实付 · 是否可退款），超过 limit 时末尾会提示怎么翻页。",
    input_schema: FIND_ORDERS_SCHEMA,
  },
  {
    name: "webapp_refund_order",
    description:
      "给一笔订单发起退款，会真实退钱，调用前确认订单号和金额。" +
      "订单号必须来自 webapp_find_orders 的结果。不填 amount_yuan 就是全额退款。" +
      "已过退款期的订单会被拒绝，这时不要换参数重试，告诉用户需要人工客服处理。",
    input_schema: REFUND_SCHEMA,
  },
];

export const yuan = (cents: number) => `¥${Math.floor(cents / 100)}.${pad(cents % 100, 2)}`;

export function findOrders({ customer, query = "", limit = 5, offset = 0, response_format = "concise" }: Args): string {
  const users = USERS.filter((u) => customer === u.name || customer === u.email);
  if (!users.length)
    throw new ToolError(
      formatToolError(`没找到客户「${customer}」`, ["customer 只按姓名或邮箱精确匹配"], "请确认姓名有没有错字，或改用邮箱再查。"),
    );
  const u = users[0];
  const hits = ORDERS.filter((o) => o.user_id === u.id && o.items[0].title.includes(query));
  if (!hits.length) return `${u.name}（${u.email}）没有匹配「${query}」的订单。去掉 query 可以看全部订单。`;
  const page = hits.slice(offset, offset + limit);
  const cond = query ? `，匹配「${query}」` : "";
  const lines = [`${u.name}（${u.email}）的订单${cond}，共 ${hits.length} 笔，按下单时间倒序：`];
  for (const o of page) {
    const item = o.items[0];
    const ok = TODAY <= o.refundable_until ? "可退款" : "已过退款期";
    lines.push(
      `${o.number} · ${o.created_at.slice(0, 10)} · ${item.title} ×${item.qty} · ${yuan(o.payment.captured_cents)} · ${ok}`,
    );
    if (response_format === "detailed")
      lines.push(
        `  SKU ${item.sku} · 物流 ${o.shipping.carrier} ${o.shipping.tracking} · ` +
          `退款截止 ${o.refundable_until} · 内部 ID ${o.id}`,
      );
  }
  const rest = hits.length - offset - page.length;
  if (rest > 0) lines.push(`还有 ${rest} 笔没列出：传 offset=${offset + page.length} 看下一页，或加 query 缩小范围。`);
  return lines.join("\n");
}

const BACKEND_HINTS: Record<string, string> = {
  E_REFUND_4002: "金额超过了实付金额。全额退款不要填 amount_yuan。",
  E_REFUND_4003: "退款原因不被接受。reason 只能从 damaged / not_as_described / no_longer_needed / other 里选。",
};

export function refundOrder({ order_number, reason, amount_yuan }: Args): string {
  const order = ORDERS.find((o) => o.number === order_number);
  if (!order)
    throw new ToolError(
      formatToolError(
        `没找到订单 ${order_number}，这次没有执行退款`,
        ["订单号要和 webapp_find_orders 结果里的一字不差"],
        "先调 webapp_find_orders 查到订单号，再重试。",
      ),
    );
  const paid = order.payment.captured_cents;
  const cents = amount_yuan === undefined ? paid : Math.floor(amount_yuan * 100 + 0.5);
  try {
    backendRefund(order.id, cents, reason); // 模型只给订单号和元；内部 ID、分这些换算在代码里做
  } catch (e) {
    if (!(e instanceof BackendError)) throw e;
    if (e.code === "E_REFUND_4004")
      throw new ToolError(
        formatToolError(
          `${order_number} 不能自助退款`,
          [`已过退款期（截至 ${order.refundable_until}）`],
          "不要换参数重试。告诉用户这笔需要转人工客服处理。",
        ),
      );
    throw new ToolError(
      formatToolError(`${order_number} 退款失败`, [BACKEND_HINTS[e.code] ?? `后端错误 ${e.code}`], "按上面改好参数后再调一次。"),
    );
  }
  const kind = cents === paid ? "全额" : "部分";
  return (
    `已提交退款：${order_number} · ${order.items[0].title} · 退 ${yuan(cents)}（${kind}）· ` +
    `原因 ${reason}。预计 3–5 个工作日原路退回。`
  );
}

/** 硬约束放代码：参数不合 schema 就不执行，回一条能照着改的错误。 */
export function checked(schema: Schema, fn: Handler): Handler {
  return (args) => {
    const problems = validate(schema, args);
    if (problems.length)
      throw new ToolError(
        formatToolError("参数有误，这次没有执行", problems, "按上面逐条改好再调；不确定订单号就先调 webapp_find_orders。"),
      );
    return fn(args);
  };
}

export const GOOD_HANDLERS: Record<string, Handler> = {
  webapp_find_orders: checked(FIND_ORDERS_SCHEMA, findOrders),
  webapp_refund_order: checked(REFUND_SCHEMA, refundOrder),
};
