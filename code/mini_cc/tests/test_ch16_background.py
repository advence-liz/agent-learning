"""第 16 章：让 Agent 在后台运行命令。"""

import json
import time

from mini_cc.model import call, say


def _bg(cmd, desc="demo"):
    return call("Bash", {"command": cmd, "run_in_background": True, "description": desc})


def _result_text(req):
    return req.messages[-1]["content"][0]["content"]


def test_background_returns_immediately_and_notifies_on_exit(make_app):
    app, client = make_app(_bg("sleep 0.3; echo done", "sleep then echo"), say("已在后台跑"),
                           say("后台命令跑完了，输出 done"))
    app.agent.permissions.set_mode("bypassPermissions")
    t0 = time.monotonic()
    app.handle_line("后台跑个命令")
    assert time.monotonic() - t0 < 0.3                      # 没有等命令结束
    first = _result_text(client.requests[1])
    assert first.startswith("Command running in background with ID: b1.") and ".output" in first
    job = app.jobs.get("b1")
    job.wait(5)
    assert job.status == "completed" and job.exit_code == 0
    assert job.output_file.read_text() == "done\n"
    # 通知在下一条 user 消息里送达；空闲时 REPL 会主动唤醒模型
    assert app.wake_if_idle() is True
    sent = json.dumps(client.requests[2].messages[-1], ensure_ascii=False)
    assert "<task-notification>" in sent and "<status>completed</status>" in sent
    assert "Background command \\\"sleep then echo\\\" completed (exit code 0)" in sent
    assert app.wake_if_idle() is False                     # 队列空了就不再唤醒


def test_failed_background_command(make_app):
    app, client = make_app(_bg("echo boom >&2; exit 3"), say("ok"), say("失败了"))
    app.agent.permissions.set_mode("bypassPermissions")
    app.handle_line("跑")
    job = app.jobs.get("b1")
    job.wait(5)
    assert job.status == "failed" and job.exit_code == 3 and "boom" in job.output_file.read_text()
    app.wake_if_idle()
    assert "failed with exit code 3" in json.dumps(client.requests[2].messages[-1])


def test_notification_rides_on_next_tool_result_while_busy(make_app):
    app, client = make_app(_bg("true"), call("Bash", {"command": "sleep 0.5"}), say("ok"))
    app.agent.permissions.set_mode("bypassPermissions")
    app.handle_line("跑")
    # 第二个工具（前台 sleep）执行期间后台命令结束：通知跟着 tool_result 一起送达，不用等这一轮结束
    last = json.dumps(client.requests[2].messages[-1], ensure_ascii=False)
    assert "tool_result" in last and "<task-notification>" in last


def test_task_stop_kills_job(make_app):
    app, client = make_app(_bg("sleep 30"), call("TaskStop", {"task_id": "b1"}), say("停了"))
    app.agent.permissions.set_mode("bypassPermissions")
    app.handle_line("跑一个长命令然后停掉")
    job = app.jobs.get("b1")
    job.wait(5)
    assert job.status == "killed"
    assert "Stopped task b1" in _result_text(client.requests[2])
    assert app.wake_if_idle() is False                     # 自己停掉的不再通知
    bad = app.agent.tools.execute("TaskStop", {"task_id": "nope"}, app.agent.ctx)
    assert bad.is_error and "No task" in bad.content


def test_tasks_command_lists_jobs(make_app):
    app, _ = make_app(_bg("sleep 30", "long sleep"), say("ok"))
    app.agent.permissions.set_mode("bypassPermissions")
    app.handle_line("跑")
    app.handle_line("/tasks")
    assert "b1" in app.ui.text and "running" in app.ui.text and "long sleep" in app.ui.text
    app.handle_line("/tasks stop b1")
    app.jobs.get("b1").wait(5)
    assert app.jobs.get("b1").status == "killed"


def test_reading_output_file_does_not_trigger_change_reminders(make_app):
    app, client = make_app(_bg("for i in 1 2 3; do echo $i; sleep 0.1; done"), say("ok"),
                           say("ok"), say("ok"))
    app.agent.permissions.set_mode("bypassPermissions")
    app.handle_line("跑")
    path = str(app.jobs.get("b1").output_file)
    app.agent.tools.execute("Read", {"file_path": path}, app.agent.ctx)  # 模型中途 Read 输出文件
    app.jobs.get("b1").wait(5)
    app.handle_line("怎么样了")
    assert "modified outside" not in json.dumps(client.requests[-1].messages[-1])


def test_foreground_timeout_suggests_background(make_app):
    app, client = make_app(call("Bash", {"command": "sleep 3", "timeout": 1}), say("超时了"))
    app.agent.permissions.set_mode("bypassPermissions")
    app.handle_line("跑")
    assert "run_in_background" in _result_text(client.requests[1])


def test_close_kills_running_jobs(make_app):
    app, _ = make_app(_bg("sleep 30"), say("ok"))
    app.agent.permissions.set_mode("bypassPermissions")
    app.handle_line("跑")
    app.close()
    assert app.jobs.get("b1").status == "killed"
