"""BR-13 contract tests use the worker's actual coordinator without starting its server."""
import ast
from pathlib import Path
from types import SimpleNamespace
import math
import re
from difflib import SequenceMatcher
import unittest

ROOT = Path(__file__).resolve().parents[1]
module = ast.parse((ROOT / 'resources/retrieval_worker.py').read_text())
namespace = dict(SimpleNamespace=SimpleNamespace, math=math, re=re, SequenceMatcher=SequenceMatcher)
for node in module.body:
    if isinstance(node, ast.FunctionDef) and node.name in {'lexical_match_evidence', 'dual_path_hits'}:
        exec(compile(ast.Module(body=[node], type_ignores=[]), 'retrieval_worker.py', 'exec'), namespace)
retrieve = namespace['dual_path_hits']
match = namespace['lexical_match_evidence']


class Version(str):
    @property
    def skill_id(self):
        return str(self)


class Provider:
    initializations = 0

    def __init__(self, hits=(), error=None):
        Provider.initializations += 1
        self.hits, self.error, self.calls = hits, error, 0

    def search(self, query, limit, allowed):
        self.calls += 1
        if self.error:
            raise self.error
        return [hit for hit in self.hits if hit.skill_version in allowed]


class DualPathTests(unittest.TestCase):
    def setUp(self):
        self.values = {Version(key): {'title': title, 'body': body, 'source_uri': f'pkm://notes/{key}'}
                       for key, title, body in [('a', 'Neural networks', 'classification guide'),
                                                 ('b', 'Gradient descent', 'optimization') ]}
        self.lexical = [SimpleNamespace(skill_version='a', rank=1, score=500)]

    def run_search(self, mode, **kwargs):
        return retrieve('neural', mode, self.lexical, self.values, self.values,
                        kwargs.pop('admitted', lambda _: True), configured=kwargs.pop('configured', True),
                        provider=kwargs.pop('provider', None), **kwargs)

    def test_off_never_initializes_or_touches_provider(self):
        class LazyProvider:
            def __getattr__(self, _name):
                Provider()
                raise AssertionError('Unconfigured embedding path was touched')
        Provider.initializations = 0
        provider = LazyProvider()
        for mode in ('lexical', 'semantic', 'dual'):
            hits, status, _ = self.run_search(mode, configured=False, provider=provider)
            self.assertEqual(status, 'off')
            self.assertEqual(len(hits), 0 if mode == 'semantic' else 1)
        self.assertEqual(Provider.initializations, 0)

    def test_exact_keyword_fuzzy_and_field_evidence(self):
        self.assertEqual(match('Neural networks', self.values['a']), ('title', 'exact'))
        self.assertEqual(match('guide classification', self.values['a']), ('body', 'keyword'))
        self.assertEqual(match('netwroks', self.values['a']), ('title', 'fuzzy'))
        hits, _, _ = retrieve('netwroks', 'lexical', [], self.values, self.values, lambda _: True,
                              configured=False, provider=None)
        self.assertEqual(hits[0].source_label, 'from keyword search')
        self.assertEqual(hits[0].path_evidence[0]['match'], 'fuzzy')
        self.assertEqual(hits[0].path_evidence[0]['matched_path'], 'pkm://notes/a')

    def test_rrf_deduplicates_and_preserves_incomparable_raw_scores(self):
        provider = Provider([SimpleNamespace(skill_version='b', rank=1, score=.9),
                             SimpleNamespace(skill_version='a', rank=2, score=.001)])
        hits, status, _ = self.run_search('dual', provider=provider)
        self.assertEqual(status, 'ready')
        self.assertEqual(provider.calls, 1)
        self.assertEqual([hit.skill_version for hit in hits], ['a', 'b'])
        self.assertEqual(hits[0].source_label, 'both')
        self.assertEqual(hits[1].source_label, 'from embedding retrieval')
        self.assertAlmostEqual(hits[0].score, 1 / 61 + 1 / 62)
        self.assertEqual([(e['path'], e['rank'], e['score']) for e in hits[0].path_evidence],
                         [('lexical', 1, 500), ('semantic', 2, .001)])

    def test_lexical_never_calls_even_configured_provider(self):
        provider = Provider(error=AssertionError('must not call'))
        hits, status, _ = self.run_search('lexical', provider=provider)
        self.assertEqual(status, 'off')
        self.assertEqual(provider.calls, 0)
        self.assertEqual(hits[0].sources, ['lexical'])

    def test_failure_is_visible_and_semantic_does_not_substitute_lexical(self):
        for mode, expected in [('semantic', 'unavailable'), ('dual', 'fallback')]:
            provider = Provider(error=RuntimeError('encoder unavailable'))
            hits, status, reason = self.run_search(mode, provider=provider)
            self.assertEqual(status, expected)
            self.assertIn('encoder unavailable', reason)
            self.assertEqual(len(hits), 0 if mode == 'semantic' else 1)
        _, status, reason = self.run_search('dual', provider_error='index building')
        self.assertEqual(status, 'fallback')
        self.assertIn('index building', reason)

    def test_semantic_preserves_provider_rank_not_raw_score_order(self):
        provider = Provider([SimpleNamespace(skill_version='a', rank=1, score=.001),
                             SimpleNamespace(skill_version='b', rank=2, score=900)])
        hits, status, _ = self.run_search('semantic', provider=provider)
        self.assertEqual(status, 'ready')
        self.assertEqual([hit.skill_version for hit in hits], ['a', 'b'])
        self.assertEqual(hits[0].path_evidence[0]['score'], .001)

    def test_scope_filters_both_paths_before_fusion(self):
        provider = Provider([SimpleNamespace(skill_version='a', rank=1, score=1)])
        hits, status, _ = self.run_search('dual', admitted=lambda _: False, provider=provider)
        self.assertEqual(hits, [])
        self.assertEqual(status, 'ready')


if __name__ == '__main__':
    unittest.main()
