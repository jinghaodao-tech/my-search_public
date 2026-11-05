const databasePath = process.env.DB_PATH;
if (!databasePath) throw new Error('Set DB_PATH to the database whose derived search index should be rebuilt.');
if (process.env.CARD_SEARCH_INDEX_REBUILD_CONFIRM !== 'REBUILD_DERIVED_INDEX') {
  throw new Error('Set CARD_SEARCH_INDEX_REBUILD_CONFIRM=REBUILD_DERIVED_INDEX to confirm rebuilding derived token/index columns only.');
}

const [cardsRepository,{db}] = await Promise.all([
  import('../repositories/cards_repository.js'),
  import('../db/database.js'),
]);
try {
  const tokenCachesRefreshed = await cardsRepository.backfillCardTokens(true);
  const indexedCards = cardsRepository.rebuildSavedCardTokenFts();
  const status = cardsRepository.savedCardTokenFtsStatus();
  if (!status.ready) throw new Error('Rebuilt card search indexes failed their row-count check: ' + JSON.stringify(status));
  console.log(JSON.stringify({ databasePath, tokenCachesRefreshed, indexedCards, status }, null, 2));
} finally {
  db.close();
}
