"""第 7 章：同一个任务用 LangGraph 写——把 agent 循环画成一张显式的状态图。

LangGraph 不绑定模型：图里的节点就是普通函数。这里的 "llm" 节点用脚本扮演模型（离线），
真实使用时在节点里调用 anthropic.Anthropic().messages.create(...) 或 langchain-anthropic 即可。
uv run python -m sdk_compare.langgraph_agent
"""

from __future__ import annotations

import operator
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph

FILES = {"calc.py": "def add(a, b):\n    return a - b\n"}
SCRIPT = [
    {"tool": "read_file", "args": {"path": "calc.py"}},
    {"tool": "write_file", "args": {"path": "calc.py", "content": "def add(a, b):\n    return a + b\n"}},
    {"text": "已修复：a - b → a + b"},
]


class State(TypedDict):
    messages: Annotated[list[dict[str, Any]], operator.add]  # reducer：节点返回的列表会被「追加」
    step: int


def llm(state: State) -> dict[str, Any]:
    decision = SCRIPT[state["step"]]
    return {"messages": [{"role": "assistant", **decision}], "step": state["step"] + 1}


def tools(state: State) -> dict[str, Any]:
    call = state["messages"][-1]
    if call["tool"] == "read_file":
        out = FILES[call["args"]["path"]]
    else:
        FILES[call["args"]["path"]] = call["args"]["content"]
        out = "ok"
    return {"messages": [{"role": "tool", "content": out}]}


def route(state: State) -> str:  # 条件边：这就是第 2 章 while 循环里那个 if
    return "tools" if "tool" in state["messages"][-1] else END


g = StateGraph(State)
g.add_node("llm", llm)
g.add_node("tools", tools)
g.add_edge(START, "llm")
g.add_conditional_edges("llm", route, ["tools", END])
g.add_edge("tools", "llm")
app = g.compile()

if __name__ == "__main__":
    for event in app.stream({"messages": [{"role": "user", "content": "修好 calc.py"}], "step": 0}):
        for node, update in event.items():
            print(f"[{node}] {update['messages'][-1]}")
    print(app.get_graph().draw_mermaid())
