import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const directory = path.resolve(root, 'quality/e2e/local/personal-refind/study');
const protocolPath = path.join(directory, 'protocol.json');
const eventsPath = path.join(directory, 'events.jsonl');

if (fs.existsSync(protocolPath)) {
  const protocol = JSON.parse(fs.readFileSync(protocolPath, 'utf8'));
  if (protocol.scope !== 'personal-longitudinal' || protocol.build_id !== 'rolling-personal') {
    throw new Error('An incompatible local study already exists; preserve it and resolve it before initializing this collector.');
  }
  const eventLines = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean) : [];
  const collected = eventLines.filter(line => JSON.parse(line).kind === 'session').length;
  console.log(JSON.stringify({ status: 'ALREADY_INITIALIZED', plannedN: protocol.planned_n, collected }));
  process.exit(0);
}
if (fs.existsSync(eventsPath) && fs.readFileSync(eventsPath, 'utf8').trim()) {
  throw new Error('Unregistered local capture events already exist; refusing to overwrite or adopt them.');
}

fs.mkdirSync(directory, { recursive: true });
const protocol = {
  study_id: `personal-refind-${crypto.randomUUID()}`,
  attempt: 1,
  planned_n: 300,
  primary_target_n: 100,
  build_id: 'rolling-personal',
  scope: 'personal-longitudinal',
  target_population: '本人が日常利用で自然に行う保存記事・メモの再発見検索。内容の記憶や関連語を用いた検索を主評価とする。',
  retention: '本人が撤回して削除するまで、このPCのGit除外領域だけに保管。外部送信なし。',
  collection_rule: '最初に記録された300検索を固定し、結果を見て収集を延長しない。最終評価には事前定義された適格基準を満たす最初の100問を使う。',
  created_utc: new Date().toISOString(),
};
fs.writeFileSync(protocolPath, `${JSON.stringify(protocol, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({ status: 'INITIALIZED', plannedNaturalSearches: 300, primaryTarget: 100,
  explicitConsentRequired: true, dataDirectory: 'quality/e2e/local/personal-refind/study' }));
