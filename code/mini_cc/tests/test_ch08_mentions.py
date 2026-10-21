"""第 8 章：@ 引用文件。"""

from prompt_toolkit.document import Document

from mini_cc.mentions import FileMentionCompleter, find_mentions, fuzzy_score, list_project_files, rank
from mini_cc.model import call, say

from .conftest import without_session_context as strip


def test_find_mentions():
    assert find_mentions("看看 @src/app.py 和 @README.md，然后改") == ["src/app.py", "README.md"]
    assert find_mentions("发邮件给 a@b.com") == []          # 邮箱不算
    assert find_mentions('打开 @"my notes.txt" 吧') == ["my notes.txt"]
    assert find_mentions("@a.py @a.py") == ["a.py"]         # 去重


def test_mention_attaches_file_before_user_text(make_app):
    app, client = make_app(say("DEBUG 目前是 True"))
    (app.settings.cwd / "config.py").write_text("DEBUG = True\nPORT = 8000\n")
    app.handle_line("@config.py 里 DEBUG 是多少？")
    content = strip(client.requests[0].messages[0]["content"])
    assert isinstance(content, list) and len(content) == 2
    assert content[0]["text"].startswith("<system-reminder>")
    assert "     1\tDEBUG = True" in content[0]["text"]
    assert content[1] == {"type": "text", "text": "@config.py 里 DEBUG 是多少？"}
    assert "⎿ 已附加 @config.py（2 行）" in app.ui.text


def test_mentioned_file_counts_as_read_so_edit_works(make_app):
    app, client = make_app(
        call("Edit", {"file_path": "config.py", "old_string": "DEBUG = True", "new_string": "DEBUG = False"}),
        say("改好了"))
    (app.settings.cwd / "config.py").write_text("DEBUG = True\n")
    app.handle_line("把 @config.py 的 DEBUG 关掉")
    assert len(client.requests) == 2  # 省掉了一轮 Read
    assert (app.settings.cwd / "config.py").read_text() == "DEBUG = False\n"


def test_unknown_mention_left_alone_and_directory_listed(make_app):
    app, client = make_app(say("ok"))
    (app.settings.cwd / "src").mkdir()
    (app.settings.cwd / "src" / "a.py").write_text("")
    app.handle_line("@nobody 帮我看下 @src")
    content = strip(client.requests[0].messages[0]["content"])
    assert len(content) == 2 and "a.py" in content[0]["text"] and "directory @src" in content[0]["text"]


def test_large_file_truncated(make_app):
    app, client = make_app(say("ok"))
    (app.settings.cwd / "big.log").write_text("".join(f"{i}\n" for i in range(5000)))
    app.handle_line("@big.log 看下")
    text = strip(client.requests[0].messages[0]["content"])[0]["text"]
    assert "showing first 2000 of 5000 lines" in text


def test_resumed_session_title_skips_attachment(make_app):
    app, _ = make_app(say("ok"))
    (app.settings.cwd / "a.py").write_text("x=1\n")
    app.handle_line("@a.py 解释一下")
    assert app.store.list()[0].title == "@a.py 解释一下"


def test_fuzzy_rank():
    files = ["src/components/Button.tsx", "src/utils/format.ts", "README.md", "src/components/button.css"]
    assert rank("btn", files)[:2] == ["src/components/Button.tsx", "src/components/button.css"]
    assert rank("fmt", files)[0] == "src/utils/format.ts"
    assert fuzzy_score("zzz", "README.md") is None


def test_list_files_skips_ignored(tmp_path):
    (tmp_path / "node_modules" / "x").mkdir(parents=True)
    (tmp_path / "node_modules" / "x" / "i.js").write_text("")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("")
    files = list_project_files(tmp_path)
    assert "src/app.py" in files and "src/" in files
    assert not any("node_modules" in f for f in files)


def test_completer(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("")
    (tmp_path / "setup.cfg").write_text("")
    comp = FileMentionCompleter(tmp_path)
    got = [c.text for c in comp.get_completions(Document("看看 @app"), None)]
    assert got[0] == "@src/app.py"
    assert list(comp.get_completions(Document("没有 at 符号"), None)) == []
