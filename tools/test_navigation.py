"""目录按编号展示，推荐路线保留主线 / 选修分流。运行：python3 -m unittest discover -s tools -p 'test_*.py'"""
import importlib.util
import json
from pathlib import Path
import unittest

from parts import ORDER, PARTS

ROOT = Path(__file__).resolve().parents[1]


class NavigationTests(unittest.TestCase):
    def test_parts_display_in_numeric_order(self):
        self.assertEqual([p[1] for p in PARTS], list(range(9)))
        self.assertEqual(ORDER[-1], 'p8-technical-lectures')

    def test_recommended_main_track_can_skip_electives(self):
        self.assertEqual([p[0] for p in PARTS if p[-1] == 'main'], [
            'p0-core', 'p1-tools', 'p2-agent-basics', 'p3-agent-internals',
            'p4-mini-cc', 'p7-interview',
        ])

    def test_site_nav_matches_numeric_order(self):
        spec = importlib.util.spec_from_file_location('site_hooks', ROOT / '.site/hooks.py')
        hooks = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hooks)
        config = hooks.on_config({})
        labels = [next(iter(group)) for group in config['nav'][1:]]
        self.assertEqual([int(label.split(' · ')[0]) for label in labels], list(range(9)))
        self.assertTrue(all(next(iter(group.values())) for group in config['nav']))

    def test_readme_sections_match_display_order(self):
        text = (ROOT / 'README.md').read_text()
        offsets = [text.index(f'<a id="{pid}"></a>') for pid in [
            'p0-core', 'p1-tools', 'p2-agent-basics', 'p3-agent-internals',
            'p4-mini-cc', 'p5-ml', 'p6-nn-llm', 'p7-interview', 'p8-technical-lectures',
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
        self.assertEqual(chapters[0], history)
        industry = 'p8-technical-lectures/10-ai-industry-watch.md'
        for page in (history, industry, business):
            self.assertEqual(chapters.count(page), 1)
            self.assertTrue((ROOT / page).is_file())


if __name__ == '__main__':
    unittest.main()
