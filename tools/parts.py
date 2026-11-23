"""「部分」的唯一元数据来源：阅读顺序、显示编号、标题、简介、建议、主线 / 选修。

被 tools/build_readme.py、.site/hooks.py、tools/check_path.py 共用。
章节清单仍在 curriculum.json；这里只管「部分」这一层。

目录前缀是稳定 ID。p0…p8 在 Agent 栏目里按编号展示；p9 保留旧路径，作为独立的算法栏目，不展示编号。
推荐路线由 track 表示：Agent 主线 0→1→2→3→4→7，选修 5→6，第 8 部分是讲义；这些都不影响算法栏目的阅读顺序。
"""

from itertools import groupby

# (id, 显示编号, 标题, 一句话简介, 建议, track)
PARTS = [
    ('p0-core', 0, '核心概念',
     '主线的起点：token、上下文、API，所有后续章节的地基', '⭐ 必读，1 天', 'main'),
    ('p1-tools', 1, 'AI 工具使用技巧',
     '你天天在用的 Claude Code 能力：hooks、subagent、skills；末三章是本地模型和开源模型接入（选读）', '⭐ 08–12 五篇原创必读，01–07 笔记速读（07 必读），13–15 选读；2 天', 'main'),
    ('p2-agent-basics', 2, 'Agent 开发基础',
     '从聊天机器人到 Coding Agent、RAG、可观测性、MCP、工具设计，亲手写一遍', '⭐⭐ 重点，1 周', 'main'),
    ('p3-agent-internals', 3, '工业级 Agent：拆解与生产工程',
     '抓包拆 Claude Code / Codex 的 prompt、压缩、记忆、权限；最后五章讲构建、评测、安全、RAG 评测、成本', '⭐⭐ 重点，1 周', 'main'),
    ('p4-mini-cc', 4, '手搓 mini Claude Code',
     '一个工程从 0 长到 21 个能力，每章一次增量', '⭐⭐⭐ 核心项目，2–3 周', 'main'),
    ('p5-ml', 5, '机器学习基础 + 经典算法',
     '想看懂 LLM 训练再来，从拟合、梯度下降讲起', '选修', 'elective'),
    ('p6-nn-llm', 6, '神经网络 + LLM 开发基础',
     '手写自动求导、优化器、推理全流程、LoRA 微调', '选修', 'elective'),
    ('p7-interview', 7, 'Agent 研发面试',
     '岗位地图 → 模型与训练 → Agent 机制 → 生产工程 → 系统设计 → 项目与模拟', '主线学完后按目标岗位准备', 'main'),
    ('p8-technical-lectures', 8, '技术讲义与科普',
     '三条选读路线：历史与概念、Agent 工程、行业证据与业务落地', '组内递进，组间可跳读', 'supplement'),
    ('p9-algorithms', 9, '数据结构与算法',
     '按专题学习数据结构、搜索、图论、动态规划和数学，用 TypeScript 实验与综合练习自检', '独立路线，可系统学或按面试题型复习', 'supplement'),
]

ORDER = [p[0] for p in PARTS]
BY_ID = {p[0]: p for p in PARTS}
ALGORITHM_PART = 'p9-algorithms'
AGENT_PARTS = [pid for pid in ORDER if pid != ALGORITHM_PART]


def chapter_groups(curriculum, pid):
    """Yield contiguous sections in curriculum order; unlabelled entries stay at part level."""
    chapters = (c for c in curriculum if c['part'] == pid)
    return groupby(chapters, key=lambda c: c.get('section'))


def label(pid):
    """Agent 的讲次带编号；独立栏目只显示标题。"""
    _, n, title, *_ = BY_ID[pid]
    return title if pid == ALGORITHM_PART else f'第 {n} 部分 · {title}'


def nav_label(pid):
    _, n, title, _, _, track = BY_ID[pid]
    if pid == ALGORITHM_PART:
        return title
    return f'{n} · {title}' + ('（选修）' if track == 'elective' else '')
