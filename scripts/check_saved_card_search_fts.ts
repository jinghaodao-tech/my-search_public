if (!process.env.DB_PATH) throw new Error('Set DB_PATH to the database to inspect.');
const [cardsRepository,{db}]=await Promise.all([
  import('../repositories/cards_repository.js'),
  import('../db/database.js'),
]);
try {
  const status=cardsRepository.savedCardTokenFtsStatus();
  console.log(JSON.stringify({databasePath:process.env.DB_PATH,...status},null,2));
  if(!status.ready) process.exitCode=1;
} finally { db.close(); }
