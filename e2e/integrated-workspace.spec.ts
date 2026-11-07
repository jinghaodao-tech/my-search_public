import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function saveSource(request: APIRequestContext, title: string, paragraph: string) {
  const response = await request.post('/api/reader/save', { data: {
    title, url: `https://example.test/${encodeURIComponent(title)}`, fetchedAt: new Date().toISOString(), paragraphs: [paragraph], memo: '', tags: [],
  } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).card as { id: string; title: string };
}

test('one workspace can compare three saved sources, insert a verified citation, resume, search, and export', async ({ page, request }) => {
  const suffix = stamp();
  const quote = '有効性と条件を対象範囲に留保して評価する実例文です。';
  const sources = await Promise.all([
    saveSource(request, `比較資料A ${suffix}`, quote),
    saveSource(request, `比較資料B ${suffix}`, quote),
    saveSource(request, `比較資料C ${suffix}`, quote),
  ]);

  await page.goto('/');
  await page.locator('button[onclick="switchView(\'writing\')"]').click();
  await page.getByRole('button', { name: '＋ 新しい原稿' }).click();
  const title = `統合調査 ${suffix}`;
  await page.locator('#document-title').fill(title);
  await expect(page.locator('#document-title')).toHaveValue(title);
  const editor = page.locator('#document-markdown');
  await editor.fill('## 主張\n\n調査結果を確認する。\n');

  for (const source of sources) {
    await page.locator('#document-source-search').fill(source.title);
    await page.getByRole('button', { name: '検索', exact: true }).click();
    const result = page.locator('#document-source-results .document-source-row', { hasText: source.title });
    await result.getByRole('button', { name: '資料に追加' }).click();
    await expect(page.locator('#document-title')).toHaveValue(title);
  }
  await expect(page.locator('#document-sources .document-source-row')).toHaveCount(3);
  await page.locator('#document-compare-purpose').fill('有効性 条件 対象範囲 留保');
  await page.getByRole('button', { name: '3件以上の資料から根拠候補を抽出' }).click();
  const evidence = page.locator('#document-evidence-results .document-evidence-row').first();
  await expect(evidence).toBeVisible();
  await expect(page.locator('#document-evidence-results')).toContainText('ルール抽出');
  await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(element.value.length, element.value.length));
  await evidence.getByRole('button', { name: '原稿カーソルに引用を挿入' }).click();
  await expect(editor).toHaveValue(/\[\[citation:/);
  await expect(page.locator('#document-title')).toHaveValue(title);

  const firstCitationMarker = (await editor.inputValue()).match(/\[\[citation:[^\]]+\]\]/)?.[0];
  expect(firstCitationMarker).toBeTruthy();
  await editor.fill(`## ${sources[0]!.title}\n\n資料を確認する。 ${firstCitationMarker}`);
  await editor.evaluate((element: HTMLTextAreaElement, text: string) => { const at = element.value.indexOf(text); element.setSelectionRange(at, at + text.length); }, sources[0]!.title);
  await page.getByRole('button', { name: '選択文から検索' }).click();
  await expect(page.locator('#search-terms')).toHaveValue(sources[0]!.title);
  const cardSearchTarget = page.locator('#search-targets input[value="cards"]');
  await expect(cardSearchTarget).toBeVisible();
  if (!(await cardSearchTarget.isChecked())) await cardSearchTarget.check();
  await page.locator('#bm25-run-btn').click();
  const savedResult = page.locator('#search-cards .score-card', { hasText: sources[0]!.title }).first();
  await expect(savedResult).toBeVisible();
  await savedResult.getByRole('button', { name: 'メモを読む' }).click();
  await expect(page.locator('#reader-research-citation-add')).toBeVisible();
  await page.locator('#reader-article [data-index="0"]').evaluate((element: Element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await page.getByRole('button', { name: '引用を原稿へ追加して戻る' }).click();
  await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);
  await expect(editor).toHaveValue(/\[\[citation:/);
  await expect(page.locator('#document-citations')).toContainText('verified');

  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#document-save-state')).toContainText('保存済み');

  const citationMarker = (await editor.inputValue()).match(/\[\[citation:[^\]]+\]\]/)?.[0];
  expect(citationMarker).toBeTruthy();
  await editor.evaluate((element: HTMLTextAreaElement) => { element.value = '<script>alert(1)</script>'; element.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#document-preview script')).toHaveCount(0);
  await editor.fill(`## 主張\n\n保存本文を確認する。 ${citationMarker}`);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#document-save-state')).toContainText('保存済み');

  await page.reload();
  await page.locator('button[onclick="switchView(\'writing\')"]').click();
  await page.locator('#document-search').fill(title);
  const documentItem = page.locator('#document-list .document-list-item', { hasText: title });
  await expect(documentItem).toBeVisible();
  await documentItem.click();
  await expect(editor).toHaveValue(/\[\[citation:/);
  await expect(page.locator('#document-citations')).toContainText('verified');
  const citedSourceRow = page.locator('#document-sources .document-source-row', { hasText: sources[0]!.title });
  await page.locator('.document-sources-column').evaluate((element: HTMLElement) => { element.scrollTop = element.scrollHeight; });
  await citedSourceRow.getByRole('button', { name: '使用原稿' }).click();
  const citationUse = page.locator('#document-sources .document-source-row .document-backlinks button', { hasText: title }).first();
  await expect(citationUse).toBeVisible();
  await citationUse.click();
  await expect(editor).toHaveValue(/\[\[citation:/);

  await editor.fill(`## 主張\n\n再起動後に復旧する下書き。 ${citationMarker}`);
  await page.reload();
  await page.locator('button[onclick="switchView(\'writing\')"]').click();
  await page.locator('#document-search').fill(title);
  await page.locator('#document-list .document-list-item', { hasText: title }).click();
  await expect(page.locator('#document-draft')).toBeVisible();
  await page.getByRole('button', { name: '復旧', exact: true }).click();
  await expect(editor).toHaveValue(/再起動後に復旧する下書き/);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#document-save-state')).toContainText('保存済み');

  const listed = await (await request.get(`/api/documents?q=${encodeURIComponent(title)}`)).json();
  const id = listed.documents.find((row: { title: string }) => row.title === title).id as string;
  const exported = await (await request.get(`/api/documents/${id}/export.md`)).text();
  expect(exported).toContain(quote);
  expect((await (await request.get(`/api/reader/cards/${sources[0]!.id}/documents`)).json()).documents.map((row: { id: string }) => row.id)).toContain(id);

  await page.evaluate(() => { (window as any).localAi.availability = async () => 'unavailable'; });
  await page.getByRole('button', { name: '構成案', exact: true }).click();
  await expect(page.locator('#document-ai-outline')).toContainText('このブラウザーでは端末内AIを利用できません');

  await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 5));
  await page.getByRole('button', { name: '選択文から検索' }).click();
  await expect(page.locator('#search-terms')).toHaveValue('## 主張');
});

test('writing toolbar formats selected text and lines, updates preview, and restores the saved Markdown', async ({ page }) => {
  const title = `Markdown編集 ${stamp()}`;
  await page.goto('/');
  await page.locator('button[onclick="switchView(\'writing\')"]').click();
  await page.getByRole('button', { name: '＋ 新しい原稿' }).click();
  await page.locator('#document-title').fill(title);
  const editor = page.locator('#document-markdown');
  await editor.fill('主張\n条件\n範囲');
  await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 2));
  await page.getByRole('button', { name: '太字', exact: true }).click();
  await expect(editor).toHaveValue('**主張**\n条件\n範囲');
  await editor.evaluate((element: HTMLTextAreaElement) => { const at = element.value.indexOf('条件'); element.setSelectionRange(at, at + 2); });
  await page.getByRole('button', { name: '引用', exact: true }).click();
  await editor.evaluate((element: HTMLTextAreaElement) => { const at = element.value.indexOf('範囲'); element.setSelectionRange(at, at + 2); });
  await page.getByRole('button', { name: '斜体', exact: true }).click();
  await expect(editor).toHaveValue('**主張**\n> 条件\n*範囲*');
  await page.locator('.document-preview-details').evaluate((element: HTMLDetailsElement) => { element.open = true; });
  await expect(page.locator('#document-preview strong')).toContainText('主張');
  await expect(page.locator('#document-preview blockquote')).toContainText('条件');
  await expect(page.locator('#document-preview em')).toContainText('範囲');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#document-save-state')).toContainText('保存済み');
  await page.reload();
  await page.locator('button[onclick="switchView(\'writing\')"]').click();
  await page.locator('#document-search').fill(title);
  await page.locator('#document-list .document-list-item', { hasText: title }).click();
  await expect(editor).toHaveValue('**主張**\n> 条件\n*範囲*');
});

test('a user-selected local PDF can switch between extracted text and the original page', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '読んでメモ' }).click();
  await page.locator('#reader-pdf-file').setInputFiles('demo/sample-paper.pdf');
  await expect(page.locator('#reader-meta')).toContainText('全');
  await page.getByRole('button', { name: 'PDF原本を表示' }).click();
  await expect(page.locator('#reader-original-pdf-view')).toBeVisible();
  await expect.poll(() => page.locator('#reader-original-pdf-canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThan(0);
  await expect(page.locator('#reader-original-pdf-status')).toContainText(/PDF 1\/\d+枚目 · 原本表示/);
  if (process.env.E2E_CAPTURE_RESEARCH_PDF === '1') await page.screenshot({ path: '.tmp-integrated-verify-20261106/pdf-original-view.png', fullPage: true });
  await page.locator('#reader-original-pdf-page').fill('2');
  await page.getByRole('button', { name: '移動', exact: true }).click();
  await expect(page.locator('#reader-original-pdf-status')).toContainText(/PDF 2\/\d+枚目 · 原本表示/);
  if (process.env.E2E_CAPTURE_RESEARCH_PDF === '1') await page.screenshot({ path: '.tmp-integrated-verify-20261106/pdf-original-view.png', fullPage: true });
  const secondPageInk = await page.locator('#reader-original-pdf-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let i = 0; i < pixels.length; i += 20) if (pixels[i]! < 235 || pixels[i + 1]! < 235 || pixels[i + 2]! < 235) ink += 1;
    return ink;
  });
  expect(secondPageInk).toBeGreaterThan(10);
  await page.getByRole('button', { name: '抽出本文へ戻る' }).click();
  await expect(page.locator('#reader-article')).toBeVisible();
});
