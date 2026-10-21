"""p5-ml 经典算法章节共用的小工具：图片输出目录、中文字体。"""
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

# code/ml/classic/common.py -> parents[3] = agent-learn/
IMG_DIR = Path(__file__).resolve().parents[3] / "p5-ml" / "img"

plt.rcParams["font.sans-serif"] = ["PingFang SC", "Heiti SC", "Arial Unicode MS", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False
plt.rcParams["figure.dpi"] = 110


def save(fig, name: str) -> Path:
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    path = IMG_DIR / name
    fig.tight_layout()
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)
    print(f"[figure] {path.relative_to(IMG_DIR.parent)}")
    return path
