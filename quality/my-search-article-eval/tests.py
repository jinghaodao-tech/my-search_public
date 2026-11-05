import json, tempfile, unittest
from pathlib import Path
from scripts import collect_articles as c
from scripts import design_and_judge as d
from scripts import summarize_benchmarks as summary

class Tests(unittest.TestCase):
    def test_exact_threshold(self):
        self.assertEqual(d.min_success(500),485)
        self.assertEqual(d.min_success(1200),1155)
        self.assertLess(d.lower_bound(1154,1200),.95)
        self.assertGreater(d.lower_bound(1155,1200),.95)
        self.assertAlmostEqual(d.logbinom_tail(0,5,.95),1)
    def test_percentile_summary(self):
        self.assertEqual(summary.percentile([4,1,3,2],.5),3)
    def test_deduplicate_url(self):
        a=c.record('zenn','TEST','https://zenn.dev/u/articles/a?ref=foo')
        b=c.record('zenn','TEST','https://zenn.dev/u/articles/a?ref=bar')
        self.assertEqual(a['id'],b['id'])
    def test_record_provenance_without_body(self):
        a=c.record('qiita','A post','https://qiita.com/user/items/abc')
        self.assertEqual(a['retrieval_method'],'official_qiita_api')
        self.assertTrue(a['retrieved_at_utc'].endswith('+00:00'))
        self.assertFalse(a['body_included'])
        self.assertNotIn('body',a)
    def test_exact_title_duplicates_are_only_collapsed_in_derived_corpus(self):
        with tempfile.TemporaryDirectory() as t:
            base=c.record('qiita','Same title','https://qiita.com/u/items/a')
            repost=c.record('zenn','Same title','https://zenn.dev/u/articles/b')
            other=c.record('qiita','Other title','https://qiita.com/u/items/c')
            manifest=c.save(Path(t),{x['id']:x for x in [base,repost,other]},[],10,2)
            raw=(Path(t)/'articles.jsonl').read_text(encoding='utf8').splitlines()
            unique=(Path(t)/'articles_unique_titles.jsonl').read_text(encoding='utf8').splitlines()
            self.assertEqual(len(raw),3)
            self.assertEqual(len(unique),2)
            self.assertEqual(manifest['exact_title_deduplicated_count'],2)
    def test_rss(self):
        raw=b'<rss><channel><item><title>A doc</title><link>https://zenn.dev/u/articles/a</link><description>Summary</description></item></channel></rss>'
        old=c.get
        try:
            c.get=lambda url,token=None:(raw,{})
            rows=c.zenn_feed('typescript')
        finally:c.get=old
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['source'],'zenn')
    def test_sealed_plan(self):
        with tempfile.TemporaryDirectory() as t:
            t=Path(t)
            docs=[{'id':f'd{i:05d}','source':'qiita','url':f'https://qiita.com/p/{i}','title':'test'} for i in range(2100)]
            (t/'docs.jsonl').write_text('\n'.join(json.dumps(x) for x in docs),encoding='utf8')
            class A:pass
            a=A();a.output=str(t/'plan');a.corpus=str(t/'docs.jsonl');a.minimum_docs=2000
            d.plan(a)
            with (t/'plan/sealed_holdout_annotation_blank.csv').open(encoding='utf-8',newline='') as f:
                self.assertEqual(len(list(__import__('csv').DictReader(f))),1200)
            self.assertFalse(json.loads((t/'plan/study_plan.json').read_text())['queries_are_currently_present'])

if __name__=='__main__':unittest.main()
