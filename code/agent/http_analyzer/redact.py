"""脱敏：落盘前把凭证从 header 和 body 里抹掉。

原则：宁可多抹不可漏抹。header 按名字整值替换；body 里再按正则兜底扫一遍
（防止有人把 key 塞进 metadata、或者 OAuth token 出现在别的字段里）。
"""

from __future__ import annotations

import re

# 整值替换的 header（小写比较）
SENSITIVE_HEADERS = {
    "x-api-key",
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "anthropic-admin-api-key",
}

# body / 任意文本里的兜底模式：Anthropic key、Bearer token、通用 sk- 前缀
_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{12,}"),
    re.compile(r"\bsk-[A-Za-z0-9]{20,}"),
]

MASK = "***REDACTED***"


def redact_value(value: str) -> str:
    """保留前 6 个字符方便你区分「用的是哪把 key」，其余全抹。"""
    if len(value) <= 10:
        return MASK
    return value[:6] + "…" + MASK


def redact_headers(headers: dict[str, str]) -> dict[str, str]:
    out = {}
    for k, v in headers.items():
        out[k] = redact_value(v) if k.lower() in SENSITIVE_HEADERS else v
    return out


def redact_text(text: str) -> str:
    for p in _PATTERNS:
        text = p.sub(MASK, text)
    return text
