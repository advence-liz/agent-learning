"""第 19 章：图片输入（@ 引用 / 拖进终端的路径 / Read 读图片）。"""

import base64
import struct
import zlib

from mini_cc.images import estimate_visual_tokens, find_image_paths, image_info, sniff
from mini_cc.model import call, say


def png(w: int, h: int) -> bytes:
    """纯标准库生成一张 w×h 的灰色 PNG（测试用，不依赖 Pillow）。"""
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\x80" * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def jpeg_header(w, h):
    return b"\xff\xd8\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + b"\x00" * 9 + \
        b"\xff\xc0" + struct.pack(">HBHH", 17, 8, h, w) + b"\x00" * 10


def test_sniff_and_dimensions():
    assert image_info(png(30, 20)) == ("image/png", 30, 20)
    assert image_info(jpeg_header(640, 480)) == ("image/jpeg", 640, 480)
    assert image_info(b"GIF89a" + struct.pack("<HH", 12, 7) + b"\x00" * 20) == ("image/gif", 12, 7)
    webp = b"RIFF" + b"\x00" * 4 + b"WEBPVP8X" + b"\x00" * 8 + (99).to_bytes(3, "little") + (49).to_bytes(3, "little")
    assert image_info(webp) == ("image/webp", 100, 50)
    assert sniff(b"%PDF-1.7") is None


def test_visual_token_estimate_matches_docs_table():
    # 官方 vision 文档的高分辨率档示例：1000² → 1296，1920×1080 → 2691，4K → 缩到 2576×1449 → 4784
    assert estimate_visual_tokens(1000, 1000) == 1296
    assert estimate_visual_tokens(1920, 1080) == 2691
    assert estimate_visual_tokens(3840, 2160) == 4784


def test_find_image_paths_handles_drag_and_drop(tmp_path):
    p = tmp_path / "my shot.png"
    p.write_bytes(png(2, 2))
    escaped = str(p).replace(" ", "\\ ")
    assert find_image_paths(f"{escaped} 这个按钮为什么错位", tmp_path) == [p]
    assert find_image_paths(f"'{p}' 看看", tmp_path) == [p]
    assert find_image_paths("没有图片 /nope.png", tmp_path) == []


def test_mention_attaches_image_before_text(make_app, settings):
    (settings.cwd / "shot.png").write_bytes(png(40, 30))
    app, client = make_app(say("按钮右边距多了 8px"))
    app.handle_line("@shot.png 这个按钮为什么错位")
    content = client.requests[0].messages[0]["content"]
    kinds = [b["type"] for b in content]
    img = next(b for b in content if b["type"] == "image")
    assert kinds.index("image") < len(kinds) - 1 and content[-1]["text"] == "@shot.png 这个按钮为什么错位"
    assert img["source"]["media_type"] == "image/png"
    assert base64.b64decode(img["source"]["data"]) == (settings.cwd / "shot.png").read_bytes()
    assert "已附加 @shot.png（图片 png 40×30" in app.ui.text


def test_dragged_path_is_attached(make_app, settings):
    shot = settings.cwd / "Screen Shot.png"
    shot.write_bytes(png(10, 10))
    app, client = make_app(say("ok"))
    app.handle_line(str(shot).replace(" ", "\\ ") + " 对比一下设计稿")
    assert any(b["type"] == "image" for b in client.requests[0].messages[0]["content"])


def test_read_tool_returns_image_block(make_app, settings):
    (settings.cwd / "ui.png").write_bytes(png(16, 16))
    app, client = make_app(call("Read", {"file_path": "ui.png"}), say("看到了"))
    app.handle_line("读一下 ui.png")
    result = client.requests[1].messages[-1]["content"][0]
    assert not result["is_error"]
    assert [b["type"] for b in result["content"]] == ["text", "image"]
    assert "ui.png" in result["content"][0]["text"] and "16x16" in result["content"][0]["text"]
    assert "✔ Read -> Image: ui.png" in app.ui.text and "[image]" in app.ui.text


def test_wrong_extension_and_oversized(make_app, settings):
    (settings.cwd / "fake.png").write_bytes(jpeg_header(10, 10) + b"\x00" * 100)
    big = png(1, 1)
    big = big[:16] + struct.pack(">II", 9000, 10) + big[24:]   # 改 IHDR：声称 9000×10
    (settings.cwd / "huge.png").write_bytes(big)
    app, client = make_app(call("Read", {"file_path": "fake.png"}), call("Read", {"file_path": "huge.png"}), say("ok"))
    app.handle_line("读两张图")
    first = client.requests[1].messages[-1]["content"][0]["content"]
    assert first[1]["source"]["media_type"] == "image/jpeg"        # 按文件头，不按扩展名
    second = client.requests[2].messages[-1]["content"][0]
    assert second["is_error"] and "8000" in second["content"]


def test_context_command_counts_images(make_app, settings):
    (settings.cwd / "a.png").write_bytes(png(1000, 1000))
    app, _ = make_app(say("ok"))
    app.handle_line("@a.png 看看")
    app.handle_line("/context")
    assert "1 张图片" in app.ui.text and "1296" in app.ui.text
