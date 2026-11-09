"""补充章「成本控制与模型路由」：规则路由 vs 级联路由。

- 规则路由：按任务类型查表选模型（分类 / 摘要 / 改写检索词 → Haiku，编码 → Sonnet，规划 → Opus）。
- 级联路由：一律先用最便宜的模型；代码校验不过，就带着同一个请求升级到下一档，直到通过或用完。

八个任务、每个模型答得对不对，都是 fake client 按脚本给的（token 数也是预设的），
目的只是看清两种策略在「成本」和「升级率」上的账怎么算。

离线运行： uv run python -m cost_routing.router
真实运行：把 scripted_client() 换成 anthropic.Anthropic()，校验函数换成真的测试 / schema 校验。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable

from cost_routing.meter import CostMeter, ljust, rjust
from fake_llm import FakeAnthropic

HAIKU, SONNET, OPUS = "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"
LADDER = [HAIKU, SONNET, OPUS]
SHORT = {HAIKU: "haiku", SONNET: "sonnet", OPUS: "opus"}

# 规则路由表：任务类型 → 模型。路由规则本身会改变线上行为，改它要过评测门禁。
RULES: dict[str, str] = {
    "classify": HAIKU,
    "summarize": HAIKU,
    "rewrite_query": HAIKU,
    "extract": HAIKU,
    "code": SONNET,
    "plan": OPUS,
}


def _json(s: str) -> Any:
    try:
        return json.loads(s)
    except ValueError:
        return None


# 校验器：只用代码判，不再调模型。真实项目里是跑测试、schema 校验、正则红线。
def check_label(s: str) -> bool:
    return s.strip() in {"bug", "feature", "question"}


def check_summary(s: str) -> bool:
    return 0 < len(s) <= 40


def check_query(s: str) -> bool:
    return 0 < len(s) <= 30 and not any(w in s for w in ("那个", "上次", "上周"))


def check_location(s: str) -> bool:
    d = _json(s)
    return isinstance(d, dict) and isinstance(d.get("file"), str) and isinstance(d.get("line"), int)


def check_plan(s: str) -> bool:
    d = _json(s)
    return isinstance(d, list) and len(d) >= 3 and all(isinstance(x, dict) and x.get("verify") for x in d)


def check_patch(s: str) -> bool:
    # 演示用：真实场景是把补丁打上去跑测试，这里用 fake 回答里约定的测试结果字段代替
    d = _json(s)
    return isinstance(d, dict) and bool(d.get("diff")) and d.get("tests") == "pass"


@dataclass(frozen=True)
class Task:
    id: str
    kind: str
    prompt: str
    check: Callable[[str], bool]
    input_tokens: int
    output_tokens: int
    daily: int  # 每天大约多少次这类调用，用来把单次成本折算成日成本


TASKS = [
    Task("t1", "classify", "给 issue 打标签：登录按钮点了没反应", check_label, 400, 10, 3_000),
    Task("t2", "classify", "给 issue 打标签：能不能加个暗色模式", check_label, 400, 10, 3_000),
    Task("t3", "summarize", "用一句话总结这个 PR 的改动", check_summary, 1_500, 60, 800),
    Task("t4", "rewrite_query", "把「上周那个缓存的问题」改写成检索词", check_query, 300, 20, 1_500),
    Task("t5", "extract", "从这段堆栈里抽出出错的文件和行号", check_location, 800, 40, 400),
    Task("t6", "code", "修复 useDebounce 在卸载后仍触发回调的问题", check_patch, 3_000, 600, 60),
    Task("t7", "plan", "规划把 webapp 的状态管理从 Redux 迁到 Zustand", check_plan, 2_000, 400, 20),
    Task("t8", "code", "修复 SSR 和客户端时区不一致导致的 hydration 报错", check_patch, 6_000, 1_200, 20),
]

GOOD_PLAN = json.dumps([{"step": s, "verify": v} for s, v in [
    ("盘点 store 和 selector", "列表与代码 grep 结果一致"),
    ("新建 Zustand store 并双写", "两边状态快照一致"),
    ("逐页切换读路径", "页面 e2e 通过"),
    ("删除 Redux", "构建无引用、测试全绿"),
]], ensure_ascii=False)

# 每个任务的「好答案」和「差答案」；FAILS_ON 记录哪些模型在这个任务上会给差答案
ANSWERS: dict[str, tuple[str, str]] = {
    "t1": ("bug", "这看起来像是一个 bug"),
    "t2": ("feature", "feature"),
    "t3": ("useDebounce 卸载时清理定时器", ""),
    "t4": ("缓存 失效 排查", "上周那个缓存的问题"),
    "t5": ('{"file": "src/api/client.ts", "line": 42}', '{"file": "src/api/client.ts", "line": "42"}'),
    "t6": ('{"diff": "+ return () => clearTimeout(t)", "tests": "pass"}', '{"diff": "+ if (!mounted) return", "tests": "fail"}'),
    "t7": (GOOD_PLAN, json.dumps([{"step": "换成 Zustand"}, {"step": "删 Redux"}], ensure_ascii=False)),
    "t8": ('{"diff": "+ const tz = useServerTimezone()", "tests": "pass"}', '{"diff": "+ suppressHydrationWarning", "tests": "fail"}'),
}
FAILS_ON: dict[str, set[str]] = {  # 没列出的任务，三个模型都答对
    "t5": {HAIKU},
    "t6": {HAIKU},
    "t7": {HAIKU},
    "t8": {HAIKU, SONNET},
}


def scripted_client(tasks: list[Task] = TASKS) -> FakeAnthropic:
    """fake 模型：按 (任务, 模型) 查表回答，usage 用任务预设的 token 数。"""
    by_prompt = {t.prompt: t for t in tasks}

    def respond(params: dict[str, Any]) -> dict[str, Any]:
        t = by_prompt[params["messages"][0]["content"]]
        good, bad = ANSWERS[t.id]
        answer = bad if params["model"] in FAILS_ON.get(t.id, set()) else good
        return {"content": [{"type": "text", "text": answer}], "stop_reason": "end_turn",
                "usage": {"input_tokens": t.input_tokens, "output_tokens": t.output_tokens}}

    return FakeAnthropic([respond] * 100)


@dataclass
class Outcome:
    task: Task
    attempts: list[str] = field(default_factory=list)  # 依次用过的模型
    passed: bool = False
    usd: float = 0.0  # 这条任务一次的总花费，失败的尝试也算在内

    @property
    def escalated(self) -> bool:
        return len(self.attempts) > 1


def _ask(client, model: str, task: Task, meter: CostMeter, tenant: str) -> tuple[str, float]:
    resp = client.messages.create(model=model, max_tokens=1024,
                                  messages=[{"role": "user", "content": task.prompt}])
    usd = meter.add(model, resp.usage, tenant=tenant)
    return "".join(b.text for b in resp.content if b.type == "text"), usd


def route_rule(task: Task) -> str:
    return RULES[task.kind]


def run_fixed(client, tasks: list[Task], meter: CostMeter, pick: Callable[[Task], str],
              *, tenant: str = "default") -> list[Outcome]:
    """每个任务只问一次 pick(task) 选出的模型；校验只用来统计，不触发升级。"""
    out = []
    for t in tasks:
        m = pick(t)
        answer, usd = _ask(client, m, t, meter, tenant)
        out.append(Outcome(t, [m], t.check(answer), usd))
    return out


def run_cascade(client, tasks: list[Task], meter: CostMeter, *, ladder: list[str] = LADDER,
                start: Callable[[Task], str] | None = None, tenant: str = "default") -> list[Outcome]:
    """从 start(task) 选的那一档开始（默认最便宜的一档），校验不过就升级。失败那几次的钱也照算。"""
    out = []
    for t in tasks:
        o = Outcome(t)
        first = ladder.index(start(t)) if start else 0
        for m in ladder[first:]:
            o.attempts.append(m)
            answer, usd = _ask(client, m, t, meter, tenant)
            o.usd += usd
            if t.check(answer):
                o.passed = True
                break
        out.append(o)
    return out


def summarize(name: str, outcomes: list[Outcome]) -> dict[str, Any]:
    """把每类任务的单次结果按日调用量加权，折算成一天的账。"""
    volume = sum(o.task.daily for o in outcomes)
    return {
        "name": name,
        "passed": sum(o.passed for o in outcomes),
        "total": len(outcomes),
        "daily_usd": sum(o.usd * o.task.daily for o in outcomes),
        "pass_rate": sum(o.task.daily for o in outcomes if o.passed) / volume,
        "escalation_rate": sum(o.task.daily for o in outcomes if o.escalated) / volume,
    }


STRATEGIES: list[tuple[str, Callable[[Any, list[Task], CostMeter], list[Outcome]]]] = [
    ("全用 Opus", lambda c, ts, m: run_fixed(c, ts, m, lambda t: OPUS)),
    ("全用 Haiku", lambda c, ts, m: run_fixed(c, ts, m, lambda t: HAIKU)),
    ("规则路由", lambda c, ts, m: run_fixed(c, ts, m, route_rule)),
    ("级联路由", lambda c, ts, m: run_cascade(c, ts, m)),
    ("规则起步+级联", lambda c, ts, m: run_cascade(c, ts, m, start=route_rule)),
]


def compare(tasks: list[Task] = TASKS) -> dict[str, tuple[dict[str, Any], list[Outcome]]]:
    result = {}
    for name, runner in STRATEGIES:
        outcomes = runner(scripted_client(tasks), tasks, CostMeter())
        result[name] = (summarize(name, outcomes), outcomes)
    return result


def main() -> None:
    result = compare()
    print("[离线 fake 模型] 级联路由逐条（任务 / 类型 / 每天调用量 / 依次用过的模型）：")
    for o in result["级联路由"][1]:
        trail = " → ".join(SHORT[m] for m in o.attempts)
        print(f"  {o.task.id} {ljust(o.task.kind, 14)}{o.task.daily:>6,}  {ljust(trail, 24)}{'✔' if o.passed else '✘'}")
    print()
    base = result["全用 Opus"][0]["daily_usd"]
    cols = [("任务通过", 9), ("按调用量通过率", 16), ("每天$", 9), ("相对全 Opus", 13), ("升级率", 8)]
    print(ljust("策略", 16) + "".join(rjust(h, w) for h, w in cols))
    for row, _ in result.values():
        cells = [f"{row['passed']}/{row['total']}", f"{row['pass_rate']:.1%}", f"{row['daily_usd']:.2f}",
                 f"{row['daily_usd'] / base:.0%}", f"{row['escalation_rate']:.1%}"]
        print(ljust(row["name"], 16) + "".join(rjust(c, w) for c, (_, w) in zip(cells, cols)))


if __name__ == "__main__":
    main()
