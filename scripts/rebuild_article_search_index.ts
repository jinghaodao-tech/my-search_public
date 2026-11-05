if (!process.env.DB_PATH) throw new Error('Set DB_PATH explicitly before rebuilding the derived article FTS index.');

const { db } = await import('../db/database.js');
try {
  db.transaction(() => {
    db.exec('DELETE FROM articles_morph_fts; DELETE FROM articles_ngram_fts;');
    db.exec(`
      INSERT INTO articles_morph_fts(id,tokens)
      SELECT a.id, COALESCE((SELECT group_concat(value,' ') FROM json_each(CASE WHEN json_valid(COALESCE(r.tokens_json,a.morphological_tokens_json,a.tokens_json,'[]')) THEN COALESCE(r.tokens_json,a.morphological_tokens_json,a.tokens_json,'[]') ELSE '[]' END)),'')
      FROM articles a LEFT JOIN article_reader_content r ON r.article_id=a.id;
      INSERT INTO articles_ngram_fts(id,tokens)
      SELECT a.id, COALESCE((SELECT group_concat(value,' ') FROM json_each(CASE WHEN json_valid(COALESCE(r.tokens_json,a.ngram_tokens_json,a.tokens_json,'[]')) THEN COALESCE(r.tokens_json,a.ngram_tokens_json,a.tokens_json,'[]') ELSE '[]' END)),'')
      FROM articles a LEFT JOIN article_reader_content r ON r.article_id=a.id;
    `);
  })();
  const result = {
    articles: Number((db.prepare('SELECT COUNT(*) AS count FROM articles').get() as { count: number }).count),
    morphologyRows: Number((db.prepare('SELECT COUNT(*) AS count FROM articles_morph_fts').get() as { count: number }).count),
    ngramRows: Number((db.prepare('SELECT COUNT(*) AS count FROM articles_ngram_fts').get() as { count: number }).count),
  };
  console.log(JSON.stringify({ ok: result.articles === result.morphologyRows && result.articles === result.ngramRows, ...result }, null, 2));
  if (result.articles !== result.morphologyRows || result.articles !== result.ngramRows) process.exitCode = 1;
} finally {
  db.close();
}
