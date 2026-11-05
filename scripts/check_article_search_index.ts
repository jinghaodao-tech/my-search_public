if (!process.env.DB_PATH) throw new Error('Set DB_PATH explicitly before checking the article FTS index.');

const { db } = await import('../db/database.js');
try {
  const articles = Number((db.prepare('SELECT COUNT(*) AS count FROM articles').get() as { count: number }).count);
  const morphologyRows = Number((db.prepare('SELECT COUNT(*) AS count FROM articles_morph_fts').get() as { count: number }).count);
  const ngramRows = Number((db.prepare('SELECT COUNT(*) AS count FROM articles_ngram_fts').get() as { count: number }).count);
  const missingTokens = Number((db.prepare("SELECT COUNT(*) AS count FROM articles WHERE COALESCE(morphological_tokens_json,'[]')='[]' OR COALESCE(ngram_tokens_json,tokens_json,'[]')='[]'").get() as { count: number }).count);
  const result = { ok: articles === morphologyRows && articles === ngramRows && missingTokens === 0, articles, morphologyRows, ngramRows, missingTokens };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  db.close();
}
