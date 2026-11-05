#!/usr/bin/env python3
"""Hash tracked/untracked application code as a reproducible local build label.
Does not prove which source code is currently running; verify process/deployment separately.
"""
import argparse,hashlib,pathlib,subprocess,json
p=argparse.ArgumentParser();p.add_argument('--repo',required=True);p.add_argument('--json',action='store_true');a=p.parse_args()
root=pathlib.Path(a.repo).resolve()
if not (root/'server.ts').is_file():raise SystemExit('Expected my-search repository root')
r=subprocess.run(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=root,capture_output=True,check=True)
allowed={'.ts','.tsx','.js','.mjs','.css','.html','.json','.yaml','.yml','.sql'}
exclude_prefix=('quality/','node_modules/','dist/','data/','artifacts/','reports/','test-results/','playwright-report/')
paths=[]
for b in r.stdout.split(b'\0'):
    if not b:continue
    s=b.decode('utf-8',errors='surrogateescape').replace('\\','/')
    if s.startswith(exclude_prefix) or pathlib.PurePosixPath(s).suffix not in allowed or '.env' in s:continue
    f=root/s
    if f.is_file() and not f.is_symlink():paths.append(s)
h=hashlib.sha256()
for s in sorted(set(paths)):
    b=(root/s).read_bytes();h.update(s.encode('utf-8',errors='surrogateescape')+b'\0'+len(b).to_bytes(8,'big')+b)
res={'fingerprint':'sha256:'+h.hexdigest(),'files':len(paths),'method':'working-tree source hash, excluding evaluation kit, runtime data, .env and outputs'}
print(json.dumps(res,indent=2) if a.json else res['fingerprint'])
