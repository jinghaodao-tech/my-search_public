import { ensureArticleTokens, loadArticles, saveArticles } from "../collector.js";

const result = loadArticles();

if (!result) {
  console.log("backfilled article tokens: 0");
} else {
  const indexed = await ensureArticleTokens(result, true);
  saveArticles(indexed);
  console.log(`backfilled article tokens: ${indexed.articles.length}`);
}
