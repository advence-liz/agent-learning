"""后台任务（第 16 章起）：跑得久、结束后要告诉模型的活，都放这里。

- bash：Bash(run_in_background=true)。子进程输出写文件，等待线程在它退出时发一条 <task-notification>。
- 第 17 章的 sub agent、第 18 章的 Monitor 复用同一套：Job 表 + 输出文件 + agent.notify()。

通知走第 9 章预留的通道：agent.notify() 是线程安全队列，notifications_provider 在下一条 user 消息
（用户发话或工具结果）里送达；如果 agent 正空闲，App.wake_if_idle() 主动开一轮把通知交给模型。
"""

from __future__ import annotations

import itertools
import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from html import escape
from pathlib import Path
from typing import Any, Callable


@dataclass
class Job:
    id: str
    kind: str                       # bash | agent | monitor
    description: str
    output_file: Path
    tool_use_id: str = ""
    status: str = "running"         # running | completed | failed | killed
    exit_code: int | None = None
    started: float = field(default_factory=time.time)
    ended: float | None = None
    proc: subprocess.Popen | None = None
    thread: threading.Thread | None = None
    stop_requested: bool = False
    extra: dict[str, Any] = field(default_factory=dict)

    def wait(self, timeout: float | None = None) -> bool:
        if self.thread is not None:
            self.thread.join(timeout)
        return self.status != "running"

    @property
    def runtime(self) -> float:
        return (self.ended or time.time()) - self.started


def render_notification(job: Job, summary: str, result: str | None = None) -> str:
    """和 Claude Code 的 <task-notification> 同一个结构（字段名取自本机会话记录）。"""
    parts = ["<task-notification>", f"<task-id>{job.id}</task-id>"]
    if job.tool_use_id:
        parts.append(f"<tool-use-id>{job.tool_use_id}</tool-use-id>")
    parts += [f"<output-file>{job.output_file}</output-file>", f"<status>{job.status}</status>",
              f"<summary>{escape(summary, quote=False)}</summary>"]  # 和本机记录一致：转义 & < >，引号不转
    if result is not None:
        parts.append(f"<result>\n{result}\n</result>")
    parts.append("</task-notification>")
    return "\n".join(parts)


class JobManager:
    # 第 18 章 Monitor 的节流参数（数值参考 Claude Code Monitor 工具的说明：200ms 内的行合并成一条通知）
    batch_window = 0.2        # 秒：这段时间内的输出行合并成一个事件
    max_batch_lines = 50      # 一个事件最多带多少行，多的留在输出文件里
    max_events = 30           # event_window 秒内超过这么多事件就自动停掉（刷屏的 monitor 会吃光上下文）
    event_window = 60.0

    def __init__(self, dir: Path, notify: Callable[[str], None]):
        self.dir = dir
        self.notify = notify
        self.jobs: dict[str, Job] = {}
        self._ids: dict[str, itertools.count] = {}
        self._lock = threading.Lock()

    def _new(self, kind: str, prefix: str, description: str, tool_use_id: str, job_id: str | None = None) -> Job:
        with self._lock:
            job_id = job_id or f"{prefix}{next(self._ids.setdefault(prefix, itertools.count(1)))}"
            job = Job(job_id, kind, description, self.dir / f"{job_id}.output", tool_use_id)
            self.jobs[job.id] = job
        self.dir.mkdir(parents=True, exist_ok=True)
        return job

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def running(self) -> list[Job]:
        return [j for j in self.jobs.values() if j.status == "running"]

    # ------------------------------------------------------------ bash

    def start_bash(self, command: str, cwd: Path, description: str = "", tool_use_id: str = "") -> Job:
        job = self._new("bash", "b", description or command, tool_use_id)
        out = open(job.output_file, "w", encoding="utf-8")
        # start_new_session：自成一个进程组，TaskStop 能连同它的子进程（比如 npm 拉起的 node）一起杀掉
        job.proc = subprocess.Popen(command, shell=True, cwd=cwd, stdout=out, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL, start_new_session=True)
        out.close()  # 子进程持有自己的那份 fd

        def wait() -> None:
            rc = job.proc.wait()
            job.exit_code, job.ended = rc, time.time()
            if job.stop_requested:
                job.status = "killed"
                return  # 模型或用户主动停的：调用方已经知道了，不再通知
            job.status = "completed" if rc == 0 else "failed"
            verb = "completed (exit code 0)" if rc == 0 else f"failed with exit code {rc}"
            self.notify(render_notification(job, f'Background command "{job.description}" {verb}'))

        job.thread = threading.Thread(target=wait, name=f"job-{job.id}", daemon=True)
        job.thread.start()
        return job

    # ------------------------------------------------------------ 线程型任务（第 17 章 sub agent）

    def start_thread(self, kind: str, prefix: str, description: str, fn: Callable[[Job], tuple[str, str, str | None]],
                     tool_use_id: str = "", job_id: str | None = None) -> Job:
        """fn(job) 在新线程里跑，返回 (status, summary, result)；结束后发通知（result 放进 <result>）。"""
        job = self._new(kind, prefix, description, tool_use_id, job_id)

        def run() -> None:
            try:
                status, summary, result = fn(job)
            except Exception as e:  # noqa: BLE001
                status, summary, result = "failed", f'{kind} "{description}" crashed: {type(e).__name__}: {e}', None
            job.ended = time.time()
            if job.stop_requested:
                job.status = "killed"
                return
            job.status = status
            self.notify(render_notification(job, summary, result))

        job.thread = threading.Thread(target=run, name=f"job-{job.id}", daemon=True)
        job.thread.start()
        return job

    # ------------------------------------------------------------ monitor（第 18 章）

    def start_monitor(self, command: str, cwd: Path, description: str, timeout: float, tool_use_id: str = "") -> Job:
        """命令的 stdout 每一行（200ms 内的合并）是一个事件；进程退出 / 超时 / 刷屏时各发一条结束通知。"""
        job = self._new("monitor", "m", description, tool_use_id)
        out = open(job.output_file, "w", encoding="utf-8")
        job.proc = subprocess.Popen(command, shell=True, cwd=cwd, stdout=subprocess.PIPE, stderr=out,
                                    stdin=subprocess.DEVNULL, start_new_session=True, text=True, bufsize=1)
        lock = threading.Lock()
        pending: list[str] = []
        first_at: list[float] = []          # 当前这批第一行到达的时间
        sent: list[float] = []              # 每个事件发出的时间（节流用）
        job.extra["events"] = 0
        end_reason: list[str] = []

        def kill(reason: str) -> None:
            if not end_reason:
                end_reason.append(reason)
            try:
                os.killpg(job.proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

        def flush() -> None:
            with lock:
                if not pending:
                    return
                lines, more = pending[: self.max_batch_lines], len(pending) - self.max_batch_lines
                pending.clear()
                first_at.clear()
            body = "\n".join(lines) + (f"\n(… {more} more lines in the output file)" if more > 0 else "")
            if job.stop_requested or end_reason:
                return
            job.extra["events"] += 1
            sent.append(time.monotonic())
            self.notify("\n".join(["<task-notification>", f"<task-id>{job.id}</task-id>",
                                    f'<summary>Monitor event: "{escape(description, quote=False)}"</summary>',
                                    f"<event>{escape(body, quote=False)}</event>", "</task-notification>"]))
            recent = [t for t in sent if t > time.monotonic() - self.event_window]
            if len(recent) >= self.max_events:
                kill("flood")

        def read() -> None:
            for line in job.proc.stdout:
                out.write(line)
                out.flush()
                if line.strip():
                    with lock:
                        pending.append(line.rstrip("\n"))
                        if not first_at:
                            first_at.append(time.monotonic())

        reader = threading.Thread(target=read, name=f"job-{job.id}-read", daemon=True)
        reader.start()
        deadline = time.monotonic() + timeout

        def tick() -> None:
            while reader.is_alive():
                reader.join(0.05)
                with lock:
                    due = bool(first_at) and time.monotonic() - first_at[0] >= self.batch_window
                if due:
                    flush()
                if time.monotonic() >= deadline and reader.is_alive():
                    kill("timeout")
            flush()  # 进程结束前最后几行
            rc = job.proc.wait()
            out.close()
            job.exit_code, job.ended = rc, time.time()
            n = job.extra["events"]
            if job.stop_requested:
                job.status = "killed"
                return
            if end_reason == ["timeout"]:
                job.status = "killed"
                summary = (f'Monitor "{description}" expired after {timeout:g}s with {n} events. '
                           "Arm it again (re-arm) if you still need the watch.")
            elif end_reason == ["flood"]:
                job.status = "killed"
                summary = (f'Monitor "{description}" was stopped: too many events ({n} in {self.event_window:g}s). '
                           "Restart it with a tighter filter (only the lines you would act on).")
            else:
                job.status = "completed" if rc == 0 else "failed"
                summary = f'Monitor "{description}" stream ended (exit code {rc}, {n} events)'
            self.notify(render_notification(job, summary))

        job.thread = threading.Thread(target=tick, name=f"job-{job.id}", daemon=True)
        job.thread.start()
        return job

    # ------------------------------------------------------------ 停止

    def stop(self, job_id: str) -> Job | None:
        job = self.jobs.get(job_id)
        if job is None or job.status != "running":
            return job
        job.stop_requested = True
        if job.proc is not None:
            try:
                os.killpg(job.proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        stop = job.extra.get("stop")       # 线程型任务（sub agent / monitor）自己提供停止方法
        if stop:
            stop()
        if job.thread is not None:
            job.thread.join(5)
        if job.status == "running":
            job.status, job.ended = "killed", time.time()
        return job

    def stop_all(self) -> None:
        for job in self.running():
            self.stop(job.id)
