"""把 Hugging Face 缓存固定到本目录下的 .hf-cache/（约 270 MB）。

默认缓存位置是 ~/.cache/huggingface；固定到项目内是为了让测试和章节输出可复现，
不受全局缓存被清理的影响。已显式设置 HF_HOME 时以环境变量为准。
必须在 import transformers / huggingface_hub 之前导入。
"""

import os

HF_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".hf-cache")
os.environ.setdefault("HF_HOME", HF_CACHE)
