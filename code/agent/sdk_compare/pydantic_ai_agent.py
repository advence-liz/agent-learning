"""第 7 章：同一个「读文件 → 改文件」任务，用 Pydantic AI 写。

离线：FunctionModel 让我们用一个 Python 函数扮演模型（Pydantic AI 官方提供的测试替身）。
真实：把 FunctionModel(...) 换成 "anthropic:claude-opus-5-5" 即可（需要 pip 包 pydantic-ai-slim[anthropic]）。
uv run python -m sdk_compare.pydantic_ai_agent
"""

from __future__ import annotations

import os

os.environ.setdefault("PYDANTIC_AI_NO_BANNER", "1")

from pydantic import BaseModel
from pydantic_ai import Agent
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

FILES = {"calc.py": "def add(a, b):\n    return a - b\n"}


class Report(BaseModel):  # Pydantic AI 的招牌：输出也是带校验的类型
    fixed: bool
    summary: str


def scripted_model(messages, info: AgentInfo) -> ModelResponse:
    returns = [p for m in messages for p in m.parts if isinstance(p, ToolReturnPart)]
    if not returns:
        return ModelResponse(parts=[ToolCallPart("read_file", {"path": "calc.py"})])
    if len(returns) == 1:
        return ModelResponse(parts=[ToolCallPart("write_file", {"path": "calc.py", "content": "def add(a, b):\n    return a + b\n"})])
    # 结构化输出在 Pydantic AI 里也是一个「工具」：模型调用 final_result 交卷
    out_tool = info.output_tools[0].name
    return ModelResponse(parts=[ToolCallPart(out_tool, {"fixed": True, "summary": "把 a - b 改成 a + b"})])


agent = Agent(FunctionModel(scripted_model), instructions="你是编程 Agent。", output_type=Report)


@agent.tool_plain
def read_file(path: str) -> str:
    """读取文件内容。"""
    return FILES[path]


@agent.tool_plain
def write_file(path: str, content: str) -> str:
    """覆盖写入文件。"""
    FILES[path] = content
    return "ok"


if __name__ == "__main__":
    r = agent.run_sync("修好 calc.py")
    print("output:", r.output)
    print("messages:", [type(m).__name__ for m in r.all_messages()])
    print("calc.py:", FILES["calc.py"].splitlines()[1].strip())
    print("usage:", r.usage)
