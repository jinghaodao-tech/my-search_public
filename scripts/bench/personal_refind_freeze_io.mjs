import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { IMPLEMENTATION_FILES } from './personal_refind_freeze.mjs';
import { captureGitState, captureHostState } from './search_run_provenance.mjs';

const repositoryRoot = fs.realpathSync('.');
const privateRoot = fs.realpathSync('quality/e2e/local/personal-refind');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const SAVED_CARD_COLUMNS = 'id,title,body,summary,url,type,color,tags_json,links_json,kj_group_id,archived,archived_at,tokens_json,doc_length,morphological_tokens_json,ngram_tokens_json,morphological_doc_length,ngram_doc_length,created_at,updated_at';
const FTS_COLUMNS = { cards_fts: 'id,title,body,summary,tags', cards_morph_fts: 'id,tokens', cards_ngram_fts: 'id,tokens' };

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolvePrivatePath(value, { mustExist = true, allowRoot = false } = {}) {
  const absolute = path.resolve(value);
  if (mustExist) {
    const real = fs.realpathSync(absolute);
    if (!isWithin(privateRoot, real) || (real === privateRoot && !allowRoot)) throw Error('Freeze inputs must stay inside the private evaluation directory');
    return real;
  }
  const parent = fs.realpathSync(path.dirname(absolute));
  if (!isWithin(privateRoot, parent) || parent === privateRoot) throw Error('Freeze outputs must stay inside a private subdirectory');
  if (fs.existsSync(absolute)) throw Error('Freeze output already exists');
  return absolute;
}

export function fingerprintSavedCardCorpus(db) {
  const digest = crypto.createHash('sha256');
  const articleIds = new Set();
  const createdAtById = new Map();
  digest.update('cards\0');
  let count = 0;
  for (const row of db.prepare(`SELECT ${SAVED_CARD_COLUMNS} FROM cards ORDER BY id`).iterate()) {
    articleIds.add(row.id);
    createdAtById.set(row.id, row.created_at);
    digest.update(JSON.stringify(row)).update('\n');
    count++;
  }
  for (const [table, query] of [
    ['card_tags', 'SELECT card_id,tag,created_at FROM card_tags ORDER BY card_id,tag'],
    ['card_links', 'SELECT source_card_id,target_card_id,created_at FROM card_links ORDER BY source_card_id,target_card_id'],
  ]) {
    digest.update(`${table}\0`);
    for (const row of db.prepare(query).iterate()) digest.update(JSON.stringify(row)).update('\n');
  }
  return { sha256: digest.digest('hex'), count, articleIds, createdAtById };
}

export function fingerprintSavedCardFtsIndexes(db) {
  return Object.fromEntries(Object.entries(FTS_COLUMNS).map(([table, columns]) => {
    const exists = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!exists) return [table, null];
    const digest = crypto.createHash('sha256');
    let count = 0;
    for (const row of db.prepare(`SELECT ${columns} FROM ${table} ORDER BY id`).iterate()) {
      digest.update(JSON.stringify(row)).update('\n');
      count++;
    }
    return [table, { count, sha256: digest.digest('hex') }];
  }));
}

function loadRecords(directory, prefix) {
  return fs.readdirSync(directory).filter(name => name.startsWith(prefix) && name.endsWith('.json')).sort()
    .map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
}

function hashProjectPath(relative) {
  const absolute = fs.realpathSync(path.resolve(repositoryRoot, relative));
  if (!isWithin(repositoryRoot, absolute)) throw Error('Implementation fingerprint path escapes the repository');
  const data = fs.readFileSync(absolute);
  return { path: path.relative(repositoryRoot, absolute).replaceAll(path.sep, '/'), sha256: hash(data) };
}

function hashModelArtifact(config) {
  const model = config.model;
  if (model == null) return null;
  if (typeof model !== 'object' || typeof model.id !== 'string' || !model.id.trim()) throw Error('Model configuration must name the exact local model');
  if (typeof model.artifactPath !== 'string' || !model.artifactPath.trim()) throw Error('A local model must provide its artifactPath');
  if (typeof model.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(model.sha256)) throw Error('A local model must provide its artifact SHA-256');
  const absolute = fs.realpathSync(path.resolve(repositoryRoot, model.artifactPath));
  if (!isWithin(repositoryRoot, absolute)) throw Error('Model artifact must be inside the repository');
  const digest = crypto.createHash('sha256');
  const visit = current => {
    const link = fs.lstatSync(current);
    if (link.isSymbolicLink()) throw Error('Model artifacts cannot contain symbolic links');
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      digest.update('directory\0').update(path.relative(absolute, current).replaceAll(path.sep, '/')).update('\0');
      for (const name of fs.readdirSync(current).sort()) {
        visit(path.join(current, name));
      }
    } else {
      digest.update('file\0').update(path.relative(absolute, current).replaceAll(path.sep, '/')).update('\0');
      const bytes = fs.readFileSync(current);
      digest.update(String(bytes.length)).update('\0').update(bytes);
    }
  };
  visit(absolute);
  const artifactSha256 = digest.digest('hex');
  if (model.sha256.toLowerCase() !== artifactSha256) throw Error('Declared model hash does not match the local artifact');
  return { id: model.id, artifactPath: path.relative(repositoryRoot, absolute).replaceAll(path.sep, '/'), artifactSha256 };
}

export function readFreezeInputs({ recordsDirectory, developmentDirectory, corpusPath, configurationPath }) {
  const recordsDir = resolvePrivatePath(recordsDirectory, { allowRoot: true });
  const developmentDir = resolvePrivatePath(developmentDirectory, { allowRoot: true });
  const corpusFile = resolvePrivatePath(corpusPath);
  const configFile = resolvePrivatePath(configurationPath);
  const configuration = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (typeof configuration.method !== 'string' || !configuration.method.trim()) throw Error('Configuration must include the selected method');
  if (!configuration.settings || typeof configuration.settings !== 'object' || Array.isArray(configuration.settings)) throw Error('Configuration must include a settings object');
  if (configuration.paidApiRequired === true) throw Error('A freeze cannot require a paid AI API');

  const priorExposureFiles = ['data/search-evaluation/real-queries.json', 'data/search-evaluation/real-queries-v2.json'];
  const priorExposureRows = priorExposureFiles.flatMap(relative => {
    const file = path.join(repositoryRoot, relative);
    if (!fs.existsSync(file)) throw Error(`Previously used query dataset is missing: ${relative}`);
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(rows)) throw Error(`Previously used query dataset is invalid: ${relative}`);
    return rows;
  });
  const normalizeQuery = query => query.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
  if (priorExposureRows.length !== 50 || priorExposureRows.some(row => typeof row?.query !== 'string' || !row.query.trim())) {
    throw Error('The local prior-exposure registry must contain all 50 previously used saved-card queries');
  }
  const previouslyUsedQueryHashes = priorExposureRows.map(row => hash(normalizeQuery(row.query)));
  if (new Set(previouslyUsedQueryHashes).size !== 50) throw Error('The prior-exposure registry must contain 50 unique normalized query hashes');

  const records = loadRecords(recordsDir, 'personal-final-');
  const developmentRecords = loadRecords(developmentDir, 'personal-dev-');
  const db = new Database(corpusFile, { readonly: true, fileMustExist: true });
  let corpusArticleIds;
  let corpusCreatedAtById;
  let corpusSha256;
  let corpusCount;
  let ftsIndexes;
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw Error('Evaluation corpus failed SQLite integrity_check');
    const corpus = fingerprintSavedCardCorpus(db);
    corpusArticleIds = corpus.articleIds;
    corpusCreatedAtById = corpus.createdAtById;
    corpusSha256 = corpus.sha256;
    corpusCount = corpus.count;
    ftsIndexes = fingerprintSavedCardFtsIndexes(db);
  } finally { db.close(); }

  const implementationFiles = IMPLEMENTATION_FILES.map(hashProjectPath);
  const protocol = hashProjectPath('quality/e2e/docs/PERSONAL-REFIND-PROTOCOL-ja.md');
  const packageLock = hashProjectPath('package-lock.json');
  const model = hashModelArtifact(configuration);
  const priorExposureFileFingerprints = priorExposureFiles.map(hashProjectPath);
  const fingerprints = {
    corpusSha256,
    corpusCount,
    ftsIndexes,
    configurationSha256: hash(fs.readFileSync(configFile)),
    implementationSha256: hash(JSON.stringify(implementationFiles)),
    implementationFiles,
    protocolSha256: protocol.sha256,
    packageLockSha256: packageLock.sha256,
    model,
    previouslyUsedQueryFiles: priorExposureFileFingerprints,
    previouslyUsedQuerySetSha256: hash([...previouslyUsedQueryHashes].sort().join('\n')),
    gitState: captureGitState(repositoryRoot),
    hostState: captureHostState(),
  };
  return {
    finalRecords: records,
    developmentRecords,
    corpusArticleIds,
    corpusCreatedAtById,
    fingerprints,
    previouslyUsedQueryHashes,
    sources: {
      recordsDirectory: path.relative(privateRoot, recordsDir).replaceAll(path.sep, '/'),
      developmentDirectory: path.relative(privateRoot, developmentDir).replaceAll(path.sep, '/'),
      corpusPath: path.relative(privateRoot, corpusFile).replaceAll(path.sep, '/'),
      configurationPath: path.relative(privateRoot, configFile).replaceAll(path.sep, '/'),
      method: configuration.method,
      priorExposure: '50 previously used saved-card benchmark queries; hashes only in the private freeze manifest',
    },
  };
}

export function readManifestInputs(manifest) {
  const sources = manifest?.sources;
  if (!sources || typeof sources.recordsDirectory !== 'string' || typeof sources.developmentDirectory !== 'string'
    || typeof sources.corpusPath !== 'string' || typeof sources.configurationPath !== 'string') throw Error('Freeze manifest is missing input paths');
  const fromPrivate = relative => path.join(privateRoot, relative);
  return readFreezeInputs({
    recordsDirectory: fromPrivate(sources.recordsDirectory),
    developmentDirectory: fromPrivate(sources.developmentDirectory),
    corpusPath: fromPrivate(sources.corpusPath),
    configurationPath: fromPrivate(sources.configurationPath),
  });
}

export function writePrivateManifest(outputPath, content) {
  const target = resolvePrivatePath(outputPath, { mustExist: false });
  fs.writeFileSync(target, JSON.stringify(content, null, 2) + '\n', { flag: 'wx' });
  return target;
}

export function readPrivateManifest(manifestPath) {
  const file = resolvePrivatePath(manifestPath);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
