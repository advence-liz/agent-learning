"""离线演示：在临时目录里放一个有 bug 的函数，让 fake 模型按脚本走完「读 → 改 → 测 → 总结」。

工具是真的在执行（真的读写文件、真的跑 python），只有「模型的决定」是预先写好的。
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from coding_agent.agent import run_agent
from fake_llm import FakeAnthropic, text, tool_use

BUGGY = "def add(a, b):\n    return a - b\n"
FIXED = "def add(a, b):\n    return a + b\n"
TEST = "from calc import add\nassert add(2, 3) == 5, add(2, 3)\nprint('ok')\n"


def script():
    return [
        tool_use("run_command", {"command": "python test_calc.py"}, say="先跑一下测试看看现状。"),
        tool_use("read_file", {"path": "calc.py"}),
        tool_use("write_file", {"path": "calc.py", "content": FIXED}, say="add 写成了减法，修正。"),
        tool_use("run_command", {"command": "python test_calc.py"}),
        text("修复完成：calc.add 把 `a - b` 改成了 `a + b`，test_calc.py 通过。"),
    ]


def setup(d: Path) -> None:
    (d / "calc.py").write_text(BUGGY)
    (d / "test_calc.py").write_text(TEST)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        setup(d)
        client = FakeAnthropic(script())
        task = "test_calc.py 挂了，帮我修好"
        print(f"❯ {task}")
        final = run_agent(client, task, d)
        print(f"⏺ {final}")
        print("---- 第 2 次请求时 messages 的角色序列 ----")
        print([m["role"] for m in client.calls[1]["messages"]])
        print("---- calc.py 现在的内容 ----")
        print((d / "calc.py").read_text(), end="")
