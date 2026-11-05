#!/usr/bin/env python3
"""Download and integrity-check the complete official MIRACL Japanese corpus."""
from __future__ import annotations
import argparse
import gzip
import hashlib
import json
from pathlib import Path

REPO = 'miracl/miracl-corpus'
REVISION = 'd921ec7e349ce0d28daf30b2da9da5ee698bef0d'
EXPECTED_ROWS = 6_953_614

def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    from huggingface_hub import HfApi, hf_hub_download

    api = HfApi()
    files = list(api.list_repo_tree(REPO, repo_type='dataset', revision=REVISION,
                                    path_in_repo='miracl-corpus-v1.0-ja', recursive=True))
    files = sorted((item for item in files if item.path.endswith('.jsonl.gz')),
                   key=lambda item: int(Path(item.path).name.rsplit('-', 1)[-1].split('.', 1)[0]))
    if len(files) != 14:
        raise RuntimeError(f'Expected 14 official Japanese shards; found {len(files)}')
    total_remote_bytes = sum(int(item.size or 0) for item in files)
    args.out.mkdir(parents=True, exist_ok=True)
    shard_rows = []
    seen = set()
    count = 0
    for remote in files:
        path = Path(hf_hub_download(repo_id=REPO, repo_type='dataset', filename=remote.path,
                                    revision=REVISION, local_dir=str(args.out)))
        rows = 0
        with gzip.open(path, 'rt', encoding='utf-8') as stream:
            for line_number, line in enumerate(stream, 1):
                row = json.loads(line)
                doc_id = row.get('docid')
                if not doc_id or not isinstance(row.get('text'), str) or not row['text'].strip():
                    raise ValueError(f'Invalid row {path.name}:{line_number}')
                if doc_id in seen:
                    raise ValueError(f'Duplicate MIRACL docid: {doc_id}')
                seen.add(doc_id)
                rows += 1
        count += rows
        shard_rows.append({'path': remote.path, 'bytes': path.stat().st_size,
                           'rows': rows, 'sha256': digest(path),
                           'upstream_lfs_oid': getattr(getattr(remote, 'lfs', None), 'oid', None)})
        print(f'checked {path.name}: {rows:,} rows', flush=True)
    if count != EXPECTED_ROWS:
        raise RuntimeError(f'Official corpus count mismatch: expected {EXPECTED_ROWS:,}, got {count:,}')
    manifest = {
        'dataset': REPO,
        'revision': REVISION,
        'license': 'Apache-2.0 (dataset card metadata; underlying Wikipedia content retains its source terms)',
        'language': 'ja',
        'document_count': count,
        'shard_count': len(shard_rows),
        'remote_compressed_bytes': total_remote_bytes,
        'downloaded_compressed_bytes': sum(x['bytes'] for x in shard_rows),
        'shards': shard_rows,
        'integrity': 'all JSONL rows parsed; docids unique; text non-empty; row count matches official dataset card',
    }
    (args.out / 'corpus_manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: manifest[k] for k in ('dataset','revision','document_count','shard_count','remote_compressed_bytes','downloaded_compressed_bytes')}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
