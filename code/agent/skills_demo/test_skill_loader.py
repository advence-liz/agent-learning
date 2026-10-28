import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import skill_loader as sl  # noqa: E402

ROOT = Path(__file__).parent / "skills"


def test_listing_hides_manual_only():
    listing = sl.build_listing(sl.load_skills(ROOT), 200_000)
    assert "pr-summary" in listing and "release-note" not in listing


def test_budget_drops_descriptions_not_names():
    skills = sl.load_skills(ROOT)
    small = sl.build_listing(skills, 1_000)  # 预算 40 字符
    assert small == "- pr-summary"


def test_render_args_and_shell():
    skills = sl.load_skills(ROOT)
    body = sl.render_body(skills["pr-summary"], "develop")
    assert "git diff develop...HEAD" in body and "Python 3" in body and "!`" not in body
    assert body.startswith("Base directory for this skill:")


def test_arguments_appended_when_no_placeholder(tmp_path):
    d = tmp_path / "x"
    d.mkdir()
    (d / "SKILL.md").write_text("---\nname: x\ndescription: d\n---\n做事")
    body = sl.render_body(sl.load_skills(tmp_path)["x"], "foo")
    assert body.endswith("ARGUMENTS: foo")


def test_failing_preprocess_aborts(tmp_path):
    d = tmp_path / "y"
    d.mkdir()
    (d / "SKILL.md").write_text("---\nname: y\n---\n!`false`")
    with pytest.raises(RuntimeError):
        sl.render_body(sl.load_skills(tmp_path)["y"], "")


def test_invoke_appends_only():
    msgs = [{"role": "user", "content": "hi"}]
    before = list(msgs)
    sl.invoke(msgs, sl.load_skills(ROOT), "release-note", "v1..v2")
    assert msgs[:1] == before and "v1..v2" in msgs[-1]["content"]
