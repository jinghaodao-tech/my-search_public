import { expect, test } from '@playwright/test';

// This test intentionally starts with an unreviewed collected candidate.
// Other workspace E2Es seed saved Reader cards directly, so they do not cover
// the boundary between finding an article and using it in a manuscript.
test('a collected search result becomes a verified citation in an exported manuscript', async ({ page, request }) => {
  test.setTimeout(90_000);
  const fixtureId = 'fixture-portfolio-search';
  const quote = '検索した資料を保存し、原文の引用を根拠として完成原稿に残す。';
  const draftTitle = '検索から原稿まで ' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  const collected = await request.post('/api/collect', { data: { fixture: 'portfolio-demo' } });
  expect(collected.ok()).toBeTruthy();
  const previousResponse = await request.get('/api/candidates/' + fixtureId);
  expect(previousResponse.ok()).toBeTruthy();
  const previous = await previousResponse.json();
  if (previous.savedCardId) {
    expect((await request.delete('/api/cards/' + previous.savedCardId)).ok()).toBeTruthy();
  }

  const candidatesResponse = await request.get('/api/candidates');
  expect(candidatesResponse.ok()).toBeTruthy();
  const candidates = await candidatesResponse.json();
  const candidate = candidates.find((item: { candidateId: string }) => item.candidateId === fixtureId);
  expect(candidate).toBeTruthy();

  await page.route('**/api/reader/extract', async route => {
    const { url } = route.request().postDataJSON();
    await route.fulfill({ json: {
      url, title: candidate.title, paragraphs: [quote],
      fetchedAt: new Date().toISOString(), byline: null, siteName: 'fixture',
    } });
  });

  await page.goto('/');
  await page.locator('button[onclick="switchView(\'bm25\')"]').click();
  await page.locator('#search-terms').fill('portfolio');
  await page.locator('#bm25-run-btn').click();
  const result = page.locator('.score-card', { hasText: candidate.title }).first();
  await expect(result).toBeVisible();
  await result.getByRole('button', { name: '読んでメモ' }).click();
  await expect(page.locator('#reader-article')).toContainText(quote);
  await page.locator('#reader-memo').fill('採用判断の根拠候補として記録する。');
  await page.locator('#reader-save-btn').click();
  await expect.poll(async () => {
    const response = await request.get('/api/candidates/' + fixtureId);
    return (await response.json()).status;
  }).toBe('saved_as_card');

  await page.locator('button[data-view="investigations"]').click();
  await page.getByRole('button', { name: 'すべての原稿', exact: true }).click();
  await page.getByRole('button', { name: '＋ 新しい原稿' }).click();
  await page.locator('#document-title').fill(draftTitle);
  const editor = page.locator('#document-markdown');
  await editor.fill('## 採用判断\n\n' + candidate.title + '\n');
  await page.locator('#document-source-search').fill(candidate.title);
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await page.locator('#document-source-results .document-source-row', { hasText: candidate.title })
    .getByRole('button', { name: '資料に追加' }).click();
  await expect(page.locator('#document-sources .document-source-row', { hasText: candidate.title })).toHaveCount(1);

  await editor.evaluate((element: HTMLTextAreaElement, text: string) => {
    const start = element.value.indexOf(text);
    if (start < 0) throw new Error('Source title missing from manuscript');
    element.focus();
    element.setSelectionRange(start, start + text.length);
  }, candidate.title);
  await page.getByRole('button', { name: '選択文から検索' }).click();
  await expect(page.locator('#search-terms')).toHaveValue(candidate.title);
  const savedCardsTarget = page.locator('#search-targets input[value="cards"]');
  if (!(await savedCardsTarget.isChecked())) await savedCardsTarget.check();
  await page.locator('#bm25-run-btn').click();
  const savedResult = page.locator('#search-cards .score-card', { hasText: candidate.title }).first();
  await expect(savedResult).toBeVisible();
  await savedResult.getByRole('button', { name: 'メモを読む' }).click();
  await expect(page.locator('#reader-article [data-index="0"]')).toContainText(quote);
  await page.locator('#reader-article [data-index="0"]').evaluate((element: Element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    if (!selection) throw new Error('Selection API unavailable');
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole('button', { name: '引用を原稿へ追加して戻る' }).click();
  await expect(editor).toHaveValue(/\[\[citation:/);
  await expect(page.locator('#document-citations')).toContainText('verified');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#document-save-state')).toContainText('保存済み');

  const documentsResponse = await request.get('/api/documents?q=' + encodeURIComponent(draftTitle));
  expect(documentsResponse.ok()).toBeTruthy();
  const documents = (await documentsResponse.json()).documents as Array<{ id: string; title: string }>;
  const draft = documents.find(item => item.title === draftTitle);
  expect(draft).toBeTruthy();
  const exportResponse = await request.get('/api/documents/' + draft!.id + '/export.md');
  expect(exportResponse.ok()).toBeTruthy();
  const exported = await exportResponse.text();
  expect(exported).toContain(quote);
  expect(exported).toContain(candidate.title);

  const source = (await (await request.get('/api/candidates/' + fixtureId)).json()).savedCardId as string;
  expect(source).toBeTruthy();
  const usedBy = await request.get('/api/reader/cards/' + source + '/documents');
  expect(usedBy.ok()).toBeTruthy();
  expect((await usedBy.json()).documents.map((item: { id: string }) => item.id)).toContain(draft!.id);
});
