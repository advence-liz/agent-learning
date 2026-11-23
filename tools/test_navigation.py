"""目录按编号展示，推荐路线保留主线 / 选修分流。运行：python3 -m unittest discover -s tools -p 'test_*.py'"""
import importlib.util
import json
from pathlib import Path
import unittest

from parts import ORDER, PARTS

ROOT = Path(__file__).resolve().parents[1]


class NavigationTests(unittest.TestCase):
    def test_parts_display_in_numeric_order(self):
        self.assertEqual([p[1] for p in PARTS], list(range(10)))
        self.assertEqual(ORDER[-1], 'p9-algorithms')

    def test_algorithms_are_an_independent_track_and_all_pages_are_scanned(self):
        import check_publish

        group = 'p9-algorithms'
        self.assertEqual(next(p[-1] for p in PARTS if p[0] == group), 'supplement')
        curriculum = json.loads((ROOT / 'curriculum.json').read_text())
        entries = [c for c in curriculum if c['part'] == group]
        self.assertTrue(entries[0]['out'].endswith('/00-guide.md'))
        self.assertEqual([c['idx'] for c in entries], list(range(len(entries))))
        chapters = {ROOT / c['out'] for c in entries}
        self.assertEqual(chapters, set((ROOT / group).glob('*.md')))
        self.assertTrue(chapters <= {Path(p) for p in check_publish.files()})
        text = (ROOT / 'README.md').read_text()
        self.assertTrue(all(f']({c["out"]})' in text for c in entries))

    def test_recommended_main_track_can_skip_electives(self):
        self.assertEqual([p[0] for p in PARTS if p[-1] == 'main'], [
            'p0-core', 'p1-tools', 'p2-agent-basics', 'p3-agent-internals',
            'p4-mini-cc', 'p7-interview',
        ])

    def test_site_groups_agent_and_algorithms_into_peer_tabs(self):
        spec = importlib.util.spec_from_file_location('site_hooks', ROOT / '.site/hooks.py')
        hooks = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hooks)
        nav = hooks.on_config({})['nav']
        self.assertEqual([next(iter(item)) for item in nav], ['首页', 'Agent 研发', '数据结构与算法'])
        self.assertEqual(nav[0]['首页'], 'index.md')
        agent = nav[1]['Agent 研发']
        self.assertEqual(agent[0], {'Agent 导读': 'p0-core/00-guide.md'})
        self.assertEqual([int(next(iter(group)).split(' · ')[0]) for group in agent[1:]], list(range(9)))
        curriculum = json.loads((ROOT / 'curriculum.json').read_text())
        expected_agent = [c['out'] for c in curriculum if c['part'] != 'p9-algorithms']
        def chapter_paths(items):
            for item in items:
                path = next(iter(item.values()))
                if isinstance(path, list):
                    yield from chapter_paths(path)
                else:
                    yield path

        self.assertEqual(list(chapter_paths(agent[1:])), expected_agent)
        self.assertEqual([next(iter(page.values())) for page in nav[2]['数据结构与算法']], [
            c['out'] for c in curriculum if c['part'] == 'p9-algorithms'
        ])

    def test_footer_links_do_not_cross_tracks(self):
        from types import SimpleNamespace

        spec = importlib.util.spec_from_file_location('site_hooks', ROOT / '.site/hooks.py')
        hooks = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hooks)
        agent = SimpleNamespace(parent=None)
        algorithms = SimpleNamespace(parent=None)
        agent_part = SimpleNamespace(parent=agent)
        a = SimpleNamespace(parent=agent_part, previous_page=None, next_page=None)
        b = SimpleNamespace(parent=agent_part, previous_page=a, next_page=None)
        c = SimpleNamespace(parent=algorithms, previous_page=b, next_page=None)
        a.next_page, b.next_page = b, c
        hooks.on_nav(SimpleNamespace(pages=[a, b, c]))
        self.assertIs(a.next_page, b)
        self.assertIs(b.previous_page, a)
        self.assertIsNone(b.next_page)
        self.assertIsNone(c.previous_page)

    def test_readme_sections_match_display_order(self):
        text = (ROOT / 'README.md').read_text()
        offsets = [text.index(f'<a id="{pid}"></a>') for pid in [
            'p0-core', 'p1-tools', 'p2-agent-basics', 'p3-agent-internals',
            'p4-mini-cc', 'p5-ml', 'p6-nn-llm', 'p7-interview', 'p8-technical-lectures',
            'p9-algorithms',
        ]]
        self.assertEqual(offsets, sorted(offsets))

    def test_technical_lectures_are_in_publish_scan(self):
        import check_publish

        group = ROOT / 'p8-technical-lectures'
        chapters = list(group.glob('*.md'))
        self.assertTrue(set(chapters) <= {Path(p) for p in check_publish.files()})


    def test_technical_lectures_list_one_codebase_search_chapter(self):
        curriculum = json.loads((ROOT / 'curriculum.json').read_text())
        chapters = [c['out'] for c in curriculum if c['part'] == 'p8-technical-lectures']
        canonical = 'p8-technical-lectures/02-codebase-search.md'
        legacy = 'p8-technical-lectures/03-repomap-and-agentic-search.md'
        self.assertIn(canonical, chapters)
        self.assertNotIn(legacy, chapters)
        self.assertIn('](02-codebase-search.md)', (ROOT / legacy).read_text())


    def test_harness_guide_is_registered_as_a_supplement(self):
        curriculum = json.loads((ROOT / 'curriculum.json').read_text())
        guide = 'p8-technical-lectures/07-claude-code-harness-guide.md'
        entries = [chapter for chapter in curriculum if chapter['out'] == guide]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]['part'], 'p8-technical-lectures')
        self.assertTrue((ROOT / guide).is_file())


    def test_history_industry_and_business_have_distinct_supplement_pages(self):
        curriculum = json.loads((ROOT / 'curriculum.json').read_text())
        chapters = [c['out'] for c in curriculum if c['part'] == 'p8-technical-lectures']
        history = 'p8-technical-lectures/08-ai-history.md'
        business = 'p8-technical-lectures/09-ai-business-adoption.md'
        self.assertEqual(chapters[0], 'p8-technical-lectures/00-reading-guide.md')
        self.assertEqual(chapters[1], history)
        industry = 'p8-technical-lectures/10-ai-industry-watch.md'
        for page in (history, industry, business):
            self.assertEqual(chapters.count(page), 1)
            self.assertTrue((ROOT / page).is_file())

    def test_supplement_groups_match_site_and_readme(self):
        spec = importlib.util.spec_from_file_location('site_hooks', ROOT / '.site/hooks.py')
        hooks = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hooks)
        agent = hooks.on_config({})['nav'][1]['Agent 研发']
        items = agent[-1]['8 · 技术讲义与科普']
        prefix = 'p8-technical-lectures/'
        expected = {
            '认识 AI 与 Agent': ['08-ai-history.md', '04-llm-development.md', '05-agent-etymology.md'],
            '拆开 Agent 看它怎么工作': ['01-agent-runtime-map.md', '02-codebase-search.md', '07-claude-code-harness-guide.md'],
            '判断进展和落地价值': ['06-llm-capability-boundaries.md', '10-ai-industry-watch.md', '09-ai-business-adoption.md'],
        }
        self.assertEqual(list(items[0].values()), [prefix + '00-reading-guide.md'])
        self.assertEqual([next(iter(group)) for group in items[1:]], list(expected))
        readme = (ROOT / 'README.md').read_text().split(f'<a id="{prefix.rstrip("/")}"></a>')[1].split('\n## ')[0]
        for group, (title, files) in zip(items[1:], expected.items()):
            paths = [prefix + name for name in files]
            self.assertEqual([next(iter(chapter.values())) for chapter in group[title]], paths)
            body = readme.split(f'#### {title}\n', 1)[1].split('\n#### ', 1)[0]
            offsets = [body.index(f']({path})') for path in paths]
            self.assertEqual(offsets, sorted(offsets))


if __name__ == '__main__':
    unittest.main()
