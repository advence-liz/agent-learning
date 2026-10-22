"""从 curriculum.json 生成知识库首页 README.md。新增/改章节后重跑：python3 tools/build_readme.py"""
import json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cur = json.load(open(os.path.join(ROOT, 'curriculum.json')))

PARTS = {
    'p0-core':            ('第 0 部分 · 核心概念', '主线的起点：token、上下文、API，所有后续章节的地基', '⭐ 必读，1 天'),
    'p1-tools':           ('第 1 部分 · AI 工具使用技巧', '你天天在用的 Claude Code 能力，这次看清它们怎么实现', '⭐ 只读付费 5 章 + 两篇模型文件，2 天'),
    'p3-agent-internals': ('第 2 部分 · 拆解工业级 Agent', '抓包、system prompt、压缩、记忆、权限——Claude Code / Codex 内部', '⭐⭐ 重点，1 周'),
    'p2-agent-basics':    ('第 3 部分 · Agent 开发基础', '从聊天机器人到 Coding Agent、RAG、MCP，亲手写一遍', '⭐⭐ 重点，1 周'),
    'p4-mini-cc':         ('第 4 部分 · 手搓 mini Claude Code', '一个工程从 0 长到 21 个能力，每章一次增量', '⭐⭐⭐ 核心项目，2–3 周'),
    'p5-ml':              ('第 5 部分 · 机器学习基础 + 经典算法', '想看懂 LLM 训练再来，从拟合、梯度下降讲起', '选修'),
    'p6-nn-llm':          ('第 6 部分 · 神经网络 + LLM 开发基础', '手写自动求导、优化器、推理全流程、LoRA 微调', '选修'),
}
ORDER = ['p0-core', 'p1-tools', 'p3-agent-internals', 'p2-agent-basics', 'p4-mini-cc', 'p5-ml', 'p6-nn-llm']

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
w('## 学习路线（为你调整过的顺序）')
w('')
w('你已经是 Claude Code 重度用户，所以顺序和原站不同：**先拆你每天在用的东西，再自己造一个**。机器学习部分是选修，和 Agent 主线相互独立。')
w('')
w('```mermaid')
w('flowchart LR')
w('  P0["0 核心概念<br/>token · 上下文"] --> P1["1 工具技巧<br/>hooks · subagent · skills"]')
w('  P1 --> P2["2 拆解工业级 Agent<br/>抓包 · 压缩 · 记忆 · 权限"]')
w('  P2 --> P3["3 Agent 开发基础<br/>chatbot · RAG · MCP"]')
w('  P3 --> P4["4 手搓 mini Claude Code<br/>21 次增量"]')
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
        w(f"- [ ] [{c['title']}]({c['out']}) · {status(c)} · [原文]({c['src']})")
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
w('- 章节清单的唯一来源是 `curriculum.json`；改完重跑 `python3 tools/build_readme.py`')
w('- 写作规范：`STYLE.md`')
w('- 原站更新了新章节：重新抓 sitemap（`/sitemap.xml` 里 `/zh/ai-coding/` 开头的地址），在 `curriculum.json` 里追加')
open(os.path.join(ROOT, 'README.md'), 'w').write('\n'.join(lines) + '\n')
print('README.md written,', len(cur), 'chapters')
