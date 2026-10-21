"""第 20 章：渐进式加载 Skills。"""

import json

from mini_cc.model import call, say
from mini_cc.skills import listing, load_skills, render_body


def _skill(root, name, desc, body, extra=""):
    d = root / name
    (d / "references").mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {desc}\n{extra}---\n{body}")
    (d / "references" / "checklist.md").write_text("# 很长的检查清单\n" + "- item\n" * 200)
    return d


def _setup(settings):
    root = settings.home / "skills"
    _skill(root, "pr-summary", "汇总当前分支的改动写成 PR 描述。触发：写 PR 描述",
           "# PR 描述\n基线分支：$0（默认 main）\n涉及 UI 时查 ${SKILL_DIR}/references/checklist.md\n")
    _skill(root, "release-note", "写发版说明", "# 发版说明\n版本：$ARGUMENTS\n", "disable-model-invocation: true\n")
    _skill(settings.cwd / ".mini_cc" / "skills", "fix-lint", "修 lint 报错", "# 修 lint\n先跑 !`echo eslint-v9`\n")
    return root


def test_discover_and_listing(settings):
    _setup(settings)
    skills = load_skills(settings.cwd, settings.home)
    assert set(skills) == {"pr-summary", "release-note", "fix-lint"}
    assert skills["fix-lint"].scope == "project" and skills["release-note"].model_invocable is False
    text = listing(skills.values(), budget_chars=10_000)
    assert "- pr-summary: 汇总当前分支" in text and "release-note" not in text   # 手动专用的不进目录


def test_listing_budget_drops_descriptions_of_least_used(settings):
    _setup(settings)
    skills = load_skills(settings.cwd, settings.home)
    text = listing(skills.values(), budget_chars=60, usage={"pr-summary": 5})
    assert "- pr-summary: 汇总" in text            # 用得多的保留描述
    assert "- fix-lint\n" in text + "\n"         # 用得少的只剩名字
    assert "descriptions omitted" in text


def test_render_args_dir_and_commands(settings, tmp_path):
    _setup(settings)
    skills = load_skills(settings.cwd, settings.home)
    body = render_body(skills["pr-summary"], "develop", tmp_path)
    assert body.startswith(f"Base directory for this skill: {skills['pr-summary'].dir}")
    assert "基线分支：develop" in body and f"{skills['pr-summary'].dir}/references/checklist.md" in body
    assert "很长的检查清单" not in body                       # 第 3 层不自动加载
    assert render_body(skills["fix-lint"], "", tmp_path).endswith("先跑 eslint-v9\n")
    no_placeholder = render_body(skills["fix-lint"], "src/a.ts", tmp_path)
    assert no_placeholder.rstrip().endswith("ARGUMENTS: src/a.ts")


def test_model_invokes_skill_tool(make_app, settings):
    _setup(settings)
    app, client = make_app(call("Skill", {"skill": "pr-summary", "args": "develop"}), say("写好了"))
    app.handle_line("帮我写个 PR 描述")
    system = "\n".join(b["text"] for b in client.requests[0].system)
    assert "# Skills" in system and "- pr-summary:" in system and "# PR 描述" not in system  # 第 1 层只有目录
    last = client.requests[1].messages[-1]["content"]
    assert last[0]["type"] == "tool_result" and last[0]["content"] == "Launching skill: pr-summary"
    body = next(b["text"] for b in last[1:] if b["type"] == "text" and "Base directory" in b["text"])
    assert "基线分支：develop" in body                        # 第 2 层：作为一条普通文本追加在结果之后
    assert "pr-summary" in app.ui.text


def test_skill_tool_refuses_manual_only_and_unknown(make_app, settings):
    _setup(settings)
    app, client = make_app(call("Skill", {"skill": "release-note"}), call("Skill", {"skill": "nope"}), say("ok"))
    app.handle_line("发版")
    r1 = client.requests[1].messages[-1]["content"][0]
    r2 = client.requests[2].messages[-1]["content"][0]
    assert r1["is_error"] and "only by the user" in r1["content"]
    assert r2["is_error"] and "pr-summary" in r2["content"]


def test_slash_command_expands_skill(make_app, settings):
    _setup(settings)
    app, client = make_app(say("v1.2.0 发版说明如下"))
    app.handle_line("/release-note v1.2.0")
    content = client.requests[0].messages[0]["content"]
    blob = json.dumps(content, ensure_ascii=False)
    assert "<command-name>/release-note</command-name>" in blob and "版本：v1.2.0" in blob
    assert "未知命令" not in app.ui.text


def test_failing_preprocess_command_aborts(make_app, settings):
    root = settings.home / "skills"
    _skill(root, "broken", "坏的", "x !`exit 3` y")
    app, client = make_app(call("Skill", {"skill": "broken"}), say("ok"))
    app.handle_line("用 broken")
    r = client.requests[1].messages[-1]["content"][0]
    assert r["is_error"] and "exit code 3" in r["content"]


def test_invoked_skill_survives_compaction(make_app, settings):
    _setup(settings)
    app, client = make_app(call("Skill", {"skill": "pr-summary", "args": "develop"}), say("ok"),
                           say("<summary>在写 PR 描述</summary>"))
    app.handle_line("写 PR 描述")
    app.handle_line("/compact")
    blob = json.dumps(app.agent.messages[0], ensure_ascii=False)
    assert "基线分支：develop" in blob and "Re-attached skill after compaction: pr-summary" in blob


def test_skills_command(make_app, settings):
    _setup(settings)
    app, _ = make_app()
    app.handle_line("/skills")
    assert "pr-summary" in app.ui.text and "release-note" in app.ui.text and "手动" in app.ui.text
