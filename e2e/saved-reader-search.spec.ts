import { expect, test } from '@playwright/test';

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test('finds a phrase only in the saved Reader tail from both search screens and opens its source paragraph', async ({ page, request }) => {
  const suffix = stamp();
  const title = `Reader全文検索 ${suffix}`;
  const phrase = `後半だけの天体観測手順 ${suffix}`;
  const paragraphs = [
    '導入には検索語がありません。'.repeat(1000),
    `${'関連説明が続きます。'.repeat(1000)}${phrase}を確認する最終段落です。`,
  ];
  const saved = await request.post('/api/reader/save', { data: {
    title,
    url: `https://example.test/${encodeURIComponent(title)}`,
    fetchedAt: new Date().toISOString(),
    paragraphs,
    memo: '',
    tags: [],
  } });
  expect(saved.status()).toBe(201);

  await page.goto('/');
  await page.locator('#search-input').fill(phrase);
  const card = page.locator('#card-grid .card', { hasText: title });
  await expect(card).toBeVisible();

  await page.locator('button[onclick="switchView(\'bm25\')"]').click();
  const cardTarget = page.locator('#search-targets input[value="cards"]');
  if (!(await cardTarget.isChecked())) await cardTarget.check();
  await page.locator('#search-terms').fill(phrase);
  await page.locator('#bm25-run-btn').click();
  const result = page.locator('#search-cards .score-card', { hasText: title });
  await expect(result).toBeVisible();
  await expect(result).toContainText(phrase);
  await result.getByRole('button', { name: '本文の該当箇所を見る' }).click();
  await expect(page.locator('#reader-search-passage-choice')).toContainText('一意な一致を確認');
  await expect(page.locator('#reader-article [data-index="1"]')).toHaveClass(/quote-flash/);
});
