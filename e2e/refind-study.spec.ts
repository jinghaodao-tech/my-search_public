import { expect, test } from '@playwright/test';

test('shows voluntary study consent and allows withdrawal before any search is recorded', async ({ page }) => {
  let withdrawalRequests = 0;
  await page.route('**/api/refind-study/status', route => route.fulfill({ json: {
    available: true, preregistered: true, buildMatches: true, scope: 'multi-user', plannedN: 500,
    targetPopulation: 'E2E opt-in control test', retention: 'Raw study data is automatically deleted after 30 days', collected: 0, sealed: false,
  } }));
  await page.route('**/api/refind-study', async route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    withdrawalRequests += 1;
    await route.fulfill({ json: { deleted: true } });
  });
  await page.goto('/');
  await page.locator('button[onclick="switchView(\'bm25\')"]').click();
  const consent = page.locator('#refind-study-consent');
  await expect(consent).not.toBeChecked();
  await page.once('dialog', dialog => dialog.accept());
  await consent.check();
  await expect(consent).toBeChecked();
  await expect(page.locator('#refind-study-status')).toContainText('計画n=500');
  await consent.uncheck();
  await expect(consent).not.toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('mySearch.personalRefindCaptureConsent20261025'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('mySearch.personalRefindCaptureSession20261025'))).toBeNull();
  await page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '参加を撤回してローカル記録を削除' }).click();
  await expect.poll(() => withdrawalRequests).toBe(1);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mySearch.personalRefindCaptureParticipant20261025'))).toBeNull();
});

test('captures an opted-in natural search from the saved-card list and confirms its target there', async ({ page }) => {
  const sessions: Array<Record<string, unknown>> = [];
  const interactions: Array<Record<string, unknown>> = [];
  const adjudications: Array<Record<string, unknown>> = [];
  const card = { id: 'saved-natural-target', title: '保存した対象記事', type: 'article', summary: '要点', body: '本文', tags: [], links: [], createdAt: '2026-10-01T00:00:00.000Z' };
  await page.route('**/api/refind-study/status', route => route.fulfill({ json: {
    available: true, preregistered: true, buildMatches: true, scope: 'personal-longitudinal', plannedN: 300,
    targetPopulation: 'E2E saved-card list capture', retention: 'Local only', collected: 0, sealed: false,
  } }));
  await page.route('**/api/refind-study/sessions', async route => {
    sessions.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { sid: 'list-search-session', startedAt: '2026-10-25T00:00:00.000Z', cardCount: 1 } });
  });
  await page.route('**/api/refind-study/sessions/list-search-session/interactions', async route => {
    interactions.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { ok: true } });
  });
  await page.route('**/api/refind-study/sessions/list-search-session/adjudication', async route => {
    adjudications.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { category: 'memory', status: 'verified' } });
  });
  await page.route('**/api/refind-study/cards', route => route.fulfill({ json: [card] }));
  await page.route('**/api/search/terms', route => route.fulfill({ json: { keywords: [{ term: '記憶した内容', weight: 1 }] } }));
  await page.route('**/api/cards/search', route => route.fulfill({ json: {
    active: [{ article: card, score: 1 }], belowThreshold: [],
    scope: { totalCount: 1, candidateIdsBeforeRerank: [card.id], searchMethod: 'fts5-morph-saved-cards', fallbackUsed: false },
  } }));

  await page.goto('/');
  await page.locator('#refind-study-list-control summary').click();
  const consent = page.locator('#refind-study-consent-list');
  await expect(consent).not.toBeChecked();
  await expect(page.locator('#refind-study-status-list')).toContainText('計画n=300');
  const unconsentedSearch = page.waitForResponse(response => response.url().includes('/api/cards/search')
    && response.request().method() === 'POST');
  await page.locator('#search-input').fill('unrecorded search before consent');
  await unconsentedSearch;
  await expect(page.locator('#card-grid')).toContainText(card.title);
  expect(sessions).toHaveLength(0);
  expect(interactions).toHaveLength(0);

  await page.once('dialog', dialog => dialog.accept());
  await consent.check();
  await expect(page.locator('#refind-study-consent')).toBeChecked();

  const rankedSearch = page.waitForResponse(response => response.url().includes('/api/cards/search')
    && response.request().method() === 'POST');
  await page.locator('#search-input').fill('記憶した内容を探す');
  await rankedSearch;
  await expect(page.locator('#card-grid')).toContainText(card.title);
  await expect(page.locator('#refind-study-list-category')).toBeVisible();
  expect(sessions).toEqual([{ participant: expect.any(String), query: '記憶した内容を探す', consent: true }]);
  await expect.poll(() => interactions.length).toBe(1);
  expect(interactions[0]).toMatchObject({ action: 'search_response', top10: [card.id],
    candidateIdsBeforeRerank: [card.id], actualEngine: 'fts5-morph-saved-cards', httpStatus: 200 });

  await page.locator('#refind-study-list-category').selectOption('memory');
  await page.locator('#refind-study-list-gold-cards').selectOption(card.id);
  await page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '検索を終了して判定を記録' }).click();
  await expect.poll(() => adjudications.length).toBe(1);
  expect(adjudications[0]).toMatchObject({ category: 'memory', goldIds: [card.id], unknown: false, humanChecked: true });
});
