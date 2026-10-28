"""检查正文里的图：每个 ```d2 代码块都能编译，且不再出现 ```mermaid。

图统一用 D2 写（见 STYLE.md「图」一节），构建时由 mkdocs-d2-plugin 渲染成内联 SVG。
插件遇到语法错误只会把报错塞进页面、不会让构建失败，所以在这里先编译一遍兜底。

用法：
  python3 tools/check_diagrams.py               # 检查全部章节
  python3 tools/check_diagrams.py a.md b.md     # 只查指定文件
  python3 tools/check_diagrams.py --png DIR a.md   # 顺便把每张图渲染成 PNG 放进 DIR，方便目检

另外提示过宽的图：正文约 680px 宽，页面上图最多缩到 0.75 倍（.site/hooks.py 的 D2_MIN_SCALE），
超过 WIDE_PX 就得横向滚动才能看全。时序图的宽度由参与者个数决定，不提示。
"""
import glob
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, '.site'))
from hooks import D2_STYLE  # noqa: E402  与站点构建用同一份样式前缀

FENCE = re.compile(r'^([ \t]*)```(d2|mermaid)[ \t]*\n(.*?)^\1```', re.M | re.S)
# 与 tools/build_site.py 里 d2 插件的配置保持一致
D2_OPTS = ['--layout=elk', '--theme=0', '--pad=20']
WIDE_PX = 900   # 680 / 0.75 ≈ 900
VIEWBOX = re.compile(rb'viewBox="[-\d.]+ [-\d.]+ ([\d.]+) [\d.]+"')


def main(argv):
    png_dir = None
    if argv[:1] == ['--png']:
        png_dir, argv = argv[1], argv[2:]
        os.makedirs(png_dir, exist_ok=True)
    files = argv or sorted(glob.glob(os.path.join(ROOT, 'p*-*/*.md')))
    errors = 0
    count = 0
    for path in files:
        text = open(path, encoding='utf-8').read()
        for i, m in enumerate(FENCE.finditer(text)):
            line = text[:m.start()].count('\n') + 1
            where = f'{os.path.relpath(path, ROOT)}:{line}'
            if m.group(2) == 'mermaid':
                print(f'{where}: 用 D2 画图，不要再用 mermaid')
                errors += 1
                continue
            count += 1
            indent = m.group(1)
            body = ''.join(l[len(indent):] if l.startswith(indent) else l
                           for l in m.group(3).splitlines(keepends=True))
            src = '\n'.join(D2_STYLE) + '\n' + body
            name = f'{os.path.splitext(os.path.basename(path))[0]}-{i}.png' if png_dir else None
            out = os.path.join(png_dir, name) if png_dir else '-'
            r = subprocess.run(['d2', *D2_OPTS, '-', out], input=src.encode(), capture_output=True)
            if r.returncode != 0:
                print(f'{where}: d2 编译失败\n{r.stderr.decode().strip()}')
                errors += 1
                continue
            if not png_dir and 'sequence_diagram' not in body:
                w = float(VIEWBOX.search(r.stdout).group(1))
                if w > WIDE_PX:
                    print(f'{where}: 提示：图宽 {w:.0f}px（> {WIDE_PX}），页面上要横向滚动')
    print(f'{count} 张 d2 图，{errors} 个问题')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
