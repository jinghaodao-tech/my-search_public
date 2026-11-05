import json
from tempfile import TemporaryDirectory
from pathlib import Path
import unittest
from fetch_prepare import make_fixture, prepare, norm_jagov

class TestDataset(unittest.TestCase):
    def test_convert_and_validate(self):
        ds=make_fixture()
        with TemporaryDirectory() as tmp:
            p=Path(tmp)
            m=prepare(*ds,p,'fixture')
            self.assertEqual((m['document_count'],m['query_count'],m['qrel_count']),(2,2,2))
            self.assertEqual(len((p/'qrels.tsv').read_text().splitlines()),2)
            self.assertEqual(len((p/'splits.jsonl').read_text().splitlines()),2)
            self.assertEqual(len(m['sha256']),4)
    def test_missing_corpus_rejected(self):
        d,q,r=make_fixture()
        with TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError,'not in corpus'):
                prepare(d[:-1],q,r,Path(tmp),'bad')
    def test_shared_positive_documents_never_cross_splits(self):
        docs=[{'id':x,'title':'','text':x} for x in ('d1','d2','d3')]
        queries=[{'id':x,'query':x} for x in ('q1','q2','q3')]
        rels=[
            {'query_id':'q1','doc_id':'d1','relevance':1},
            {'query_id':'q1','doc_id':'d2','relevance':1},
            {'query_id':'q2','doc_id':'d2','relevance':1},
            {'query_id':'q3','doc_id':'d3','relevance':1},
        ]
        with TemporaryDirectory() as tmp:
            p=Path(tmp)
            prepare(docs,queries,rels,p,'fixture')
            splits={x['id']:x['split'] for x in map(json.loads,(p/'splits.jsonl').read_text().splitlines())}
            self.assertEqual(splits['q1'],splits['q2'])
if __name__=='__main__':unittest.main()
