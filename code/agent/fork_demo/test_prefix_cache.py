import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import prefix_cache  # noqa: E402


def test_fork_hits_and_variants_miss():
    rows = dict(prefix_cache.run())
    assert rows["主会话第 N 轮（预热）"]["cache_read"] == 0
    fork = rows["Fork：同 tools/system/历史 + 追加任务"]
    assert fork["cache_read"] / fork["total"] > 0.99
    assert rows["Fork 但删掉 Bash 工具定义"]["cache_read"] == 0  # tools 在最前，改了全挂
    sys_changed = rows["Fork 但改了 system prompt"]
    assert sys_changed["cache_read"] < sys_changed["total"] * 0.01  # 只剩 tools 那一小段
    assert rows["全新 Sub Agent（自己的 system+tools，空历史）"]["cache_read"] == 0
