"""第 7 章：可靠的文件编辑——先读后改、读后未变、唯一匹配、replace_all。"""

import os
import time

import pytest

from mini_cc.tools import ToolContext, ToolRegistry, default_tools


@pytest.fixture
def env(tmp_path):
    reg = ToolRegistry(default_tools())
    ctx = ToolContext(cwd=tmp_path)

    def run(name, **args):
        return reg.execute(name, args, ctx)

    return tmp_path, run, ctx


def test_read_numbers_lines_and_records_state(env):
    root, run, ctx = env
    (root / "a.py").write_text("x = 1\ny = 2\n")
    r = run("Read", file_path="a.py")
    assert r.content == "     1\tx = 1\n     2\ty = 2"
    assert ctx.file_state.get(root / "a.py") is not None


def test_read_offset_limit(env):
    root, run, ctx = env
    (root / "big.txt").write_text("".join(f"line{i}\n" for i in range(1, 101)))
    r = run("Read", file_path="big.txt", offset=50, limit=2)
    assert r.content.startswith("    50\tline50\n    51\tline51")
    assert "[showing lines 50-51 of 100]" in r.content
    assert ctx.file_state.get(root / "big.txt").partial


def test_edit_requires_read_first(env):
    root, run, _ = env
    (root / "a.py").write_text("x = 1\n")
    r = run("Edit", file_path="a.py", old_string="x = 1", new_string="x = 2")
    assert r.is_error and "File has not been read yet" in r.content
    assert (root / "a.py").read_text() == "x = 1\n"


def test_write_existing_requires_read_but_new_file_ok(env):
    root, run, _ = env
    assert not run("Write", file_path="new.txt", content="hi").is_error
    (root / "old.txt").write_text("keep me")
    r = run("Write", file_path="old.txt", content="clobber")
    assert r.is_error and (root / "old.txt").read_text() == "keep me"


def test_stale_file_must_be_reread(env):
    root, run, _ = env
    f = root / "a.py"
    f.write_text("x = 1\n")
    run("Read", file_path="a.py")
    time.sleep(0.01)
    f.write_text("x = 1\n# 你在编辑器里加了一行\n")  # 外部修改
    r = run("Edit", file_path="a.py", old_string="x = 1", new_string="x = 2")
    assert r.is_error and "modified since read" in r.content
    run("Read", file_path="a.py")
    assert not run("Edit", file_path="a.py", old_string="x = 1", new_string="x = 2").is_error
    assert "你在编辑器里加了一行" in f.read_text()  # 外部修改没被覆盖


def test_touch_without_content_change_is_not_stale(env):
    root, run, _ = env
    f = root / "a.py"
    f.write_text("x = 1\n")
    run("Read", file_path="a.py")
    st = f.stat()
    os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 10_000_000))
    assert not run("Edit", file_path="a.py", old_string="x = 1", new_string="x = 2").is_error


def test_unique_match_and_replace_all(env):
    root, run, _ = env
    f = root / "a.py"
    f.write_text("print('a')\nprint('a')\n")
    run("Read", file_path="a.py")
    r = run("Edit", file_path="a.py", old_string="print('a')", new_string="print('b')")
    assert r.is_error and "Found 2 matches" in r.content and "replace_all" in r.content
    r = run("Edit", file_path="a.py", old_string="print('a')", new_string="print('b')", replace_all=True)
    assert not r.is_error and "2 replacements" in r.content
    assert f.read_text() == "print('b')\nprint('b')\n"


def test_more_context_makes_it_unique(env):
    root, run, _ = env
    f = root / "a.py"
    f.write_text("def a():\n    return 1\n\ndef b():\n    return 1\n")
    run("Read", file_path="a.py")
    r = run("Edit", file_path="a.py", old_string="def b():\n    return 1", new_string="def b():\n    return 2")
    assert not r.is_error
    assert f.read_text() == "def a():\n    return 1\n\ndef b():\n    return 2\n"
    assert "     5\t    return 2" in r.content  # 返回改动附近的带行号片段


def test_noop_edit_rejected(env):
    root, run, _ = env
    (root / "a.py").write_text("x\n")
    run("Read", file_path="a.py")
    r = run("Edit", file_path="a.py", old_string="x", new_string="x")
    assert "No changes to make" in r.content


def test_not_found_hints(env):
    root, run, _ = env
    f = root / "a.py"
    f.write_text("def f():\n    return 1\n")
    run("Read", file_path="a.py")
    r = run("Edit", file_path="a.py", old_string="     2\t    return 1", new_string="    return 2")
    assert "line-number prefixes" in r.content
    r = run("Edit", file_path="a.py", old_string="\treturn 1", new_string="\treturn 2")  # 文件里是 4 空格
    assert "indentation" in r.content
    f.write_text("msg = “hi”\n")
    run("Read", file_path="a.py")
    r = run("Edit", file_path="a.py", old_string='msg = "hi"', new_string='msg = "yo"')
    assert "curly quotes" in r.content


def test_crlf_preserved(env):
    root, run, _ = env
    f = root / "win.txt"
    f.write_bytes(b"a\r\nb\r\n")
    run("Read", file_path="win.txt")
    assert not run("Edit", file_path="win.txt", old_string="a\nb", new_string="a\nB").is_error
    assert f.read_bytes() == b"a\r\nB\r\n"


def test_create_with_empty_old_string_and_edit_after_own_write(env):
    root, run, _ = env
    assert not run("Edit", file_path="pkg/new.py", old_string="", new_string="x = 1\n").is_error
    # 自己刚写的文件，接着改不需要重读
    assert not run("Edit", file_path="pkg/new.py", old_string="x = 1", new_string="x = 2").is_error
    assert (root / "pkg/new.py").read_text() == "x = 2\n"


def test_write_hook_called_before_write(env):
    root, run, ctx = env
    seen = []
    ctx.write_hooks.append(lambda p: seen.append((p.name, p.exists())))
    run("Write", file_path="a.txt", content="1")
    assert seen == [("a.txt", False)]


def test_edit_is_an_edit_tool_for_permissions(tmp_path):
    from mini_cc.permissions import ACCEPT_EDITS, PermissionManager
    edit = {t.name: t for t in default_tools()}["Edit"]
    pm = PermissionManager(tmp_path, mode=ACCEPT_EDITS)
    assert pm.decide(edit, {"file_path": "a.py", "old_string": "a", "new_string": "b"}).behavior == "allow"


def test_agent_level_read_then_edit(make_app):
    from mini_cc.model import call, say
    app, client = make_app(
        call("Edit", {"file_path": "app.py", "old_string": "DEBUG = True", "new_string": "DEBUG = False"}),
        call("Read", {"file_path": "app.py"}),
        call("Edit", {"file_path": "app.py", "old_string": "DEBUG = True", "new_string": "DEBUG = False"}),
        say("已关闭 DEBUG"))
    (app.settings.cwd / "app.py").write_text("DEBUG = True\n")
    app.handle_line("关掉 debug")
    first = client.requests[1].messages[-1]["content"][0]
    assert first["is_error"] and "Read it first" in first["content"]
    assert (app.settings.cwd / "app.py").read_text() == "DEBUG = False\n"
