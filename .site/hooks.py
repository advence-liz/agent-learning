"""MkDocs hook。

on_config：按 curriculum.json 生成 nav，只收已存在的章节；`mkdocs serve` 每次重建都会重跑，
           所以写作中的新章节写出来就自动出现在导航里。
on_page_markdown：渲染前改写 markdown（源文件不动）：
  1. `<details>` → `<details markdown="1">`，让折叠答案里的 markdown 也被渲染（配合 md_in_html）
  2. 指向 code/ 下源码的相对链接：
     - 本地：vscode://file/ 绝对路径，点击直接在 VS Code 打开
     - 发布（设了 KB_REPO_URL）：GitHub 上对应文件的 blob 链接
  3. 发布时把本机绝对路径收成 `~`（知识库根目录收成仓库内相对路径）

发布模式由环境变量控制（CI 里设置，见 .github/workflows/pages.yml）：
  KB_REPO_URL  仓库地址，如 https://github.com/<user>/<repo>
  KB_REPO_REF  链接指向的提交或分支，默认 main
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 指向站点外仓库文件的链接：配套代码 + 根目录的 STYLE.md
CODE_LINK = re.compile(r'\]\(((?:\.\./)+(?:code/[^)#\s]+|STYLE\.md))(#[^)]*)?\)')
REPO_URL = os.environ.get('KB_REPO_URL', '').rstrip('/')
REPO_REF = os.environ.get('KB_REPO_REF', 'main')
KB_ROOT_PATH = re.compile(r'/Users/[^/\s`"\')]+/(?:[^/\s`"\')]+/)*agent-learn/')
HOME_PATH = re.compile(r'/Users/[^/\s`"\')]+')

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

    def code_link(m):
        path = os.path.normpath(os.path.join(src_dir, m.group(1)))
        line_no = None
        if m.group(2) and re.fullmatch(r'#L(\d+)', m.group(2)):
            line_no = m.group(2)[2:]
        if REPO_URL:
            rel = os.path.relpath(path, ROOT)
            return f'](%s/blob/%s/%s%s)' % (REPO_URL, REPO_REF, rel, f'#L{line_no}' if line_no else '')
        return f'](vscode://file{path}{":" + line_no if line_no else ""})'

    markdown = CODE_LINK.sub(code_link, markdown)
    if REPO_URL:
        # 正文里写死的是作者本机路径（不是 CI 机器的路径），按 macOS 家目录格式匹配
        markdown = KB_ROOT_PATH.sub('', markdown)
        markdown = HOME_PATH.sub('~', markdown)
    return markdown
