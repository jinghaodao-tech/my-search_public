import { expect, test } from '@playwright/test';

test('saved search survives reload and ranked reading saves a candidate once', async ({ page, request }) => {
  await request.post('/api/collect', { data: { fixture: 'portfolio-demo' } });
  // Fixture candidates may already be saved by another flow; choose one still actionable.
  const candidates = await (await request.get('/api/candidates')).json();
  const candidate = candidates.find((item: { status: string; source: string }) => item.source === 'fixture' && ['unreviewed', 'reviewed_not_saved', 'deferred'].includes(item.status));
  expect(candidate).toBeTruthy();
  await page.route('**/api/reader/extract', async route => {
    const { url } = route.request().postDataJSON();
    await route.fulfill({ json: { url, title: 'Reader test', paragraphs: ['Portfolio article text'], fetchedAt: new Date().toISOString(), byline: null, siteName: 'fixture' } });
  });
  await page.goto('/');
  await page.locator('button[onclick="switchView(\'bm25\')"]').click();
  await expect(page.locator('#mode-tabs button').first()).toBeAttached();
  const name = `継続調査 ${Date.now()}`;
  await page.locator('#saved-search-name').fill(name);
  await page.locator('#search-terms').fill('portfolio');
  await page.getByRole('button', { name: '条件を保存', exact: true }).click();
  await expect(page.locator('#saved-search-select option:checked')).toHaveText(name);
  await page.reload();
  await page.locator('button[onclick="switchView(\'bm25\')"]').click();
  await page.locator('#saved-search-select').selectOption({ label: name });
  await expect(page.locator('#search-terms')).toHaveValue('portfolio');
  await page.locator('#bm25-run-btn').click();
  const result = page.locator('.score-card').filter({ hasText: candidate.title });
  await expect(result).toBeVisible();
  await result.getByRole('button', { name: '読んでメモ' }).click();
  await expect(page.locator('#reader-article')).toContainText('Portfolio article text');
  await page.locator('#reader-memo').fill('保存したメモ');
  await page.locator('#reader-save-btn').click();
  await expect.poll(async () => (await (await request.get(`/api/candidates/${candidate.candidateId}`)).json()).status).toBe('saved_as_card');
  await expect(result).toContainText('保存済みメモを読む');
  await expect(result.getByRole('button', { name: 'カードに保存', exact: true })).toHaveCount(0);
});
