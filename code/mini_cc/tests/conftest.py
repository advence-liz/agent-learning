import pytest

from mini_cc.cli import App
from mini_cc.config import Settings
from mini_cc.model import FakeClient
from mini_cc.ui import BufferUI


@pytest.fixture
def settings(tmp_path):
    proj = tmp_path / "proj"
    proj.mkdir()
    return Settings(cwd=proj, home=tmp_path / "home")


@pytest.fixture
def make_app(settings):
    def _make(*script, **kw):
        client = FakeClient(list(script))
        app = App(settings, client, ui=BufferUI(), **kw)
        return app, client

    return _make


SESSION_CONTEXT = ("# Project instructions", "# Current date")


def without_session_context(content):
    """去掉第 9 章自动注入的会话级上下文（项目说明、日期），方便早期章节的测试只关注自己的内容。
    剩下只有一个纯文本块时直接返回字符串。"""
    if isinstance(content, str):
        return content
    kept = [b for b in content
            if not (b.get("type") == "text" and b["text"].startswith("<system-reminder>")
                    and any(h in b["text"] for h in SESSION_CONTEXT))]
    if len(kept) == 1 and kept[0].get("type") == "text":
        return kept[0]["text"]
    return kept
