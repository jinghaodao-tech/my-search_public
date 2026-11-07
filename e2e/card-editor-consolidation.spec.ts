import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const screenshotDir = path.join(process.cwd(), 'artifacts', 'ui-edit-consolidation');

async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.locator('#card-grid')).toBeVisible();
}

async function openCardEditor(page: Page, title: string) {
  if (await page.locator('#detail-panel').isVisible()) await page.locator('#detail-header button[title="閉じる"]').click();
  await page.locator('.card', { has: page.getByText(title, { exact: true }) }).click();
  await expect(page.locator('#detail-header button[title="タイトル・本文・メモ・出典を編集"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '読んで編集', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '本文と一緒に開く', exact: true })).toHaveCount(0);
  await page.locator('#detail-header button[title="タイトル・本文・メモ・出典を編集"]').click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
}

async function openCardEditorFromList(page: Page, id: string) {
  if (await page.locator('#detail-panel').isVisible()) await page.locator('#detail-header button[title="閉じる"]').click();
  const card = page.locator(`#card-${id}`);
  if ((await page.evaluate(() => window.innerWidth)) <= 768) {
    await card.click();
    await page.locator('#detail-header button[title="タイトル・本文・メモ・出典を編集"]').click();
  } else {
    await card.hover();
    await card.locator('button[title="編集"]').click();
  }
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
}

async function readerCard(request: APIRequestContext, input: {
  kind?: string; title: string; url?: string; fileName?: string; paragraphs: string[]; memo: string;
}) {
  const { kind: _kind, ...readerInput } = input;
  const response = await request.post('/api/reader/save', { data: {
    ...readerInput,
    fetchedAt: new Date().toISOString(),
    byline: '保存時の著者',
    year: '2026',
    siteName: '保存時の出典',
    tags: ['初期タグ'],
  } });
  const responseText = await response.text();
  expect(response.ok(), `reader fixture create failed: ${response.status()} ${responseText}`).toBeTruthy();
  const saved = JSON.parse(responseText);
  return saved.card as { id: string; title: string };
}

test('memo creation and edit use the same editor on desktop and mobile', async ({ page }) => {
  await mkdir(screenshotDir, { recursive: true });
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openApp(page);
    const title = `Unified memo ${viewport.name} ${stamp()}`;
    await page.locator('button[onclick="openNewCardModal()"]').first().click();
    await expect(page.locator('#modal-reader .reader-modal')).toHaveClass(/reader-plain-mode/);
    await page.locator('#reader-edit-title').fill(title);
    await page.locator('#reader-memo').fill('メモ本文は保存形式を維持する。');
    await page.locator('#reader-url').fill('https://example.test/memo');
    await page.locator('#reader-tags').fill('統合 確認');
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-memo-editor.png`), fullPage: true });
    await page.locator('#reader-save-btn').click();
    await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);
    await expect(page.locator('#card-grid')).toContainText(title);

    await openCardEditor(page, title);
    await expect(page.locator('#modal-reader .reader-modal')).toHaveClass(/reader-plain-mode/);
    await expect(page.locator('#reader-memo')).toHaveValue('メモ本文は保存形式を維持する。');
    await page.locator('#reader-edit-title').fill(`${title} updated`);
    await page.locator('#reader-memo').fill('更新後のメモ本文。');
    await page.locator('#reader-tags').fill('更新タグ');
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-memo-edit.png`), fullPage: true });
    await page.locator('#reader-save-btn').click();
    await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);
    await openCardEditor(page, `${title} updated`);
    await expect(page.locator('#reader-edit-title')).toHaveValue(`${title} updated`);
    await expect(page.locator('#reader-memo')).toHaveValue('更新後のメモ本文。');
    await expect(page.locator('#reader-tags')).toHaveValue('更新タグ');
    await page.locator('#modal-reader').getByRole('button', { name: '閉じる', exact: true }).click();
  }
});

test('article and PDF use the same responsive editor and retain original source/citation metadata', async ({ page, request }) => {
  test.setTimeout(90_000);
  await mkdir(screenshotDir, { recursive: true });
  const cases = [
    {
      kind: 'article',
      title: `Unified article ${stamp()}`,
      url: `https://example.test/${stamp()}`,
      paragraphs: ['保存された記事の原文です。', '引用位置が変わってはいけません。'],
      memo: '> 引用位置が変わってはいけません。 [¶2]',
    },
    {
      kind: 'pdf',
      title: `Unified PDF ${stamp()}`,
      fileName: 'citation-source.pdf',
      paragraphs: ['[[page:1|12]]', 'PDF原文とページ出典を保持します。', '[[page:2|13]]', '二枚目の原文です。'],
      memo: '> PDF原文とページ出典を保持します。 [¶2|p. 12]',
    },
  ];

  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const item of cases) {
      const sourceParagraphs = [...item.paragraphs];
      const card = await readerCard(request, item);
      await openApp(page);
      await openCardEditor(page, card.title);
      await expect(page.locator('#modal-reader .reader-modal')).not.toHaveClass(/reader-plain-mode/);
      await expect(page.locator('#reader-article')).toContainText(item.kind === 'pdf' ? 'PDF原文とページ出典' : '保存された記事の原文');
      await expect(page.locator('#reader-memo')).toHaveValue(item.memo);
      await page.locator('#reader-edit-title').fill(`${item.title} updated ${viewport.name}`);
      await page.locator('#reader-memo').fill(`${item.memo}\n\n編集したメモ`);
      await page.locator('#reader-tags').fill('出典確認済み');
      await page.locator('#reader-card-color-strip .color-dot[data-color="#FF6B6B"]').click();
      if (item.kind === 'pdf') await page.locator('#reader-card-color-strip .color-dot[data-color=""]').click();
      await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-${item.kind}-editor.png`), fullPage: true });
      await page.locator('#reader-save-btn').click();
      await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);

      const response = await request.get(`/api/reader/cards/${encodeURIComponent(card.id)}`);
      expect(response.ok()).toBeTruthy();
      const stored = await response.json();
      expect(stored.title).toBe(`${item.title} updated ${viewport.name}`);
      expect(stored.paragraphs).toEqual(sourceParagraphs);
      expect(stored.memo).toBe(`${item.memo}\n\n編集したメモ`);
      expect(stored.tags).toEqual(['出典確認済み']);
      expect(stored.byline).toBe('保存時の著者');
      expect(stored.year).toBe('2026');
      expect(stored.siteName).toBe('保存時の出典');
      expect(stored.color ?? null).toBe(item.kind === 'pdf' ? null : '#FF6B6B');
      if (item.kind === 'article') expect(stored.url).toBe(item.url);
      else expect(stored.fileName).toBe('citation-source.pdf');

      await openCardEditor(page, `${item.title} updated ${viewport.name}`);
      await expect(page.locator('#reader-memo')).toHaveValue(/編集したメモ/);
      await expect(page.locator('#reader-article')).toContainText(item.kind === 'pdf' ? 'PDF原文とページ出典' : '保存された記事の原文');
      await page.locator('#modal-reader').getByRole('button', { name: '閉じる', exact: true }).click();
    }
  }
});

test('desktop list pencil and mobile detail edit open the shared editor for every card type', async ({ page, request }) => {
  test.setTimeout(90_000);
  await mkdir(screenshotDir, { recursive: true });
  const memoTitle = `Quick memo ${stamp()}`;
  const memoResponse = await request.post('/api/cards', { data: { title: memoTitle, body: 'メモ本文', tags: ['クイック編集'], type: 'memo' } });
  expect(memoResponse.ok()).toBeTruthy();
  const memo = await memoResponse.json() as { id: string };
  const article = await readerCard(request, {
    title: `Quick article ${stamp()}`,
    url: `https://example.test/${stamp()}`,
    paragraphs: ['カード一覧から開く記事の保存原文です。'],
    memo: '記事メモ',
  });
  const pdf = await readerCard(request, {
    title: `Quick PDF ${stamp()}`,
    fileName: 'quick-edit.pdf',
    paragraphs: ['[[page:1|1]]', 'カード一覧から開くPDF原文です。'],
    memo: 'PDFメモ',
  });

  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');
    for (const card of [
      { id: memo.id, kind: 'memo', title: memoTitle, isPlain: true },
      { id: article.id, kind: 'article', title: article.title, isPlain: false },
      { id: pdf.id, kind: 'pdf', title: pdf.title, isPlain: false },
    ]) {
      await expect(page.locator(`#card-${card.id}`)).toBeVisible();
      await openCardEditorFromList(page, card.id);
      const editor = page.locator('#modal-reader .reader-modal');
      if (card.isPlain) await expect(editor).toHaveClass(/reader-plain-mode/);
      else await expect(editor).not.toHaveClass(/reader-plain-mode/);
      await expect(page.locator('#reader-edit-title')).toHaveValue(card.title);
      if (card.kind !== 'memo') await expect(page.locator('#reader-article')).toContainText(card.kind === 'pdf' ? 'カード一覧から開くPDF原文' : 'カード一覧から開く記事');
      await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-list-pencil-${card.kind}.png`), fullPage: true });
      await page.locator('#modal-reader').getByRole('button', { name: '閉じる', exact: true }).click();
    }
  }
});
