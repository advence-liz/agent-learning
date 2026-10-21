"""运行配置：一个 dataclass 收拢所有「可调旋钮」，避免散落在各模块的全局变量。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_MODEL = "claude-opus-5-5"


def _default_home() -> Path:
    return Path(os.environ.get("MINI_CC_HOME", Path.home() / ".mini_cc"))


@dataclass
class Settings:
    model: str = DEFAULT_MODEL
    # 流式请求给足空间（claude-api skill 的建议：streaming 默认 ~64000）
    max_tokens: int = 64000
    # Opus 5.5 的 effort 默认就是 medium，这里显式写出来，方便 /status 展示
    effort: str = "medium"
    cwd: Path = field(default_factory=Path.cwd)
    # 会话、设置等落盘位置（第 4 章开始用），测试里指向 tmp_path
    home: Path = field(default_factory=_default_home)
    # 单轮最多跑多少次「模型 → 工具」来回，防止死循环烧 token
    max_iterations: int = 50
    # 第 3 章：API 重试
    max_retries: int = 5
    retry_base_delay: float = 1.0
    retry_max_delay: float = 30.0
    # 服务端 refusal fallback（claude-api skill 推荐默认开启）；中转站不支持时 MINI_CC_FALLBACKS=0
    fallbacks: bool = field(default_factory=lambda: os.environ.get("MINI_CC_FALLBACKS", "1") != "0")
    # 工具输出超过这么多字符就截断，防止一条 cat 把上下文撑爆
    max_tool_output: int = 30000
    # 第 5 章：权限模式 default | acceptEdits | auto | plan | bypassPermissions
    permission_mode: str = "default"
