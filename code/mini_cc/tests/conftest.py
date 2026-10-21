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
