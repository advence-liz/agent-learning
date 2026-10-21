"""第 18 章：Monitor —— 命令的每一行输出都是一个事件。"""

import time

from mini_cc.jobs import JobManager
from mini_cc.model import call, say


def _mgr(tmp_path, **kw):
    got = []
    m = JobManager(tmp_path / "tasks", got.append)
    for k, v in kw.items():
        setattr(m, k, v)
    return m, got


def test_each_line_becomes_an_event_and_end_is_reported(tmp_path):
    m, got = _mgr(tmp_path)
    job = m.start_monitor("for i in 1 2; do echo ERROR $i; sleep 0.5; done", tmp_path, "errors in app.log", 10)
    job.wait(5)
    events = [g for g in got if 'Monitor event: "errors in app.log"' in g]
    assert len(events) == 2
    assert "<event>ERROR 1</event>" in events[0] and "<event>ERROR 2</event>" in events[1]
    assert 'Monitor "errors in app.log" stream ended (exit code 0, 2 events)' in got[-1]
    assert "<status>completed</status>" in got[-1]
    assert job.output_file.read_text() == "ERROR 1\nERROR 2\n"


def test_lines_within_200ms_are_batched(tmp_path):
    m, got = _mgr(tmp_path)
    job = m.start_monitor("echo a; echo b; echo c", tmp_path, "burst", 10)
    job.wait(5)
    events = [g for g in got if "Monitor event" in g]
    assert len(events) == 1 and "<event>a\nb\nc</event>" in events[0]


def test_stderr_is_not_an_event(tmp_path):
    m, got = _mgr(tmp_path)
    job = m.start_monitor("echo oops >&2; echo fine", tmp_path, "mixed", 10)
    job.wait(5)
    assert "oops" not in "".join(got) and "<event>fine</event>" in "".join(got)
    assert "oops" in job.output_file.read_text()


def test_monitor_expires(tmp_path):
    m, got = _mgr(tmp_path)
    t0 = time.monotonic()
    job = m.start_monitor("while true; do sleep 0.1; done", tmp_path, "quiet log", 0.5)
    job.wait(5)
    assert time.monotonic() - t0 < 3
    assert job.status == "killed"
    assert 'Monitor "quiet log" expired after 0.5s with 0 events' in got[-1] and "re-arm" in got[-1]


def test_too_many_events_stops_monitor(tmp_path):
    m, got = _mgr(tmp_path, max_events=3, event_window=60.0)
    job = m.start_monitor("while true; do echo tick; sleep 0.25; done", tmp_path, "ticks", 10)
    job.wait(5)
    assert job.status == "killed"
    assert sum("Monitor event" in g for g in got) == 3
    assert "too many events" in got[-1] and "tighter filter" in got[-1]


def test_huge_batch_is_truncated(tmp_path):
    m, got = _mgr(tmp_path, max_batch_lines=5)
    job = m.start_monitor("seq 1 100", tmp_path, "flood", 10)
    job.wait(5)
    ev = next(g for g in got if "Monitor event" in g)
    assert "<event>1\n2\n3\n4\n5\n(… 95 more lines in the output file)</event>" in ev


def test_monitor_tool_and_task_stop(make_app):
    app, client = make_app(
        call("Monitor", {"command": "tail -n 0 -F app.log | grep --line-buffered ERROR",
                         "description": "errors in app.log", "timeout_ms": 60000}),
        say("在盯着了"), say("看到一个 ERROR"), call("TaskStop", {"task_id": "m1"}), say("停了"))
    (app.settings.cwd / "app.log").write_text("")
    app.ui.answers = ["1"]
    app.handle_line("盯着 app.log，一出现 ERROR 就告诉我")
    first = client.requests[1].messages[-1]["content"][0]["content"]
    assert first.startswith("Monitor started (task m1") and "an event is not their reply" in first
    time.sleep(0.5)
    with (app.settings.cwd / "app.log").open("a") as f:
        f.write("INFO ok\nERROR db timeout\n")
    deadline = time.monotonic() + 5
    while app.agent.notifications.empty() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert app.wake_if_idle()
    assert "<event>ERROR db timeout</event>" in str(client.requests[2].messages[-1])
    app.handle_line("可以停了")
    assert app.jobs.get("m1").status == "killed"
    app.handle_line("/tasks")
    assert "monitor" in app.ui.text
