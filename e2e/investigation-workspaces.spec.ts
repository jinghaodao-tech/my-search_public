import { expect, test, type APIRequestContext } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

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
  await expect(page.locator('#topbar [data-view="writing"]')).toHaveCount(0);
  await expect(page.locator('#topbar > .tab-group > button[data-view="kj"]')).toHaveCount(0);
  await expect(page.locator('#topbar > .tab-group > button[data-view="zettel"]')).toHaveCount(0);
  await page.locator('button[data-view="investigations"]').click();
  await expect(page.locator('#investigation-workspace-list')).toContainText(workspace.workspace.name);
  await expect(page.locator('#investigation-content .investigation-tabs')).toHaveCount(0);
  await expect(page.locator('.investigation-workbench')).toBeVisible();
  await expect(page.locator('#investigation-source-rail')).toBeVisible();
  await expect(page.locator('#investigation-thought-canvas')).toBeVisible();
  await page.locator('#investigation-source-query').fill(first.title);
  await page.locator('#investigation-source-rail').getByRole('button', { name: '検索', exact: true }).click();
  await page.locator('#investigation-source-results .document-source-row', { hasText: first.title }).getByRole('button', { name: '資料に追加' }).click();
  await page.locator('#investigation-source-query').fill(second.title);
  await page.locator('#investigation-source-rail').getByRole('button', { name: '検索', exact: true }).click();
  await page.locator('#investigation-source-results .document-source-row', { hasText: second.title }).getByRole('button', { name: '資料に追加' }).click();
  await expect(page.locator('#investigation-sources .investigation-source-row')).toHaveCount(2);

  await page.locator('#investigation-source-rail .investigation-source-details > summary').click();
  await page.locator('#investigation-group-name').fill('根拠候補');
  await page.getByRole('button', { name: '分類を追加' }).click();
  await page.getByRole('button', { name: 'ボード', exact: true }).click();
  await expect(page.locator('#investigation-groups')).toContainText(first.title);
  await expect(page.locator('#investigation-groups')).toContainText(second.title);
  const renamedGroup = '根拠候補（修正）';
  page.once('dialog', dialog => dialog.accept(renamedGroup));
  await page.locator('#investigation-groups .investigation-kanban-column', { hasText: '根拠候補' }).getByRole('button', { name: '名前変更' }).click();
  await expect(page.locator('#investigation-groups')).toContainText(renamedGroup);
  await page.locator('#investigation-source-rail .investigation-layout-switch').getByRole('button', { name: '一覧', exact: true }).click();
  await page.locator('#investigation-organize-list select').first().selectOption({ label: renamedGroup });
  await expect(page.locator('#investigation-organize-list select').first()).toHaveValue(/.+/);
  await expect(page.locator('#investigation-organize-list')).toContainText(first.title);
  await page.locator('#investigation-group-name').fill('削除しても資料は残る');
  await page.getByRole('button', { name: '分類を追加' }).click();
  await page.locator('#investigation-organize-list select').nth(1).selectOption({ label: '削除しても資料は残る' });
  await page.getByRole('button', { name: 'ボード', exact: true }).click();
  const otherWorkspaceResponse = await request.post('/api/workspaces', { data: { name: `別調査 ${suffix}`, purpose: '別の分類を保持' } });
  expect(otherWorkspaceResponse.ok()).toBeTruthy();
  const otherWorkspace = await otherWorkspaceResponse.json();
  const otherGroupResponse = await request.post(`/api/workspaces/${otherWorkspace.workspace.id}/groups`, { data: { name: '別分類' } });
  expect(otherGroupResponse.ok()).toBeTruthy();
  const otherGroup = await otherGroupResponse.json();
  expect((await request.post(`/api/workspaces/${otherWorkspace.workspace.id}/sources`, { data: { cardId: first.id } })).ok()).toBeTruthy();
  expect((await request.put(`/api/workspaces/${otherWorkspace.workspace.id}/sources/${first.id}`, { data: { groupId: otherGroup.groupId } })).ok()).toBeTruthy();
  const firstWorkspaceReload = await (await request.get(`/api/workspaces/${workspace.workspace.id}`)).json();
  const otherWorkspaceReload = await (await request.get(`/api/workspaces/${otherWorkspace.workspace.id}`)).json();
  const firstGroupId = firstWorkspaceReload.workspace.groups.find((group: { name: string }) => group.name === renamedGroup).id;
  const temporaryGroupId = firstWorkspaceReload.workspace.groups.find((group: { name: string }) => group.name === '削除しても資料は残る').id;
  expect(firstWorkspaceReload.workspace.sources.find((source: { card: { id: string }; groupId: string | null }) => source.card.id === first.id).groupId).toBe(firstGroupId);
  expect(otherWorkspaceReload.workspace.sources.find((source: { card: { id: string }; groupId: string | null }) => source.card.id === first.id).groupId).toBe(otherGroup.groupId);
  const temporaryColumn = page.locator(`#investigation-groups .investigation-kanban-column[data-group-id="${temporaryGroupId}"]`);
  await temporaryColumn.locator('.investigation-kanban-heading').getByRole('button', { name: '削除', exact: true }).click();
  await expect(page.locator('#investigation-groups .investigation-kanban-column[data-group-id=""]')).toContainText(second.title);
  await page.getByRole('button', { name: '関係図', exact: true }).click();
  await expect(page.locator('#investigation-graph .investigation-network')).toBeVisible();

  await page.getByRole('button', { name: '資料の根拠を比べる', exact: true }).click();
  await expect(page.locator('#investigation-compare-source-selection .investigation-compare-choice')).toHaveCount(2);
  await expect(page.locator('#investigation-compare-source-selection input[type="checkbox"]:checked')).toHaveCount(2);
  await page.locator('#investigation-compare-purpose').fill('SQLite 同時更新 永続化 競合条件');
  await page.getByRole('button', { name: '保存本文から根拠候補' }).click();
  await expect(page.locator('#investigation-evidence .document-evidence-row').first()).toBeVisible();
  await expect(page.locator('#investigation-evidence')).toContainText('語の一致');

  await page.locator('[data-context-action="documents"]').click();
  await page.locator('.investigation-document-associations > summary').click();
  await page.locator('#investigation-document-select').selectOption(document.document.id);
  await page.getByRole('button', { name: '原稿を追加' }).click();
  await expect(page.locator('#investigation-documents')).toContainText(document.document.title);
  await expect(page.locator('#research-writing-view')).toBeVisible();
  await page.screenshot({ path: path.join(process.cwd(), 'artifacts', 'ui-investigation-integration', 'desktop-manuscript-focus.png'), fullPage: true });
  const workspaceDraftTitle = `調査内原稿 ${suffix}`;
  await page.getByRole('button', { name: '＋ 新しい原稿' }).click();
  await page.locator('#document-title').fill(workspaceDraftTitle);
  await page.locator('#document-markdown').fill('この原稿は開いている調査に関連付けて保存される。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#investigation-documents')).toContainText(workspaceDraftTitle);
  await page.locator('#investigation-search-select').selectOption(savedSearch.id);
  await page.getByRole('button', { name: '保存検索を追加' }).click();
  await expect(page.locator('#investigation-saved-searches')).toContainText(savedSearch.name);

  await page.locator('[data-context-action="thoughts"]').click();
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

  const screenshotDir = path.join(process.cwd(), 'artifacts', 'ui-investigation-integration');
  await mkdir(screenshotDir, { recursive: true });
  await page.locator('#investigation-source-rail .investigation-source-details > summary').click();
  await page.getByRole('button', { name: 'ボード', exact: true }).click();
  await page.screenshot({ path: path.join(screenshotDir, 'desktop-workspace-workbench.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshotDir, 'mobile-workspace-workbench.png'), fullPage: true });
  await expect(page.locator('#investigation-name')).toBeVisible();
  await expect(page.locator('#investigation-source-query')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('[data-context-action="documents"]').click();
  await expect(page.locator('#document-markdown')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('all documents remain editable from the integrated editor without an active workspace', async ({ page, request }) => {
  const title = `未分類原稿 ${stamp()}`;
  const response = await request.post('/api/documents', { data: { title, markdown: '調査に属さない原稿の本文。' } });
  expect(response.ok()).toBeTruthy();
  const document = (await response.json()).document as { id: string };
  const workspaceResponse = await request.post('/api/workspaces', { data: { name: `原稿を保持する調査 ${stamp()}`, purpose: '' } });
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace = (await workspaceResponse.json()).workspace as { id: string; name: string };
  await page.goto('/');
  await page.locator('button[data-view="investigations"]').click();
  await page.getByRole('button', { name: workspace.name, exact: true }).click();
  await page.locator('[data-context-action="documents"]').click();
  await page.locator('.investigation-document-associations > summary').click();
  await page.locator('#investigation-document-select').selectOption(document.id);
  await page.getByRole('button', { name: '原稿を追加', exact: true }).click();
  const associated = page.locator('#investigation-documents .document-source-row', { hasText: title });
  await expect(associated).toBeVisible();
  await associated.getByRole('button', { name: '関連解除' }).click();
  await expect(page.locator('#investigation-documents .document-source-row', { hasText: title })).toHaveCount(0);

  await page.getByRole('button', { name: 'すべての原稿', exact: true }).click();
  await page.locator('#document-search').fill(title);
  await page.locator('#document-list .document-list-item', { hasText: title }).click();
  await expect(page.locator('#document-markdown')).toHaveValue('調査に属さない原稿の本文。');
  await expect(page.locator('#investigation-content')).toBeVisible();
  await expect(page.locator('#investigation-name')).toBeDisabled();

  await page.getByRole('button', { name: workspace.name, exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#investigation-delete').click();
  await expect(page.locator('#investigation-status')).toContainText('原稿・検索条件は保持されています');
  const retained = await request.get(`/api/documents/${document.id}`);
  expect(retained.ok()).toBeTruthy();
  expect((await retained.json()).document).toMatchObject({ id: document.id, title, markdown: '調査に属さない原稿の本文。' });
});

test('writes beside one reusable Reader, inserts a verified citation, and resumes references on mobile', async ({ page, request }) => {
  const suffix = stamp();
  const quoteText = `検証用の正確な引用文 ${suffix} は保存本文と照合されます。`;
  const sourceA = await saveSource(request, `参照資料A ${suffix}`, `前段落です。\n\n${quoteText}\n\n後段落です。`);
  const sourceB = await saveSource(request, `参照資料B ${suffix}`, `資料Bの独立した本文 ${suffix}。`);
  const pdfSaveResponse = await request.post('/api/reader/save', { data: {
    title: `抽出PDF ${suffix}`, url: `https://example.test/${suffix}.pdf`, fetchedAt: new Date().toISOString(),
    paragraphs: ['[[page:1|2]]', `PDFの抽出本文 ${suffix}。`], memo: '', tags: [],
  } });
  expect(pdfSaveResponse.ok()).toBeTruthy();
  const pdfSource = (await pdfSaveResponse.json()).card as { id: string; title: string };
  const documentResponse = await request.post('/api/documents', { data: { title: `並行執筆 ${suffix}`, markdown: '前半後半' } });
  expect(documentResponse.ok()).toBeTruthy();
  const researchDocument = (await documentResponse.json()).document;
  const workspaceResponse = await request.post('/api/workspaces', { data: { name: `執筆調査 ${suffix}`, purpose: '原文を見ながら書く' } });
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace = (await workspaceResponse.json()).workspace;
  for (const source of [sourceA, sourceB, pdfSource]) {
    expect((await request.post(`/api/workspaces/${workspace.id}/sources`, { data: { cardId: source.id } })).ok()).toBeTruthy();
  }
  expect((await request.post(`/api/workspaces/${workspace.id}/documents`, { data: { id: researchDocument.id } })).ok()).toBeTruthy();
  const thoughtResponse = await request.post('/api/thought-notes', { data: { title: `執筆用メモ ${suffix}`, body: 'これは原文引用ではなく、調査者自身の考えです。', kind: 'interpretation' } });
  expect(thoughtResponse.ok()).toBeTruthy();
  const thought = (await thoughtResponse.json()).thought;
  expect((await request.post(`/api/workspaces/${workspace.id}/thought-notes`, { data: { thoughtNoteId: thought.id } })).ok()).toBeTruthy();
  expect((await request.post(`/api/documents/${researchDocument.id}/thought-notes`, { data: { thoughtNoteId: thought.id } })).ok()).toBeTruthy();
  const secondThoughtResponse = await request.post('/api/thought-notes', { data: { title: `比較用メモ ${suffix}`, body: 'もう一つの独立した観点です。', kind: 'question' } });
  expect(secondThoughtResponse.ok()).toBeTruthy();
  const secondThought = (await secondThoughtResponse.json()).thought;
  expect((await request.post(`/api/workspaces/${workspace.id}/thought-notes`, { data: { thoughtNoteId: secondThought.id } })).ok()).toBeTruthy();
  expect((await request.put(`/api/workspaces/${workspace.id}/state`, { data: { state: {
    thoughtCompare: { noteIds: [thought.id, secondThought.id], criteria: ['観点'], values: { [`${thought.id}:criterion:${encodeURIComponent('観点')}`]: '本人の考え', [`${secondThought.id}:criterion:${encodeURIComponent('観点')}`]: '別の観点' }, reflection: '' },
  } } })).ok()).toBeTruthy();

  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto('/');
  await page.locator('button[data-view="investigations"]').click();
  await page.getByRole('button', { name: workspace.name, exact: true }).click();
  await page.locator('[data-context-action="documents"]').click();
  await page.locator('.investigation-document-associations > summary').click();
  await page.locator('#investigation-documents .document-source-row', { hasText: researchDocument.title }).getByRole('button', { name: '編集', exact: true }).click();
  await expect(page.locator('#document-markdown')).toHaveValue('前半後半');
  await expect(page.locator('#document-reader-host')).toBeVisible();
  const editor = page.locator('#document-markdown');
  await editor.evaluate((node: HTMLTextAreaElement) => { node.focus(); node.setSelectionRange(2, 2); });
  await editor.pressSequentially(' 未保存の草稿');
  const draftValue = await editor.inputValue();
  const draftCaret = await editor.evaluate((node: HTMLTextAreaElement) => node.selectionStart);

  await page.locator('#document-reference-source').selectOption(sourceA.id);
  await expect(page.locator('#modal-reader[data-reader-embedded="true"]')).toBeVisible();
  await expect(page.locator('#reader-article')).toContainText(quoteText);
  const referenceScreenshots = path.join(process.cwd(), 'artifacts', 'ui-investigation-integration');
  await mkdir(referenceScreenshots, { recursive: true });
  await page.screenshot({ path: path.join(referenceScreenshots, 'desktop-writing-with-reference.png'), fullPage: true });
  await page.locator('#document-reference-source').selectOption(sourceB.id);
  await expect(page.locator('#reader-article')).toContainText(`資料Bの独立した本文 ${suffix}`);
  await expect(editor).toHaveValue(draftValue);
  expect(await editor.evaluate((node: HTMLTextAreaElement) => node.selectionStart)).toBe(draftCaret);
  await page.locator('#document-reference-source').selectOption(pdfSource.id);
  await expect(page.locator('#reader-article')).toContainText(`PDFの抽出本文 ${suffix}`);
  await expect(page.locator('#reader-meta .reader-pages-row')).toContainText('p. 2');
  await page.locator('#reader-pdf-file').setInputFiles('demo/sample-paper.pdf');
  await expect(page.locator('#reader-meta')).toContainText('全');
  await page.getByRole('button', { name: 'PDF原本を表示' }).click();
  await expect(page.locator('#reader-original-pdf-view')).toBeVisible();
  await expect.poll(() => page.locator('#reader-original-pdf-canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '抽出本文へ戻る' }).click();
  await page.locator('#document-reference-source').selectOption(sourceA.id);
  await expect(page.locator('#reader-article')).toContainText(quoteText);
  await page.locator('#reader-article [data-index="0"]').evaluate((node: HTMLElement, text: string) => {
    const allText = node.textContent ?? '';
    const start = allText.indexOf(text);
    if (start < 0) throw new Error(`Selected quote is not present: ${JSON.stringify({ expected: text, actual: allText, visible: node.innerText })}`);
    const pointAt = (offset: number) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let remaining = offset;
      while (walker.nextNode()) {
        const textNode = walker.currentNode as Text;
        if (remaining <= textNode.length) return { node: textNode, offset: remaining };
        remaining -= textNode.length;
      }
      throw new Error('Reader quote boundary could not be resolved');
    };
    const from = pointAt(start);
    const to = pointAt(start + text.length);
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
  }, quoteText);
  await page.getByRole('button', { name: '引用を原稿へ挿入', exact: true }).click();
  await expect(editor).toHaveValue(new RegExp(`^前半 未保存の草稿\\[\\[citation:[0-9a-f-]{36}\\]\\]後半$`));
  await editor.fill(`${await editor.inputValue()} 通信失敗時も残す草稿`);
  const valueBeforeFailedSave = await editor.inputValue();
  let failedSaveRequests = 0;
  const failNextDocumentSave = async (route: import('@playwright/test').Route) => {
    if (route.request().method() === 'PUT') { failedSaveRequests += 1; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic save failure"}' }); }
    else await route.continue();
  };
  await page.route(`**/api/documents/${researchDocument.id}`, failNextDocumentSave);
  await page.locator('.writing-editor-toolbar').getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => failedSaveRequests).toBe(1);
  await expect(editor).toHaveValue(valueBeforeFailedSave);
  await page.unroute(`**/api/documents/${researchDocument.id}`, failNextDocumentSave);
  await page.locator('.writing-editor-toolbar').getByRole('button', { name: '保存', exact: true }).click();
  const saved = await (await request.get(`/api/documents/${researchDocument.id}`)).json();
  expect(saved.document.citations).toEqual([expect.objectContaining({ sourceCardId: sourceA.id, quote: quoteText, paragraphIndex: 0, verification: 'verified' })]);

  await page.locator('[data-document-reference-tab="thoughts"]').click();
  await page.locator('#document-reference-thought-notes').getByRole('button', { name: '内容を参照' }).click();
  await expect(page.locator('#document-reference-thought-preview')).toContainText('これは原文引用ではなく');
  await page.locator('[data-document-reference-tab="comparison"]').click();
  await expect(page.locator('#thought-comparison-reference .thought-comparison-grid textarea').nth(0)).toHaveValue('本人の考え');
  await expect(page.locator('#thought-comparison-reference .thought-comparison-grid textarea').nth(1)).toHaveValue('別の観点');
  await expect(editor).toHaveValue(/未保存の草稿\[\[citation:/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-document-mobile-view="reference"]').click();
  await expect(page.locator('.document-workbench')).toHaveAttribute('data-mobile-view', 'reference');
  await expect(page.locator('#document-reference-column')).toBeVisible();
  await page.locator('[data-document-reference-tab="source"]').click();
  await expect(page.locator('#reader-article')).toContainText(quoteText);
  await page.screenshot({ path: path.join(referenceScreenshots, 'mobile-writing-reference.png'), fullPage: true });
  await page.locator('[data-document-mobile-view="writing"]').click();
  await expect(editor).toBeVisible();
  await page.locator('[data-document-mobile-view="reference"]').click();
  await page.locator('[data-document-reference-tab="citations"]').click();
  await page.getByRole('button', { name: /Readerで引用元へ/ }).click();
  await expect(page.locator('#modal-reader[data-reader-embedded="true"]')).toBeVisible();
  await expect(page.locator('#reader-article [data-index="0"]')).toHaveClass(/document-citation-focus/);
  await page.reload();
  const restoredReader = page.locator('#modal-reader.active');
  if (await restoredReader.count()) {
    await expect(restoredReader).toBeVisible();
    await page.locator('#reader-close-btn').click();
  }
  await page.locator('button[data-view="investigations"]').click();
  await page.getByRole('button', { name: workspace.name, exact: true }).click();
  await page.locator('[data-context-action="documents"]').click();
  await page.locator('.investigation-document-associations > summary').click();
  await page.locator('#investigation-documents .document-source-row', { hasText: researchDocument.title }).getByRole('button', { name: '編集', exact: true }).click();
  await expect(editor).toHaveValue(/未保存の草稿\[\[citation:/);
  await expect(page.locator('#document-reference-source')).toContainText(sourceA.title);
  await expect(page.locator('#reader-article')).toContainText(quoteText);
});

test('creates, relates, cites, compares, and resumes human-authored thought notes', async ({ page, request }) => {
  const suffix = stamp();
  const quote = `思考メモの出典照合 ${suffix} を行います。`;
  const source = await saveSource(request, `思考メモ出典 ${suffix}`, quote);
  const workspaceResponse = await request.post('/api/workspaces', { data: { name: `思考整理 ${suffix}`, purpose: '仮説と根拠を確かめる' } });
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace = (await workspaceResponse.json()).workspace as { id: string; name: string };
  expect((await request.post(`/api/workspaces/${workspace.id}/sources`, { data: { cardId: source.id } })).ok()).toBeTruthy();
  const documentResponse = await request.post('/api/documents', { data: { title: `思考メモを使う原稿 ${suffix}`, markdown: '結論を記述する。' } });
  expect(documentResponse.ok()).toBeTruthy();
  const manuscript = (await documentResponse.json()).document as { id: string; title: string };
  expect((await request.post(`/api/workspaces/${workspace.id}/documents`, { data: { id: manuscript.id } })).ok()).toBeTruthy();

  await page.goto('/');
  await page.locator('button[data-view="investigations"]').click();
  await page.getByRole('button', { name: workspace.name, exact: true }).click();
  await page.locator('[data-context-action="thoughts"]').click();
  await page.locator('#thought-new-title').fill(`仮説 ${suffix}`);
  await page.locator('#thought-new-kind').selectOption('hypothesis');
  await page.locator('#thought-new-body').fill('語の表記ゆれで保存資料を再発見できない可能性がある。');
  await page.getByRole('button', { name: '思考メモを作成' }).click();
  await expect(page.locator('#thought-edit-body')).toHaveValue('語の表記ゆれで保存資料を再発見できない可能性がある。');
  const firstTitle = `仮説 ${suffix}`;
  await page.locator('.thought-editor-details').filter({ hasText: '出典の引用と原文照合' }).locator('summary').click();
  await page.locator('#thought-reference-source').selectOption(source.id);
  await page.locator('#thought-reference-quote').fill(quote);
  await page.getByRole('button', { name: '原文と照合して追加' }).click();
  await expect(page.locator('#thought-reference-list')).toContainText('原文照合済み');

  await page.locator('#thought-new-title').fill(`検証方法 ${suffix}`);
  await page.locator('#thought-new-body').fill('同じ検索文を複数方式で比較する。');
  await page.getByRole('button', { name: '思考メモを作成' }).click();
  await expect(page.locator('#investigation-thought-list')).toContainText(`検証方法 ${suffix}`);
  await page.locator('#investigation-thought-search').fill(suffix);
  await page.getByRole('button', { name: 'メモを検索', exact: true }).click();
  await expect(page.locator('#investigation-thought-list .thought-note-item')).toHaveCount(2);
  const moveUp = page.getByRole('button', { name: '順序を上へ' });
  await moveUp.press('Enter');
  await expect(page.locator('#investigation-thought-list .thought-note-item').first()).toContainText(`検証方法 ${suffix}`);
  await page.locator('#thought-link-target').selectOption({ label: firstTitle });
  await page.locator('#thought-link-description').fill('この仮説を検証する方法');
  await page.getByRole('button', { name: '関係を追加' }).click();
  await expect(page.locator('#thought-link-list input').first()).toHaveValue('この仮説を検証する方法');

  await page.locator('[data-thought-view-button="map"]').click();
  await expect(page.locator('#investigation-thought-map')).toBeVisible();
  await page.getByRole('button', { name: 'マップ上で関係線を追加' }).click();
  await expect(page.locator('#investigation-status')).toContainText('始点と終点');
  await page.locator('[data-thought-view-button="list"]').click();
  await expect(page.locator('#investigation-thought-list .thought-note-item').filter({ hasText: suffix })).toHaveCount(2);
  await page.locator('.thought-compare-check input').nth(0).check();
  await page.locator('.thought-compare-check input').nth(1).check();
  await page.locator('[data-context-action="documents"]').click();
  await page.locator('.investigation-document-associations > summary').click();
  await page.locator('#investigation-document-select').selectOption(manuscript.id);
  await page.getByRole('button', { name: '原稿を追加' }).click();
  await page.locator('#document-list .document-list-item', { hasText: manuscript.title }).click();
  await expect(page.locator('#document-title')).toHaveValue(manuscript.title);
  await page.locator('[data-context-action="thoughts"]').click();
  await page.locator('[data-thought-document-only] button').click();
  await page.locator('[data-context-action="documents"]').click();
  await expect(page.locator('#document-thought-notes')).toContainText(`検証方法 ${suffix}`);
  await expect(page.locator('#document-thought-notes')).toContainText('内容を参照');
  await page.locator('[data-context-action="thoughts"]').click();
  await page.getByRole('button', { name: /選択したメモを比較/ }).click();
  await page.locator('#thought-compare-criteria').fill('主張\n未確認');
  const comparisonCell = page.locator('#investigation-thought-comparison-table textarea').first();
  await comparisonCell.fill('本人が記録した比較内容');
  await page.locator('#thought-compare-reflection').fill('一方は問題を記述し、もう一方は検証手順を示す。');
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '気付きを思考メモにする' }).click();
  await expect(page.locator('#thought-edit-body')).toHaveValue('一方は問題を記述し、もう一方は検証手順を示す。');
  await expect(page.locator('#thought-link-list input').first()).toHaveValue('比較から生まれた気付き');

  await page.locator('[data-context-action="thoughts"]').click();
  await page.locator('#thought-edit-body').fill('未保存を残してタブを切り替える。');
  await page.locator('[data-context-action="compare"][data-workspace-required="true"]').click();
  await expect(page.locator('#thought-version-label')).toContainText('保存済み');
  await page.reload();
  await page.locator('button[data-view="investigations"]').click();
  await page.getByRole('button', { name: workspace.name, exact: true }).click();
  await page.locator('[data-context-action="thoughts"]').click();
  await expect(page.locator('#thought-edit-body')).toHaveValue('未保存を残してタブを切り替える。');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#thought-edit-body')).toBeVisible();
  await page.locator('[data-context-action="documents"]').click();
  await page.screenshot({ path: path.join(process.cwd(), 'artifacts', 'ui-investigation-integration', 'mobile-manuscript-focus.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('thought note ordering controls work by touch in a mobile viewport', async ({ browser, request }) => {
  const suffix = stamp();
  const workspaceResponse = await request.post('/api/workspaces', { data: { name: `タッチ操作 ${suffix}`, purpose: '' } });
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace = (await workspaceResponse.json()).workspace as { id: string; name: string };
  const firstResponse = await request.post('/api/thought-notes', { data: { title: `先のメモ ${suffix}`, body: '先に作成したメモ。', kind: 'free' } });
  const secondResponse = await request.post('/api/thought-notes', { data: { title: `後のメモ ${suffix}`, body: '後で作成したメモ。', kind: 'free' } });
  const first = (await firstResponse.json()).thought as { id: string };
  const second = (await secondResponse.json()).thought as { id: string };
  for (const thought of [first, second]) expect((await request.post(`/api/workspaces/${workspace.id}/thought-notes`, { data: { thoughtNoteId: thought.id } })).ok()).toBeTruthy();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.locator('button[data-view="investigations"]').click();
    await page.getByRole('button', { name: workspace.name, exact: true }).click();
    await page.locator('[data-context-action="thoughts"]').click();
    await page.getByRole('button', { name: `思考メモを開く: 後のメモ ${suffix}` }).click();
    const target = page.getByRole('button', { name: '順序を上へ' });
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    expect(box).toBeTruthy();
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page.locator('#investigation-thought-list .thought-note-item').first()).toContainText(`後のメモ ${suffix}`);
    const persisted = await request.get(`/api/workspaces/${workspace.id}`);
    expect((await persisted.json()).workspace.thoughts.map((row: { id: string }) => row.id)).toEqual([second.id, first.id]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await context.close(); }
});
