"""检查学习路径的章间衔接：python3 tools/check_path.py（有问题退出码 1）

阅读序列 = tools/parts.py 的部分顺序 × curriculum.json 里各部分的章节顺序（p0 前面加导读）。
主线和选修是两条链：主线 0→1→2→3→4→7，选修 5→6。

检查两件事：
1. 带「上一章 / 上一篇 / 下一章 / 下一篇 / 下一部分」字样的链接，必须指向序列里真正相邻的那一章。
   字样可以在链接文字里（[上一章](x.md)），也可以紧贴在链接前（下一章：[标题](x.md)）。
2. 每条链上，前一部分的最后一章必须有一个指向下一部分第一章的链接（交界处不能断）。
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parts import PARTS  # noqa: E402

cur = json.load(open(os.path.join(ROOT, 'curriculum.json')))
GUIDE = 'p0-core/00-guide.md'


def chain(track):
    seq = []
    for pid, *_, t in PARTS:
        if t != track:
            continue
        part = [c['out'] for c in cur if c['part'] == pid]
        if pid == 'p0-core':
            part.insert(0, GUIDE)
        seq.append(part)
    return seq


problems = []
prev_of, next_of = {}, {}
for track in ('main', 'elective'):
    parts = chain(track)
    flat = [o for p in parts for o in p]
    for a, b in zip(flat, flat[1:]):
        next_of[a], prev_of[b] = b, a
    # 选修链的起点接在第 0 部分之后：p5 第一章的「上一篇」可以指回 p0 末章
    for left, right in zip(parts, parts[1:]):
        last, first = left[-1], right[0]
        text = open(os.path.join(ROOT, last)).read()
        rel = os.path.relpath(first, os.path.dirname(last))
        if not re.search(r'\]\((?:\./)?' + re.escape(rel) + r'\)', text):
            problems.append(f'{last}: 部分末章没有链到下一部分起点 {first}')

WORDS = r'(上一章|上一篇|下一章|下一篇|下一部分)'
# 字样在链接文字里，或紧贴在链接前（中间只隔冒号、空格）
PAT = re.compile(r'\[' + WORDS + r'[^\]]*\]\(([^)#\s]+\.md)\)|' + WORDS + r'[：:\s]*\[[^\]]*\]\(([^)#\s]+\.md)\)')

for out in [GUIDE] + [c['out'] for c in cur]:
    path = os.path.join(ROOT, out)
    if not os.path.exists(path):
        continue
    in_code = False
    for ln, line in enumerate(open(path), 1):
        if line.lstrip().startswith('```'):
            in_code = not in_code
        if in_code:
            continue
        for m in PAT.finditer(line):
            word = m.group(1) or m.group(3)
            href = m.group(2) or m.group(4)
            tgt = os.path.normpath(os.path.join(os.path.dirname(out), href))
            want = (prev_of if word.startswith('上') else next_of).get(out)
            if word == '下一部分':
                ok = want is not None and tgt == want and tgt.split('/')[0] != out.split('/')[0]
            else:
                ok = tgt == want
            if not ok:
                problems.append(f'{out}:{ln}: 「{word}」指向 {tgt}，按阅读顺序应是 {want}')

for p in problems:
    print('✗', p)
print(f'{"章间衔接有问题" if problems else "章间衔接检查通过"}（{len(problems)} 处）')
sys.exit(1 if problems else 0)
