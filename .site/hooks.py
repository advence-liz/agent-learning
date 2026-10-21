"""MkDocs hook。

on_config：按 curriculum.json 生成 nav，只收已存在的章节；`mkdocs serve` 每次重建都会重跑，
           所以写作中的新章节写出来就自动出现在导航里。
on_page_markdown：渲染前改写 markdown（源文件不动）：
  1. `<details>` → `<details markdown="1">`，让折叠答案里的 markdown 也被渲染（配合 md_in_html）
  2. 指向 code/ 下源码的相对链接 → vscode://file/ 绝对路径，点击直接在 VS Code 打开
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODE_LINK = re.compile(r'\]\(((?:\.\./)+code/[^)#\s]+)(#[^)]*)?\)')

# 与 tools/build_readme.py 保持一致的学习顺序
PARTS = [
    ('p0-core', '0 · 核心概念'),
    ('p1-tools', '1 · AI 工具使用技巧'),
    ('p3-agent-internals', '2 · 拆解工业级 Agent'),
    ('p2-agent-basics', '3 · Agent 开发基础'),
    ('p4-mini-cc', '4 · 手搓 mini Claude Code'),
    ('p5-ml', '5 · 机器学习基础（选修）'),
    ('p6-nn-llm', '6 · 神经网络 + LLM（选修）'),
]


def on_config(config, **kwargs):
    cur = json.load(open(os.path.join(ROOT, 'curriculum.json')))
    nav = [{'首页': 'index.md'}]
    for part, name in PARTS:
        items = []
        if part == 'p0-core' and os.path.exists(os.path.join(ROOT, 'p0-core/00-guide.md')):
            items.append({'本章导读': 'p0-core/00-guide.md'})
        for c in cur:
            if c['part'] == part and os.path.exists(os.path.join(ROOT, c['out'])):
                items.append({('📖 ' if c['kind'] == 'note' else '') + c['title']: c['out']})
        if items:
            nav.append({name: items})
    config['nav'] = nav
    return config


def on_page_markdown(markdown, page, **kwargs):
    markdown = re.sub(r'<details>', '<details markdown="1">', markdown)
    src_dir = os.path.dirname(os.path.join(ROOT, page.file.src_uri))

    def to_vscode(m):
        path = os.path.normpath(os.path.join(src_dir, m.group(1)))
        line = ''
        if m.group(2) and re.fullmatch(r'#L(\d+)', m.group(2)):
            line = ':' + m.group(2)[2:]
        return f'](vscode://file{path}{line})'

    return CODE_LINK.sub(to_vscode, markdown)
