"""生成 MkDocs 站点配置：.site/mkdocs.yml + .site/docs/（指向各章节目录的软链接）。

新增/改章节后重跑：python3 tools/build_site.py
本地预览：cd .site && uv run mkdocs serve   →  http://127.0.0.1:8000
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, '.site')
DOCS = os.path.join(SITE, 'docs')
cur = json.load(open(os.path.join(ROOT, 'curriculum.json')))

# docs/ 只放软链接：章节目录 + 首页，不暴露 .crawl/ 等原站抓取内容
# （nav 的分组顺序和标题在 .site/hooks.py 的 PARTS 里）
os.makedirs(DOCS, exist_ok=True)
links = {p: os.path.join(ROOT, p) for p in dict.fromkeys(c['part'] for c in cur)}
links['index.md'] = os.path.join(ROOT, 'README.md')
for name, target in links.items():
    path = os.path.join(DOCS, name)
    if os.path.islink(path):
        os.remove(path)
    if not os.path.exists(target):
        os.makedirs(target, exist_ok=True)  # 还没开写的部分先建空目录
    os.symlink(target, path)


yml = f"""# 由 tools/build_site.py 生成，不要手改
site_name: AI 开发学习知识库
docs_dir: docs
site_dir: build
use_directory_urls: false
theme:
  name: material
  language: zh
  features:
    - navigation.sections
    - navigation.expand
    - navigation.footer
    - navigation.top
    - navigation.indexes
    - toc.follow
    - search.highlight
    - search.suggest
    - content.code.copy
  palette:
    - media: "(prefers-color-scheme: light)"
      scheme: default
      primary: indigo
      toggle: {{icon: material/brightness-7, name: 切换到暗色}}
    - media: "(prefers-color-scheme: dark)"
      scheme: slate
      primary: indigo
      toggle: {{icon: material/brightness-4, name: 切换到亮色}}
plugins:
  - search:
      lang: [zh, en]
hooks:
  - hooks.py   # on_config 里按 curriculum.json 动态生成 nav
markdown_extensions:
  - toc: {{permalink: true}}
  - tables
  - admonition
  - attr_list
  - md_in_html
  - footnotes
  - pymdownx.details
  - pymdownx.highlight: {{anchor_linenums: true}}
  - pymdownx.inlinehilite
  - pymdownx.tasklist: {{custom_checkbox: true}}
  - pymdownx.arithmatex: {{generic: true}}
  - pymdownx.superfences:
      custom_fences:
        - name: mermaid
          class: mermaid
          format: !!python/name:pymdownx.superfences.fence_code_format
extra_javascript:
  - https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-mml-chtml.js
"""

open(os.path.join(SITE, 'mkdocs.yml'), 'w').write(yml)
print('mkdocs.yml + docs/ symlinks written')
