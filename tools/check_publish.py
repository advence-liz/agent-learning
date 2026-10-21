"""发布前检查：扫描会进入网页版的内容（章节 md + README），决定能不能公开发布。

两级规则：
  BLOCK   密钥、私钥、非本机 IP、公司内部域名 —— 命中即失败，不能放行
  REVIEW  公司 / 项目名、个人工具链、本机路径、花费金额等 —— 默认失败，
          需在 publish/allow.txt 里写上规则名才放行（等于确认「这类内容可以公开」）

用法：
  python3 tools/check_publish.py            # 报告 + 按规则决定退出码（CI 用）
  python3 tools/check_publish.py --verbose  # 额外列出每一处命中的行
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT_DIRS = ['p0-core', 'p1-tools', 'p2-agent-basics', 'p3-agent-internals',
                'p4-mini-cc', 'p5-ml', 'p6-nn-llm']
ALLOW_FILE = os.path.join(ROOT, 'publish', 'allow.txt')

# 明显是示例用的假值：命中 BLOCK 规则但不算泄露
FAKE_MARKERS = re.compile(r'FAKE|EXAMPLE|xxxx|XXXX|\.\.\.|<[^>]+>|ABCDEFGHIJ|0000000000')

BLOCK = {
    'anthropic-key': r'sk-ant-[A-Za-z0-9_-]{16,}',
    'openai-style-key': r'\bsk-[A-Za-z0-9]{32,}',
    'github-token': r'\bgh[pousr]_[A-Za-z0-9]{20,}',
    'linear-key': r'\blin_api_[A-Za-z0-9]{20,}',
    'aws-key': r'\bAKIA[0-9A-Z]{16}\b',
    'private-key': r'-----BEGIN [A-Z ]*PRIVATE KEY-----',
    'bearer-token': r'Bearer [A-Za-z0-9._-]{30,}',
    'public-ip': r'\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b',
    'internal-domain': r'<private>',
}

REVIEW = {
    'company-name': r'<private>',
    'project-webapp': r'<private>',
    'internal-services': r'\b(?:<private>)\b',
    'personal-toolchain': r'\b(?:claude-skills|inject-guardrails|enforce-worktree)\b',
    'local-paths': r'/Users/[^/\s`]+',
    'session-dir-names': r'-Users-[A-Za-z0-9]+-[A-Za-z0-9-]*',
    'session-ids': r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b',
    'spend-amounts': r'\$\d[\d,]*(?:\.\d+)?',
    'cloud-config': r'\b(?:env2|Vertex|CLOUD_ML_REGION|ANTHROPIC_VERTEX_PROJECT_ID)\b',
}

# local-paths 在发布构建时会被 .site/hooks.py 自动改写成 `~`，所以默认就放行
AUTO_REWRITTEN = {'local-paths'}


def files():
    yield os.path.join(ROOT, 'README.md')
    for d in CONTENT_DIRS:
        base = os.path.join(ROOT, d)
        for dirpath, _, names in os.walk(base):
            for n in sorted(names):
                if n.endswith('.md'):
                    yield os.path.join(dirpath, n)


def load_allow():
    if not os.path.exists(ALLOW_FILE):
        return set()
    out = set()
    for line in open(ALLOW_FILE, encoding='utf-8'):
        line = line.split('#', 1)[0].strip()
        if line:
            out.add(line)
    return out


def scan():
    hits = {name: [] for name in list(BLOCK) + list(REVIEW)}
    rules = [(n, re.compile(p)) for n, p in {**BLOCK, **REVIEW}.items()]
    for path in files():
        rel = os.path.relpath(path, ROOT)
        for no, line in enumerate(open(path, encoding='utf-8'), 1):
            for name, rx in rules:
                for m in rx.finditer(line):
                    if name in BLOCK and FAKE_MARKERS.search(line):
                        continue
                    if name == 'public-ip' and not all(0 <= int(x) <= 255 for x in m.group().split('.')):
                        continue  # 版本号之类，不是 IP
                    hits[name].append((rel, no, line.strip()))
    return hits


def main():
    verbose = '--verbose' in sys.argv
    allow = load_allow() | AUTO_REWRITTEN
    unknown = allow - set(REVIEW) - AUTO_REWRITTEN
    hits = scan()
    failed = False

    print('== BLOCK（命中即失败，不能放行）')
    for name in BLOCK:
        n = len(hits[name])
        print(f'  {"✗" if n else "✓"} {name:20s} {n:4d} 处')
        failed |= n > 0
    print('== REVIEW（需在 publish/allow.txt 放行）')
    for name in REVIEW:
        n = len(hits[name])
        nfiles = len({h[0] for h in hits[name]})
        if not n:
            state = '✓'
        elif name in AUTO_REWRITTEN:
            state = '↻'  # 构建时自动改写
        elif name in allow:
            state = '✓'
        else:
            state = '✗'
            failed = True
        note = '（构建时自动改写为 ~）' if name in AUTO_REWRITTEN and n else ('（已放行）' if name in allow and n else '')
        print(f'  {state} {name:20s} {n:4d} 处 / {nfiles:2d} 篇 {note}')
    if unknown:
        print(f'\n⚠️  allow.txt 里有不认识的规则名：{", ".join(sorted(unknown))}')

    if verbose:
        for name, items in hits.items():
            for rel, no, text in items:
                print(f'{name}\t{rel}:{no}\t{text[:160]}')

    if failed:
        print('\n发布检查未通过。BLOCK 项要改正文；REVIEW 项确认可以公开后，把规则名写进 publish/allow.txt。')
        print('看具体位置：python3 tools/check_publish.py --verbose')
        return 1
    print('\n发布检查通过。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
