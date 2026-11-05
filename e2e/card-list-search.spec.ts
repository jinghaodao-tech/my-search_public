import { expect, test } from '@playwright/test';

test('searches full-width numeric queries from the saved-card list', async ({ page, request }) => {
  const title = '月5億円分のトークン利用について';
  const created = await request.post('/api/cards', {
    data: { title, body: 'トークン利用額の試算を説明する。', type: 'article', tags: ['budget'] },
  });
  expect(created.status()).toBe(201);
  const card = await created.json() as { id: string };

  try {
    await page.goto('/');
    const rankedSearch = page.waitForResponse(response => response.url().includes('/api/cards/search')
      && response.request().method() === 'POST');
    await page.locator('#search-input').fill('５億');
    const response = await rankedSearch;

    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result.active.some((item: { article?: { id?: string } }) => item.article?.id === card.id)).toBeTruthy();
    await expect(page.locator('#card-grid')).toContainText(title);
  } finally {
    await request.delete(`/api/cards/${card.id}`);
  }
});
