"""第 12 章：长期记忆（文件式：MEMORY.md 索引 + 每条记忆一个 markdown）。"""

from mini_cc.cli import App
from mini_cc.memory import MAX_LINES, MemoryStore, slugify
from mini_cc.model import FakeClient, call, say
from mini_cc.ui import BufferUI


def _save(name="commit 前缀", desc="commit message 用 feat/fix 前缀", body="规则：feat: / fix: 开头。"):
    return call("Memory", {"action": "save", "type": "feedback", "name": name, "description": desc, "body": body})


def test_store_save_update_delete(tmp_path):
    store = MemoryStore(tmp_path / "memory")
    path, note = store.save("feedback", "commit 前缀", "用 feat/fix 前缀", "规则正文", slug="commit-prefix")
    assert path.name == "commit-prefix.md" and note == ""
    text = path.read_text()
    assert text.startswith("---\nname: commit 前缀\ndescription: 用 feat/fix 前缀\ntype: feedback\n---\n")
    assert store.index_path.read_text().splitlines()[-1] == "- [commit 前缀](commit-prefix.md) — 用 feat/fix 前缀"
    # 同一个 slug 再存一次 = 更新，索引里不会出现两行
    store.save("feedback", "commit 前缀", "改成 conventional commits", "新正文", slug="commit-prefix")
    assert store.index_path.read_text().count("commit-prefix.md") == 1
    assert "conventional" in store.index_path.read_text()
    assert store.delete("commit-prefix") and not path.exists()
    assert "commit-prefix" not in store.index_path.read_text()
    assert not store.delete("commit-prefix")


def test_slugify_handles_chinese():
    assert slugify("Use pnpm, not npm!") == "use-pnpm-not-npm"
    s = slugify("提交信息加前缀")
    assert s.startswith("memory-") and len(s) == len("memory-") + 8  # 纯中文名退化成稳定的哈希
    assert slugify("提交信息加前缀") == s


def test_index_is_truncated_for_context(tmp_path):
    store = MemoryStore(tmp_path / "memory")
    for i in range(MAX_LINES + 30):
        store.save("project", f"n{i}", "一次性事实", "...", slug=f"n{i}")
    text = store.load_index()
    assert "(n0.md)" in text and f"(n{MAX_LINES + 29}.md)" not in text
    assert "MEMORY.md is truncated" in text
    # 接近上限时，保存结果会提醒模型精简索引
    _, note = store.save("project", "x", "y", "z", slug="x")
    assert "MEMORY.md" in note and "condense" in note


def test_model_saves_memory_without_permission_prompt(make_app):
    app, client = make_app(_save(), say("记住了"))
    app.handle_line("以后 commit message 都加 feat/fix 这类前缀")
    assert "是否允许" not in app.ui.text  # 只写 agent 自己的记忆目录，免审批
    store = app.memory
    assert store.dir.is_relative_to(app.settings.home)
    entries = store.entries()
    assert [e.slug for e in entries] == [slugify("commit 前缀")]
    result = client.requests[1].messages[-1]["content"][0]["content"]
    assert "Saved memory" in result and "future sessions" in result


def test_memory_index_reaches_next_session_system_prompt(make_app, settings):
    app, client = make_app(_save(), say("记住了"))
    app.handle_line("以后 commit 加前缀")
    # 同一个会话里 system 不变（prompt cache 前缀稳定），记忆在下一个会话生效
    assert "commit 前缀" not in client.requests[1].system[-1]["text"]
    app2 = App(settings, FakeClient([say("好")]), ui=BufferUI())
    app2.handle_line("帮我写个 commit message")
    system = "\n".join(b["text"] for b in app2.client.requests[0].system)
    assert "# Memory" in system and "- [commit 前缀]" in system and str(app2.memory.dir) in system
    # /new 也算新会话：system 重新计算
    app.handle_line("/new")
    client.push(say("好"))
    app.handle_line("hi")
    assert "- [commit 前缀]" in client.requests[-1].system[-1]["text"]


def test_memory_shared_by_subdirectories_of_same_repo(tmp_path):
    import subprocess

    repo = tmp_path / "repo"
    (repo / "pkg").mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    a = MemoryStore.for_project(tmp_path / "home", repo)
    b = MemoryStore.for_project(tmp_path / "home", repo / "pkg")
    assert a.dir == b.dir


def test_memory_command_lists_and_deletes(make_app):
    app, _ = make_app(_save(), say("记住了"))
    app.handle_line("记一下 commit 前缀")
    app.handle_line("/memory")
    assert "commit 前缀" in app.ui.text and str(app.memory.dir) in app.ui.text
    app.handle_line(f"/memory rm {slugify('commit 前缀')}")
    assert app.memory.entries() == []


def test_invalid_memory_calls_are_errors(make_app):
    app, client = make_app(
        call("Memory", {"action": "save", "type": "mood", "name": "x", "description": "y", "body": "z"}),
        call("Memory", {"action": "delete", "slug": "nope"}),
        say("ok"))
    app.handle_line("记")
    r1 = client.requests[1].messages[-1]["content"][0]
    r2 = client.requests[2].messages[-1]["content"][0]
    assert r1["is_error"] and r2["is_error"] and "No memory" in r2["content"]
