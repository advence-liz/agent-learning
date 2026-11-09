"""补充章「工具设计」：同一个 webapp 后端，两套写给模型用的工具。

任务：「给张伟最近买的耳机退款」。
  坏工具集：按后端 REST 接口一比一包装（api_get_users / api_get_orders / api_post_refunds），
           原样返回大 JSON，出错把后端的 HTTP 响应和堆栈直接丢给模型。
  好工具集：按任务设计（webapp_find_orders / webapp_refund_order），返回精简文字，
           参数先过 schema 校验，错误信息写清「哪里错、怎么改、下一步调什么」。
两套工具背后是同一份假数据和同一个 refund 函数，差别只在「模型看到什么」。
"""

from __future__ import annotations

import re
from typing import Any, Callable

from tool_design.budget import dumps

TODAY = "2026-11-09"  # 固定「今天」，退款期判断才可复现


# ---------- 假后端：数据 + 一个会抛错的退款接口 ----------

def _hex4(n: int) -> str:
    return format((n * 40503 + 12345) % 65536, "04x")


NAMES = ["李娜", "王芳", "张伟", "刘洋", "陈静", "杨磊", "赵敏", "黄强", "周婷", "吴昊", "徐丽", "孙鹏"]

USERS: list[dict[str, Any]] = [
    {
        "id": f"usr_{_hex4(i)}9c1e-4b7a-8f2d-{_hex4(i * 7)}a0b3e5",
        "name": name,
        "email": f"user{i + 1:02d}@example.com",
        "phone": f"138{i:04d}{(i * 37) % 10000:04d}",
        "created_at": f"2025-{i % 12 + 1:02d}-{(i * 3) % 28 + 1:02d}T08:00:00Z",
        "status": "active",
        "tier": ["free", "plus", "pro"][i % 3],
        "address": {"province": "上海市", "city": "上海市", "district": "浦东新区", "line1": f"世纪大道 {100 + i} 号"},
        "preferences": {"locale": "zh-CN", "currency": "CNY", "marketing_email": i % 2 == 0, "sms": i % 3 == 0},
        "last_login_ip": f"10.0.{i}.{i * 7 % 255}",
    }
    for i, name in enumerate(NAMES)
]

_ZW = USERS[2]  # 张伟

# (订单号, 下单日, 商品, 实付分, 退款截止日)
_ORDER_ROWS = [
    ("1042", "2026-10-30", "降噪耳机 Pro", 89900, "2026-11-13"),
    ("1038", "2026-10-21", "机械键盘", 59900, "2026-11-04"),
    ("1011", "2026-09-15", "显示器支架", 19900, "2026-09-29"),
    ("0987", "2026-08-12", "运动耳机", 29900, "2026-08-26"),
    ("0950", "2026-07-03", "USB-C 扩展坞", 39900, "2026-07-17"),
    ("0901", "2026-05-20", "手机壳", 4900, "2026-06-03"),
]

ORDERS: list[dict[str, Any]] = [
    {
        "id": f"ord_{_hex4(100 + k)}{_hex4(200 + k)}-{_hex4(300 + k)}",
        "number": f"ORD-{num}",
        "user_id": _ZW["id"],
        "created_at": f"{day}T10:24:00Z",
        "status": "delivered",
        "items": [{"sku": f"SKU-{_hex4(400 + k).upper()}", "title": title, "qty": 1,
                   "unit_price_cents": cents, "warehouse": "WH-SH-03"}],
        "payment": {"method": "card", "txn_id": f"txn_{_hex4(500 + k)}{_hex4(600 + k)}", "captured_cents": cents},
        "shipping": {"carrier": "SF", "tracking": f"SF14{_hex4(700 + k)}{_hex4(800 + k)}".upper(),
                     "address": _ZW["address"]},
        "refundable_until": until,
        "refunds": [],
    }
    for k, (num, day, title, cents, until) in enumerate(_ORDER_ROWS)
]

REASONS = ["damaged", "not_as_described", "no_longer_needed", "other"]


class BackendError(Exception):
    """后端原样返回的错误：HTTP 状态 + 错误码 + 服务端堆栈，给人排查用，不是给模型看的。"""

    def __init__(self, code: str):
        self.code = code
        trace = (f"RefundValidationError: {code}\\n"
                 "    at validateRefund (/srv/payments/refund.js:88:11)\\n"
                 "    at RefundController.create (/srv/payments/controller.js:41:5)\\n"
                 "    at Layer.handle (/srv/node_modules/express/lib/router/layer.js:95:5)")
        super().__init__(f'HTTP 422 Unprocessable Entity\n{{"code":"{code}","trace":"{trace}"}}')


def backend_refund(order_id: str, amount_cents: int, reason: str) -> dict[str, Any]:
    order = next((o for o in ORDERS if o["id"] == order_id), None)
    if order is None:
        raise BackendError("E_REFUND_4001")  # 订单不存在
    if not isinstance(amount_cents, int) or isinstance(amount_cents, bool) or not 0 < amount_cents <= order["payment"]["captured_cents"]:
        raise BackendError("E_REFUND_4002")  # 金额非法
    if reason not in REASONS:
        raise BackendError("E_REFUND_4003")  # 原因不在枚举里
    if TODAY > order["refundable_until"]:
        raise BackendError("E_REFUND_4004")  # 过了退款期
    refund = {"id": f"rfd_{order['number'][4:]}_{len(order['refunds']) + 1}", "order_id": order_id,
              "amount_cents": amount_cents, "reason": reason, "status": "pending", "created_at": f"{TODAY}T12:00:00Z"}
    order["refunds"].append(refund)
    return refund


def reset_backend() -> None:
    """演示和测试之间清掉退款记录。"""
    for o in ORDERS:
        o["refunds"].clear()


# ---------- 坏工具集：后端接口一比一包装 ----------

BAD_TOOLS: list[dict[str, Any]] = [
    {"name": "api_get_users", "description": "GET /users",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "api_get_orders", "description": "GET /users/{user_id}/orders",
     "input_schema": {"type": "object", "properties": {"user_id": {"type": "string"}}, "required": ["user_id"]}},
    {"name": "api_post_refunds", "description": "POST /refunds",
     "input_schema": {"type": "object",
                      "properties": {"order_id": {"type": "string"}, "amount": {"type": "number"},
                                     "reason": {"type": "string"}},
                      "required": ["order_id", "amount", "reason"]}},
]

BAD_HANDLERS: dict[str, Callable[..., str]] = {
    "api_get_users": lambda: dumps(USERS),
    "api_get_orders": lambda user_id: dumps([o for o in ORDERS if o["user_id"] == user_id]),
    # 后端抛的 BackendError 不接，循环会把它的原文（HTTP 响应 + 堆栈）当工具结果回给模型
    "api_post_refunds": lambda order_id, amount, reason: dumps(backend_refund(order_id, amount, reason)),
}


# ---------- 好工具集：按任务设计 ----------

class ToolError(Exception):
    """要回给模型的错误：消息本身就是写给模型看的「改法」。"""


def format_tool_error(what: str, problems: list[str], next_step: str) -> str:
    lines = [f"{what}："] + [f"- {p}" for p in problems] + [next_step]
    return "\n".join(lines)


def validate(schema: dict[str, Any], args: dict[str, Any]) -> list[str]:
    """最小 JSON Schema 校验：required / type / enum / pattern / minimum / maximum / additionalProperties=false。

    返回的每一条都要能直接指导模型改参数，所以带上收到的值和该怎么填。
    """
    props: dict[str, Any] = schema.get("properties", {})
    problems: list[str] = []
    if schema.get("additionalProperties") is False:
        for k in args:
            if k not in props:
                problems.append(f"不认识的参数 {k}（只接受：{'、'.join(props)}）")
    for k, spec in props.items():
        if k not in args:
            if k in schema.get("required", []):
                problems.append(f"缺少必填参数 {k}：{spec.get('description', '')}")
            continue
        v = args[k]
        t = spec.get("type")
        ok = {
            "string": isinstance(v, str),
            "integer": isinstance(v, int) and not isinstance(v, bool),
            "number": isinstance(v, (int, float)) and not isinstance(v, bool),
            "boolean": isinstance(v, bool),
        }.get(t, True)
        if not ok:
            problems.append(f"{k} 应为 {t}，收到 {dumps(v)}")
            continue
        if "enum" in spec and v not in spec["enum"]:
            problems.append(f"{k}={dumps(v)} 不在可选值里，可选：{' / '.join(spec['enum'])}")
        if "pattern" in spec and not re.fullmatch(spec["pattern"], v):
            problems.append(f"{k}={dumps(v)} 格式不对。{spec.get('description', '')}")
        if "minimum" in spec and v < spec["minimum"] or "maximum" in spec and v > spec["maximum"]:
            problems.append(f"{k}={dumps(v)} 超出范围 [{spec.get('minimum')}, {spec.get('maximum')}]")
    return problems


FIND_ORDERS_SCHEMA = {
    "type": "object",
    "properties": {
        "customer": {"type": "string", "description": "客户姓名或邮箱，例如「张伟」或 user03@example.com"},
        "query": {"type": "string", "description": "可选，按商品名过滤的关键词，例如「耳机」"},
        "limit": {"type": "integer", "minimum": 1, "maximum": 20, "description": "每页条数，默认 5"},
        "offset": {"type": "integer", "minimum": 0, "maximum": 1000, "description": "翻页偏移，默认 0"},
        "response_format": {"type": "string", "enum": ["concise", "detailed"],
                            "description": "concise（默认）每单一行；detailed 额外给出 SKU、物流单号、内部 ID"},
    },
    "required": ["customer"],
    "additionalProperties": False,
}

REFUND_SCHEMA = {
    "type": "object",
    "properties": {
        "order_number": {"type": "string", "pattern": r"ORD-\d{4}",
                         "description": "订单号，形如 ORD-1042，从 webapp_find_orders 的结果里原样复制，不要自己编"},
        "reason": {"type": "string", "enum": REASONS,
                   "description": "damaged=商品损坏或故障；not_as_described=与描述不符；no_longer_needed=不想要了；other=其他"},
        "amount_yuan": {"type": "number", "minimum": 0.01, "maximum": 100000,
                        "description": "部分退款时填，单位元，例如 99.5；全额退款不要填"},
    },
    "required": ["order_number", "reason"],
    "additionalProperties": False,
}

GOOD_TOOLS: list[dict[str, Any]] = [
    {
        "name": "webapp_find_orders",
        "description": (
            "按客户查 webapp 的订单，按下单时间倒序。用户提到某人的订单、要退款或查物流时，先用它拿到订单号。"
            "只读，不会修改任何数据。不用于查商品库存或客户资料。"
            "结果默认每单一行（订单号 · 日期 · 商品 · 实付 · 是否可退款），超过 limit 时末尾会提示怎么翻页。"
        ),
        "input_schema": FIND_ORDERS_SCHEMA,
    },
    {
        "name": "webapp_refund_order",
        "description": (
            "给一笔订单发起退款，会真实退钱，调用前确认订单号和金额。"
            "订单号必须来自 webapp_find_orders 的结果。不填 amount_yuan 就是全额退款。"
            "已过退款期的订单会被拒绝，这时不要换参数重试，告诉用户需要人工客服处理。"
        ),
        "input_schema": REFUND_SCHEMA,
    },
]


def yuan(cents: int) -> str:
    return f"¥{cents // 100}.{cents % 100:02d}"


def _match_customer(customer: str) -> list[dict[str, Any]]:
    return [u for u in USERS if customer in (u["name"], u["email"])]


def find_orders(customer: str, query: str = "", limit: int = 5, offset: int = 0,
                response_format: str = "concise") -> str:
    users = _match_customer(customer)
    if not users:
        raise ToolError(format_tool_error(
            f"没找到客户「{customer}」", ["customer 只按姓名或邮箱精确匹配"],
            "请确认姓名有没有错字，或改用邮箱再查。"))
    u = users[0]
    hits = [o for o in ORDERS if o["user_id"] == u["id"] and query in o["items"][0]["title"]]
    if not hits:
        return f"{u['name']}（{u['email']}）没有匹配「{query}」的订单。去掉 query 可以看全部订单。"
    page = hits[offset:offset + limit]
    cond = f"，匹配「{query}」" if query else ""
    lines = [f"{u['name']}（{u['email']}）的订单{cond}，共 {len(hits)} 笔，按下单时间倒序："]
    for o in page:
        item = o["items"][0]
        ok = "可退款" if TODAY <= o["refundable_until"] else "已过退款期"
        lines.append(f"{o['number']} · {o['created_at'][:10]} · {item['title']} ×{item['qty']} · "
                     f"{yuan(o['payment']['captured_cents'])} · {ok}")
        if response_format == "detailed":
            lines.append(f"  SKU {item['sku']} · 物流 {o['shipping']['carrier']} {o['shipping']['tracking']} · "
                         f"退款截止 {o['refundable_until']} · 内部 ID {o['id']}")
    rest = len(hits) - offset - len(page)
    if rest > 0:
        lines.append(f"还有 {rest} 笔没列出：传 offset={offset + len(page)} 看下一页，或加 query 缩小范围。")
    return "\n".join(lines)


_BACKEND_HINTS = {
    "E_REFUND_4002": "金额超过了实付金额。全额退款不要填 amount_yuan。",
    "E_REFUND_4003": "退款原因不被接受。reason 只能从 damaged / not_as_described / no_longer_needed / other 里选。",
}


def refund_order(order_number: str, reason: str, amount_yuan: float | None = None) -> str:
    order = next((o for o in ORDERS if o["number"] == order_number), None)
    if order is None:
        raise ToolError(format_tool_error(
            f"没找到订单 {order_number}，这次没有执行退款", ["订单号要和 webapp_find_orders 结果里的一字不差"],
            "先调 webapp_find_orders 查到订单号，再重试。"))
    paid = order["payment"]["captured_cents"]
    cents = paid if amount_yuan is None else int(amount_yuan * 100 + 0.5)
    try:
        backend_refund(order["id"], cents, reason)  # 模型只给订单号和元；内部 ID、分这些换算在代码里做
    except BackendError as e:
        if e.code == "E_REFUND_4004":
            raise ToolError(format_tool_error(
                f"{order_number} 不能自助退款", [f"已过退款期（截至 {order['refundable_until']}）"],
                "不要换参数重试。告诉用户这笔需要转人工客服处理。")) from None
        raise ToolError(format_tool_error(
            f"{order_number} 退款失败", [_BACKEND_HINTS.get(e.code, f"后端错误 {e.code}")],
            "按上面改好参数后再调一次。")) from None
    kind = "全额" if cents == paid else "部分"
    return (f"已提交退款：{order_number} · {order['items'][0]['title']} · 退 {yuan(cents)}（{kind}）· "
            f"原因 {reason}。预计 3–5 个工作日原路退回。")


def checked(schema: dict[str, Any], fn: Callable[..., str]) -> Callable[..., str]:
    """硬约束放代码：参数不合 schema 就不执行，回一条能照着改的错误。"""

    def run(**args: Any) -> str:
        problems = validate(schema, args)
        if problems:
            raise ToolError(format_tool_error("参数有误，这次没有执行", problems,
                                              "按上面逐条改好再调；不确定订单号就先调 webapp_find_orders。"))
        return fn(**args)

    return run


GOOD_HANDLERS: dict[str, Callable[..., str]] = {
    "webapp_find_orders": checked(FIND_ORDERS_SCHEMA, find_orders),
    "webapp_refund_order": checked(REFUND_SCHEMA, refund_order),
}
