"""第 7 部分是一条主题课程，不是面经与补充材料的拼接。"""
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = [
    '01-interview-landscape.md',
    '02-model-fundamentals.md',
    '03-agent-mechanisms.md',
    '04-production-engineering.md',
    '05-system-design.md',
    '06-project-and-mock.md',
]


class InterviewStructureTests(unittest.TestCase):
    def test_six_topics_in_learning_order(self):
        cur = json.loads((ROOT / 'curriculum.json').read_text())
        chapters = [c for c in cur if c['part'] == 'p7-interview']
        self.assertEqual([Path(c['out']).name for c in chapters], EXPECTED)
        self.assertEqual([c['idx'] for c in chapters], list(range(1, 7)))
        for c in chapters:
            text = (ROOT / c['out']).read_text()
            self.assertEqual(text.splitlines()[0], '# ' + c['title'])

    def test_jd_evidence_is_in_overview_not_separate_chapter(self):
        text = (ROOT / 'p7-interview/01-interview-landscape.md').read_text()
        self.assertIn('能力矩阵', text)
        self.assertIn('xiaomi.jobs.f.mioffice.cn', text)
        self.assertIn('<details>', text)
        self.assertFalse((ROOT / 'p7-interview/04-jd-coverage.md').exists())

    def test_local_links_and_next_chapters(self):
        for i, name in enumerate(EXPECTED):
            path = ROOT / 'p7-interview' / name
            self.assertTrue(path.exists(), name)
            text = path.read_text()
            for href in re.findall(r'\]\(([^)#\s]+\.md)(?:#[^)]*)?\)', text):
                self.assertTrue((path.parent / href).exists(), f'{name}: {href}')
            if i + 1 < len(EXPECTED):
                self.assertIn(f']({EXPECTED[i + 1]})', text)

    def test_matrix_points_to_topic_that_owns_the_content(self):
        overview = (ROOT / 'p7-interview/01-interview-landscape.md').read_text()
        for label, target, content in [
            ('范式题索引', '03-agent-mechanisms.md', 'Plan-and-Execute'),
            ('A2A 概念', '03-agent-mechanisms.md', '## 跨 Agent 通信'),
            ('模型基础与 KV', '02-model-fundamentals.md', 'Attention 的 Q、K、V'),
        ]:
            self.assertIn(f'[{label}]({target})', overview)
            self.assertIn(content, (ROOT / 'p7-interview' / target).read_text())

    def test_footnotes_have_references_and_definitions(self):
        for name in EXPECTED:
            text = (ROOT / 'p7-interview' / name).read_text()
            definitions = set(re.findall(r'^\[\^([^]]+)\]:', text, re.M))
            body = re.sub(r'^\[\^[^]]+\]:.*$', '', text, flags=re.M)
            references = set(re.findall(r'\[\^([^]]+)\]', body))
            self.assertEqual(references, definitions, name)

    def test_node_practice_is_integrated_into_existing_topics(self):
        for name, targets in {
            '01-interview-landscape.md': ['../code/interview-node/README.md', '../code/interview-platform-node/README.md'],
            '03-agent-mechanisms.md': ['../code/interview-node/examples/01-loop.ts', '../code/interview-node/examples/03-grounding.ts'],
            '04-production-engineering.md': ['../code/interview-node/examples/04-recovery.ts', '../code/interview-node/examples/05-approval-cancel.ts'],
            '05-system-design.md': ['../code/interview-node/src/server.ts'],
            '06-project-and-mock.md': ['../code/interview-node/README.md', 'npm run live:smoke'],
        }.items():
            text = (ROOT / 'p7-interview' / name).read_text()
            for target in targets:
                self.assertIn(target, text, name)

    def test_old_public_urls_keep_migration_pages(self):
        for name in ('02-top-questions.md', '03-question-bank.md'):
            text = (ROOT / 'p7-interview' / name).read_text()
            self.assertIn('已整合', text)
            self.assertLess(len(text), 1600)


if __name__ == '__main__':
    unittest.main()
