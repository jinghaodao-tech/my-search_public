import { expect, test, type APIRequestContext } from '@playwright/test';

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function openLibraryView(page: import('@playwright/test').Page, label: string) {
  const menu = page.locator('#topbar .topbar-library');
  await menu.locator('summary').click();
  await menu.getByRole('button', { name: label, exact: true }).click();
}

async function saveTaggedSource(request: APIRequestContext, title: string) {
  const response = await request.post('/api/reader/save', { data: {
    title, url: `https://example.test/${encodeURIComponent(title)}`, fetchedAt: new Date().toISOString(),
    paragraphs: ['タグを詳細設定から扱う検証用本文です。'], memo: '', tags: ['legacy-tag'],
  } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).card as { id: string; title: string };
}

test('tag search and editing are optional advanced actions and preserve existing tags', async ({ page, request }) => {
  const card = await saveTaggedSource(request, `タグ任意確認 ${stamp()}`);
  await page.goto('/');
  await expect(page.locator('#topbar h1')).toHaveText('my-search');
  await expect(page).toHaveTitle('my-search');
  await expect(page.locator('#topbar > .tab-group > button')).toHaveText(['探す', '読む・メモ', '調査']);
  await expect(page.locator('#topbar > .tab-group > details > summary')).toHaveText('保存済み');
  for (const selector of ['#topbar .main-nav > button[data-view="bm25"]', '#topbar .topbar-library > summary', '#topbar .main-nav > button[data-view="investigations"]']) {
    const box = await page.locator(selector).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(64);
  }
  await expect(page.locator('#topbar .topbar-admin > summary')).toHaveText('ツール・設定');
  await expect(page.locator('#topbar [data-view="writing"]')).toHaveCount(0);
  await expect(page.locator('#topbar .topbar-library')).toContainText('記事・メモを管理');
  await expect(page.locator('#topbar .topbar-library')).toContainText('収集した記事を確認');
  await expect(page.locator('#nav-reader-memo')).toBeVisible();
  await expect(page.locator('#bm25-config-header').getByRole('button', { name: '候補レビュー' })).toHaveCount(0);
  await openLibraryView(page, '収集した記事を確認');
  await expect(page.locator('#candidate-view')).toHaveClass(/active/);
  await expect(page.locator('#topbar [data-nav-group="library"]')).toHaveClass(/active/);
  await openLibraryView(page, '記事・メモを管理');
  await expect(page.locator('#sidebar .global-card-views')).toContainText('全カードのグルーピング');
  await expect(page.locator('#sidebar .global-card-views')).toContainText('全カードの関係図');
  await expect(page.locator('#tag-search')).toBeHidden();
  await expect(page.locator('#tag-cloud')).toBeHidden();
  await expect(page.getByText('タグを整理', { exact: true })).toBeHidden();
  await page.locator('.advanced-tag-filter > summary').click();
  await expect(page.locator('#tag-search')).toBeVisible();
  await expect(page.locator('#tag-cloud')).toContainText('legacy-tag');
  await page.locator('.tag-pill', { hasText: 'legacy-tag' }).click();
  await expect(page.locator('#card-grid')).toContainText(card.title);

  await page.evaluate(async id => { await (window as any).openReaderForCard(id); }, card.id);
  const readerTagDetails = page.locator('.reader-tag-details');
  await expect(readerTagDetails).toHaveJSProperty('open', false);
  await expect(page.locator('#reader-tags')).toBeHidden();
  await readerTagDetails.locator('summary').click();
  await expect(page.locator('#reader-tags')).toHaveValue('legacy-tag');
  await page.locator('#reader-tags').fill('legacy-tag追加タグ');
  await page.locator('#reader-save-btn').click();
  const saved = await (await request.get(`/api/reader/cards/${encodeURIComponent(card.id)}`)).json();
  expect(saved.tags).toEqual(['legacy-tag追加タグ']);
});
