import { expect, test, type APIRequestContext } from '@playwright/test';

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function saveSource(request: APIRequestContext, title: string, paragraph: string) {
  const response = await request.post('/api/reader/save', { data: {
    title, url: `https://example.test/${encodeURIComponent(title)}`, fetchedAt: new Date().toISOString(), paragraphs: [paragraph], memo: '', tags: [],
  } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).card as { id: string; title: string };
}

test('organizes shared sources, searches, compares, attaches existing work, and resumes on mobile', async ({ page, request }) => {
  const suffix = stamp();
  const sharedText = 'SQLiteの同時更新を観察し、永続化境界と競合条件を比較する実験記録です。';
  const first = await saveSource(request, `調査資料A ${suffix}`, sharedText);
  const second = await saveSource(request, `調査資料B ${suffix}`, `別条件で${sharedText}`);
  expect((await request.post(`/api/cards/${first.id}/links`, { data: { targetId: second.id } })).ok()).toBeTruthy();
  const documentResponse = await request.post('/api/documents', { data: { title: `関連原稿 ${suffix}`, markdown: '' } });
  expect(documentResponse.ok()).toBeTruthy();
  const document = await documentResponse.json();
  const savedSearchResponse = await request.post('/api/saved-searches', { data: {
    name: `関連検索 ${suffix}`, source: 'cards',
    config: { label: 'test', description: '', k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1, keywords: [{ term: 'SQLite', weight: 1 }] },
    options: { resultLimit: 10 }, filters: { excludedTerms: [], sources: [], status: 'all' },
  } });
  expect(savedSearchResponse.ok()).toBeTruthy();
  const savedSearch = await savedSearchResponse.json();
  const workspaceResponse = await request.post('/api/workspaces', { data: { name: `継続調査 ${suffix}`, purpose: '比較と再発見' } });
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace = await workspaceResponse.json();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.locator('button[data-view="investigations"]').click();
  await expect(page.locator('#investigation-workspace-list')).toContainText(workspace.workspace.name);
  await page.locator('#investigation-source-query').fill(first.title);
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await page.locator('#investigation-source-results .document-source-row', { hasText: first.title }).getByRole('button', { name: '資料に追加' }).click();
  await page.locator('#investigation-source-query').fill(second.title);
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await page.locator('#investigation-source-results .document-source-row', { hasText: second.title }).getByRole('button', { name: '資料に追加' }).click();
  await expect(page.locator('#investigation-sources .investigation-source-row')).toHaveCount(2);

  await page.locator('#investigation-group-name').fill('根拠候補');
  await page.getByRole('button', { name: '分類を追加' }).click();
  await page.locator('#investigation-sources select').first().selectOption({ label: '根拠候補' });
  await expect(page.locator('#investigation-sources select').first()).toHaveValue(/.+/);
  await expect(page.locator('#investigation-graph .investigation-network')).toBeVisible();

  await page.locator('#investigation-compare-purpose').fill('SQLite 同時更新 永続化 競合条件');
  await page.getByRole('button', { name: '保存本文から根拠候補' }).click();
  await expect(page.locator('#investigation-evidence .document-evidence-row').first()).toBeVisible();
  await expect(page.locator('#investigation-evidence')).toContainText('語の一致');

  await page.locator('#investigation-document-select').selectOption(document.document.id);
  await page.getByRole('button', { name: '原稿を追加' }).click();
  await expect(page.locator('#investigation-documents')).toContainText(document.document.title);
  await page.locator('#investigation-search-select').selectOption(savedSearch.id);
  await page.getByRole('button', { name: '保存検索を追加' }).click();
  await expect(page.locator('#investigation-saved-searches')).toContainText(savedSearch.name);

  await page.locator('#investigation-search-query').fill('SQLite 同時更新');
  await page.getByRole('button', { name: '保存記事を検索' }).click();
  await expect(page.locator('#investigation-search-results')).toContainText(first.title);
  await page.reload();
  await page.locator('button[data-view="investigations"]').click();
  await expect(page.locator('#investigation-search-query')).toHaveValue('SQLite 同時更新');
  await expect(page.locator('#investigation-compare-purpose')).toHaveValue('SQLite 同時更新 永続化 競合条件');
  await expect(page.locator('#investigation-sources')).toContainText(first.title);
  await expect(page.locator('#investigation-documents')).toContainText(document.document.title);
  await expect(page.locator('#investigation-saved-searches')).toContainText(savedSearch.name);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#investigation-name')).toBeVisible();
  await expect(page.locator('#investigation-source-query')).toBeVisible();
});
