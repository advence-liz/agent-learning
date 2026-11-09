"""从 curriculum.json 生成知识库首页 README.md。新增/改章节后重跑：python3 tools/build_readme.py"""
import json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cur = json.load(open(os.path.join(ROOT, 'curriculum.json')))

import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parts import PARTS as _PARTS, ORDER, label  # 部分元数据的唯一来源
PARTS = {pid: (label(pid), desc, advice) for pid, _, _, desc, advice, _ in _PARTS}

def status(c):
    exists = os.path.exists(os.path.join(ROOT, c['out']))
    kind = '📖 笔记' if c['kind'] == 'note' else '✍️ 原创'
    return kind if exists else kind + '（写作中）'

lines = []
w = lines.append
w('# AI 开发学习知识库')
w('')
w('> **一句话**：LLM 只是「根据已有 token 预测下一个 token」的概率模型；Agent、Function Calling、MCP、Skills、压缩、记忆、Sub Agent、Harness，全都是**在有限上下文里尽可能准确高效完成任务的工程方法**。整个知识库只讲这一件事。')
w('')
w('骨架借鉴 [labuladong 的 AI 开发教程](https://labuladong.online/zh/ai-coding/ai-guide/)（选题、章节划分、「先用起来再讲原理」的讲法）。')
w('📖 是免费章节的**读书笔记**（请先读原文）；✍️ 是**独立原创课文**：会员章节全部重写（没有使用原站付费内容），另有 5 篇地基章虽然原文免费，也写成了自成一体的课文，原文作为延伸阅读。')
w('')
w('## 学习路线')
w('')
w('顺序是**先造一个玩具，再拆真家伙，最后自己造一个像样的**：第 2 部分亲手写出聊天机器人、Coding Agent、RAG、MCP，知道一个 Agent 最少由什么组成；第 3 部分带着这些零件去抓包拆 Claude Code / Codex，看工业级实现多做了什么，再收束到构建、评测、安全；第 4 部分把拆到的能力一章一章加进自己的 mini Claude Code。主线学完后，第 7 部分把全库串成面试准备：每道题都指回讲原理的章节。机器学习（第 5、6 部分）是选修，和 Agent 主线相互独立，放在最后。')
w('')
w('```mermaid')
w('flowchart LR')
w('  P0["0 核心概念<br/>token · 上下文"] --> P1["1 工具技巧<br/>hooks · subagent · skills"]')
w('  P1 --> P2["2 Agent 开发基础<br/>chatbot · RAG · MCP"]')
w('  P2 --> P3["3 工业级 Agent<br/>拆解 · 构建 · 评测 · 安全"]')
w('  P3 --> P4["4 手搓 mini Claude Code<br/>21 次增量"]')
w('  P4 --> P7["7 Agent 研发面试<br/>考点 · 高频题 · 系统设计"]')
w('  P0 -.选修.-> P5["5 机器学习基础"] --> P6["6 神经网络 + LLM<br/>推理 · LoRA"]')
w('```')
w('')
w('| 部分 | 讲什么 | 建议 |')
w('|---|---|---|')
for p in ORDER:
    t, d, s = PARTS[p]
    w(f'| [{t}](#{p}) | {d} | {s} |')
w('')
w('## 目录')
w('')
w('勾选框用来跟踪进度（直接在编辑器里改 `[ ]` → `[x]`）。')
for p in ORDER:
    t, d, s = PARTS[p]
    w('')
    w(f'<a id="{p}"></a>')
    w(f'### {t}')
    w('')
    w(f'{d}。')
    w('')
    if p == 'p0-core':
        w(f'- [ ] [本章导读](p0-core/00-guide.md) · 📖 笔记 · [原文](https://labuladong.online/zh/ai-coding/ai-guide/)')
    for c in [c for c in cur if c['part'] == p]:
        src = f" · [原文]({c['src']})" if c['src'] else ''  # 补充章节没有对应原站文章
        w(f"- [ ] [{c['title']}]({c['out']}) · {status(c)}{src}")
w('')
w('## 配套代码')
w('')
w('第 0–4 部分的代码有 Node（TypeScript）和 Python 两版，逻辑一一对应，正文默认展示 Node 版，代码块上方的标签页可以切到 Python。')
w('第 5–6 部分是 PyTorch 训练，只有 Python 版。')
w('')
w('| 目录 | 内容 | 运行 |')
w('|---|---|---|')
w('| `code/agent-node/` | 第 0–3 部分的示例（Node 版）：hook 演示、chatbot、RAG、MCP server、抓包代理 | `cd code/agent-node && npm ci && npm test` |')
w('| `code/mini_cc-node/` | 第 4 部分的 mini Claude Code（Node 版） | `cd code/mini_cc-node && npm ci && node mini_cc/cli.ts` |')
w('| `code/agent/` | 同上，Python 版 | `cd code/agent && uv run pytest -q` |')
w('| `code/mini_cc/` | 同上，Python 版；`CHANGELOG.md` 记录每章增量 | `cd code/mini_cc && uv run python -m mini_cc` |')
w('| `code/ml/` | 第 5–6 部分的手写算法，均与 sklearn / torch 对拍 | `cd code/ml && uv run pytest -q` |')
w('')
w('Node 版需要 Node 24 以上，直接运行 `.ts` 文件，没有构建步骤。')
w('')
w('所有测试都跑离线 fake 模型，不消耗 API。要连真实模型，设置 `ANTHROPIC_API_KEY`（可选 `ANTHROPIC_BASE_URL`）。')
w('')
w('## 维护')
w('')
w('- 网页版预览：`cd .site && uv run mkdocs serve`，打开 http://127.0.0.1:8000（导航按 `curriculum.json` 自动生成，新章节写出来刷新就有；新增**部分目录**时先跑 `python3 tools/build_site.py`）')
w('- 章节清单的唯一来源是 `curriculum.json`，「部分」的顺序、标题、简介在 `tools/parts.py`；改完重跑 `python3 tools/build_readme.py`，再跑 `python3 tools/check_path.py` 检查章间衔接')
w('- 写作规范：`STYLE.md`')
w('- 原站更新了新章节：重新抓 sitemap（`/sitemap.xml` 里 `/zh/ai-coding/` 开头的地址），在 `curriculum.json` 里追加')
open(os.path.join(ROOT, 'README.md'), 'w').write('\n'.join(lines) + '\n')
print('README.md written,', len(cur), 'chapters')
