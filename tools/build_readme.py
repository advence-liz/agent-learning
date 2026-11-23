"""从 curriculum.json 生成知识库首页 README.md。新增/改章节后重跑：python3 tools/build_readme.py"""
import json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cur = json.load(open(os.path.join(ROOT, 'curriculum.json')))

import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parts import AGENT_PARTS, ALGORITHM_PART, PARTS as _PARTS, ORDER, chapter_groups, label
PARTS = {pid: (label(pid), desc, advice) for pid, _, _, desc, advice, _ in _PARTS}

def status(c):
    exists = os.path.exists(os.path.join(ROOT, c['out']))
    kind = '📖 笔记' if c['kind'] == 'note' else '✍️ 原创'
    return kind if exists else kind + '（写作中）'

lines = []
w = lines.append
w('# 开发学习知识库')
w('')
w('> **两条独立学习路线**：想做能交付的 AI 应用，选 Agent 研发；想练数据结构、解题与复杂度分析，选数据结构与算法。两边都从自己的导读开始。')
w('')
w('- **[Agent 研发 →](p0-core/00-guide.md)**：从上下文与工具调用入门，拆解工业级实现，手写自己的 Agent，再准备研发面试。')
w('- **[数据结构与算法 →](p9-algorithms/00-guide.md)**：用 TypeScript 练搜索、遍历和动态规划，最后实现任务依赖规划器。不需要模型或 API key。')
w('')
w('## Agent 研发：先跑通，再拆解，最后自己做')
w('')
w('第 0–1 部分打地基，第 2 部分亲手写聊天机器人、Coding Agent、RAG、MCP，第 3 部分拆工业级实现及生产工程，第 4 部分逐步实现 mini Claude Code，最后到第 7 部分准备面试。第 5–6 部分的机器学习和训练按需选修，第 8 部分的技术讲义可独立阅读。')
w('')
w('骨架借鉴 [labuladong 的 AI 开发教程](https://labuladong.online/zh/ai-coding/ai-guide/)。下方 📖 是读书笔记，✍️ 是独立原创课文。勾选框可跟踪进度（编辑 `[ ]` → `[x]`）。')
w('')
w('| 部分 | 讲什么 | 建议 |')
w('|---|---|---|')
for p in AGENT_PARTS:
    t, d, s = PARTS[p]
    w(f'| [{t}](#{p}) | {d} | {s} |')
for p in ORDER:
    t, d, s = PARTS[p]
    w('')
    w(f'<a id="{p}"></a>')
    w(f'## {t}' if p == ALGORITHM_PART else f'### {t}')
    w('')
    w(f'{d}。')
    w('')
    if p == 'p0-core':
        w(f'- [ ] [本章导读](p0-core/00-guide.md) · 📖 笔记 · [原文](https://labuladong.online/zh/ai-coding/ai-guide/)')
    for section, chapters in chapter_groups(cur, p):
        if section:
            w('')
            heading = '###' if p == ALGORITHM_PART else '####'
            w(f'{heading} {section}')
            w('')
        for c in chapters:
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
w('| `code/algorithm-node/` | 算法栏目的 TypeScript 示例、边界测试与任务依赖规划器 | `cd code/algorithm-node && npm test` |')
w('')
w('Node 版需要 Node 24 以上，直接运行 `.ts` 文件，没有构建步骤。')
w('')
w('Agent 相关测试使用离线 fake 模型；算法示例和测试不使用模型。要连真实模型，设置 `ANTHROPIC_API_KEY`（可选 `ANTHROPIC_BASE_URL`）。')
w('')
w('## 维护')
w('')
w('- 网页版预览：`cd .site && uv run mkdocs serve`，打开 http://127.0.0.1:8000（导航按 `curriculum.json` 自动生成，新章节写出来刷新就有；新增**部分目录**时先跑 `python3 tools/build_site.py`）')
w('- 章节清单的唯一来源是 `curriculum.json`，「部分」的顺序、标题、简介在 `tools/parts.py`；改完重跑 `python3 tools/build_readme.py`，再跑 `python3 tools/check_path.py` 检查章间衔接')
w('- 写作规范：`STYLE.md`')
w('- 原站更新了新章节：重新抓 sitemap（`/sitemap.xml` 里 `/zh/ai-coding/` 开头的地址），在 `curriculum.json` 里追加')
open(os.path.join(ROOT, 'README.md'), 'w').write('\n'.join(lines) + '\n')
print('README.md written,', len(cur), 'chapters')
