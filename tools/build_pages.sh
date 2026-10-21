#!/usr/bin/env bash
# 构建 GitHub Pages 用的静态站点，和 .github/workflows/pages.yml 走同一套步骤。
# 本地跑一遍 = 提前看到 CI 会不会过、发布出去长什么样。
#
#   tools/build_pages.sh                     # 默认仓库地址占位，只用来本地验证
#   KB_REPO_URL=https://github.com/<user>/<repo> tools/build_pages.sh
#   tools/build_pages.sh --skip-check        # 跳过发布检查（只看构建效果，不要拿去发布）
#
# 产物：.site/build/   本地预览：python3 -m http.server -d .site/build 8001
set -euo pipefail
cd "$(dirname "$0")/.."

: "${KB_REPO_URL:=https://github.com/OWNER/REPO}"
: "${KB_REPO_REF:=main}"
: "${KB_SITE_URL:=}"
export KB_REPO_URL KB_REPO_REF KB_SITE_URL

if [[ "${1:-}" != "--skip-check" ]]; then
  echo "== 发布检查"
  python3 tools/check_publish.py
fi

echo "== 生成站点配置"
python3 tools/build_site.py

echo "== 构建"
cd .site
uv sync --frozen -q
rm -rf build
uv run --frozen mkdocs build 2>&1 | grep -vE "is not found among documentation files" || true
test -f build/index.html

echo "== 产物自检"
# 发布模式下不应残留本机绝对路径和 vscode:// 链接
leaks=$(grep -rlE '/Users/[A-Za-z]|vscode://file' build --include='*.html' || true)
if [[ -n "$leaks" ]]; then
  echo "构建产物里还有本机路径或 vscode 链接：" >&2
  echo "$leaks" >&2
  exit 1
fi
echo "OK：$(find build -name '*.html' | wc -l | tr -d ' ') 个页面 → .site/build/"
