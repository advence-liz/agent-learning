import os
import sys

# 让本目录下的测试可以直接 `import sampling` / `import lora` 等
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import hf_env  # noqa: E402,F401  在任何测试 import transformers 之前固定 HF 缓存目录
