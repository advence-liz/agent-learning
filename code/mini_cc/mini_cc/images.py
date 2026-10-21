"""图片输入（第 19 章）：把图片文件变成 API 的 image 内容块。

数字都来自 Claude 官方 vision 文档：
- 格式：JPEG / PNG / GIF / WebP（按文件头判断，不信扩展名）
- 单张上限：直连 API 时 base64 后 10MB；尺寸不超过 8000×8000 px
- 费用：每 28×28 像素一个 visual token；高分辨率档（Claude 4.7 及以后，含 claude-opus-5-5）长边超过 2576px
  或超过 4784 个 visual token 时，服务端会等比缩小
"""

from __future__ import annotations

import base64
import math
import re
import struct
from dataclasses import dataclass
from pathlib import Path

EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
MAX_BASE64_BYTES = 10 * 1024 * 1024
MAX_DIMENSION = 8000
MAX_LONG_EDGE = 2576        # 高分辨率档
MAX_VISUAL_TOKENS = 4784


def sniff(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _jpeg_size(data: bytes) -> tuple[int, int] | None:
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        (length,) = struct.unpack(">H", data[i + 2:i + 4])
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):  # SOFn：帧头里有宽高
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        i += 2 + length
    return None


def image_info(data: bytes) -> tuple[str, int, int] | None:
    """(media_type, 宽, 高)。只解析文件头，不解码像素（所以不需要 Pillow）。"""
    media = sniff(data)
    size: tuple[int, int] | None = None
    if media == "image/png" and len(data) >= 24:
        size = struct.unpack(">II", data[16:24])
    elif media == "image/jpeg":
        size = _jpeg_size(data)
    elif media == "image/gif" and len(data) >= 10:
        size = struct.unpack("<HH", data[6:10])
    elif media == "image/webp" and len(data) >= 30:
        kind = data[12:16]
        if kind == b"VP8X":
            size = (int.from_bytes(data[24:27], "little") + 1, int.from_bytes(data[27:30], "little") + 1)
        elif kind == b"VP8 ":
            w, h = struct.unpack("<HH", data[26:30])
            size = (w & 0x3FFF, h & 0x3FFF)
        elif kind == b"VP8L":
            b = int.from_bytes(data[21:25], "little")
            size = ((b & 0x3FFF) + 1, ((b >> 14) & 0x3FFF) + 1)
    if media is None or size is None:
        return None
    return media, size[0], size[1]


def estimate_visual_tokens(w: int, h: int) -> int:
    """服务端缩放后的 visual token 数（近似复现文档的规则：先压长边，再压总 token 数）。"""
    s = min(1.0, MAX_LONG_EDGE / max(w, h))
    w2, h2 = max(1, round(w * s)), max(1, round(h * s))
    tokens = math.ceil(w2 / 28) * math.ceil(h2 / 28)
    while tokens > MAX_VISUAL_TOKENS:
        s = math.sqrt(MAX_VISUAL_TOKENS / tokens) * 0.999
        w2, h2 = max(1, int(w2 * s)), max(1, int(h2 * s))
        tokens = math.ceil(w2 / 28) * math.ceil(h2 / 28)
    return tokens


class ImageError(ValueError):
    pass


@dataclass
class ImageMeta:
    media: str
    width: int
    height: int
    size: int            # 字节
    tokens: int          # 估算的 visual token

    @property
    def short(self) -> str:
        return self.media.split("/")[1]

    def note(self) -> str:
        return f"{self.short}, {self.width}x{self.height}, {self.size // 1024 or 1}KB, ≈{self.tokens} visual tokens"


def load_image(path: Path) -> tuple[dict, ImageMeta]:
    """读图片 → (image 内容块, 元信息)。不合规的图片抛 ImageError，说明原因（给模型看）。"""
    data = path.read_bytes()
    info = image_info(data)
    if info is None:
        raise ImageError(f"{path.name} is not a supported image (JPEG, PNG, GIF or WebP).")
    media, w, h = info
    if max(w, h) > MAX_DIMENSION:
        raise ImageError(f"{path.name} is {w}x{h}; images must be at most {MAX_DIMENSION}x{MAX_DIMENSION} px. "
                         "Resize it first (e.g. `sips -Z 2576 file.png` on macOS).")
    b64 = base64.standard_b64encode(data).decode("ascii")
    if len(b64) > MAX_BASE64_BYTES:
        raise ImageError(f"{path.name} is {len(data) // 1024}KB ({len(b64) // 1024}KB as base64); "
                         "the API limit is 10MB per image. Compress or resize it first.")
    meta = ImageMeta(media, w, h, len(data), estimate_visual_tokens(w, h))
    return {"type": "image", "source": {"type": "base64", "media_type": media, "data": b64}}, meta


def is_image_path(path: Path) -> bool:
    return path.suffix.lower() in EXTENSIONS and path.is_file()


# 拖进终端的路径：macOS Terminal / iTerm 会把空格转义成「\ 」，有的终端会加引号
_QUOTED = re.compile(r"""(['"])(.+?)\1""")
_BARE = re.compile(r"((?:~|/|\.{1,2}/)(?:\\ |[^\s'\"])+)")


def find_image_paths(text: str, cwd: Path) -> list[Path]:
    """找出输入里「存在的图片文件路径」（绝对路径、~、./ 开头，或带引号）。"""
    found: list[Path] = []
    candidates = [m.group(2) for m in _QUOTED.finditer(text)] + [m.group(1) for m in _BARE.finditer(text)]
    for raw in candidates:
        p = Path(raw.replace("\\ ", " ")).expanduser()
        p = p if p.is_absolute() else cwd / p
        if is_image_path(p) and p.resolve() not in [f.resolve() for f in found]:
            found.append(p)
    return found
