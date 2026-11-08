import { devices, expect, test, type APIRequestContext, type Page } from '@playwright/test';

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const paragraphs = [
  '電気料金を試算できる条件を説明する記事。',
  '計算: 月額料金',
  '式: total (円) = usage * rate',
  '入力: usage | 使用量 | kWh | 0 | 1000 | 300',
  '入力: rate | 単価 | 円/kWh | 0 | 50 | 25',
  '比較: CPU候補',
  '列: 候補|性能 (points)|消費電力 (W)',
  '行: A|80|65',
  '行: B|90|75',
];

async function openSavedReader(page: Page, request: APIRequestContext) {
  const id = stamp();
  const response = await request.post('/api/reader/save', { data: {
    title: `Reader tools ${id}`, url: `https://example.test/reader-tools-${id}`,
    fetchedAt: new Date().toISOString(), paragraphs, memo: '既存メモ', tags: [],
  } });
  expect(response.ok()).toBeTruthy();
  const { card } = await response.json();
  await page.goto('/');
  await page.locator('.card', { hasText: card.title }).click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await expect(page.locator('#reader-article')).toContainText('電気料金');
  await expect(page.locator('#reader-evidence-details')).toHaveJSProperty('open', false);
  await expect(page.locator('#reader-article .reader-tool-panel')).toHaveCount(0);
  return card;
}

test('uses inline calculator and comparison from source, then saves and restores input state', async ({ page, request }) => {
  const card = await openSavedReader(page, request);
  const equation = page.locator('#reader-article [data-index="2"]');
  await equation.selectText();
  await expect(page.locator('.reader-tool-panel')).toHaveCount(0);
  await page.getByRole('button', { name: '選択を引用' }).click();
  await expect(page.locator('#reader-memo')).toHaveValue(/式: total \(円\)/);
  await page.locator('#reader-memo').fill('既存メモ');
  await equation.click();
  const calculator = page.locator('.reader-tool-panel[aria-label="計算: 月額料金"]');
  await expect(calculator).toBeVisible();
  const usage = calculator.getByRole('spinbutton', { name: '使用量 (kWh)' });
  await usage.fill('2000');
  await expect(calculator.locator('output')).toHaveText('入力範囲を確認してください');
  await page.locator('#reader-save-btn').click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await usage.fill('400');
  await calculator.getByRole('spinbutton', { name: '単価 (円/kWh)' }).fill('30');
  await expect(calculator.locator('output')).toHaveText('結果: 12,000 円');
  await expect(calculator.getByRole('button', { name: '出典 ¶3' })).toBeVisible();

  await calculator.getByRole('button', { name: '操作パネルを閉じる' }).click();
  await page.locator('#reader-article [data-index="7"]').click();
  const comparison = page.locator('.reader-tool-panel[aria-label="比較: CPU候補"]');
  await expect(comparison).toBeVisible();
  await comparison.getByRole('spinbutton', { name: 'A 性能' }).fill('85');
  await comparison.getByRole('button', { name: '出典 ¶8' }).click();
  await expect(page.locator('#reader-article [data-index="7"]')).toBeInViewport();
  await page.locator('#reader-save-btn').click();
  await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);

  await page.locator('.card', { hasText: card.title }).click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await page.locator('#reader-article [data-index="2"]').click();
  await expect(page.locator('.reader-tool-panel input[aria-label="使用量 (kWh)"]')).toHaveValue('400');
  await expect(page.locator('.reader-tool-panel input[aria-label="単価 (円/kWh)"]')).toHaveValue('30');
  await page.locator('.reader-tool-panel [aria-label="操作パネルを閉じる"]').click();
  const keyboardTarget = page.locator('#reader-article [data-index="2"]');
  await keyboardTarget.focus();
  await keyboardTarget.press('Enter');
  await expect(page.locator('.reader-tool-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.reader-tool-panel')).toHaveCount(0);
  await expect(keyboardTarget).toBeFocused();
  await page.locator('#reader-article [data-index="7"]').click();
  await expect(page.locator('.reader-tool-panel input[aria-label="A 性能"]')).toHaveValue('85');
  await expect(page.locator('#reader-memo')).toHaveValue('既存メモ');
});

test('ordinary article stays unchanged and text selection remains available for quoting', async ({ page, request }) => {
  const response = await request.post('/api/reader/save', { data: {
    title: `Ordinary reader ${stamp()}`, url: `https://example.test/ordinary-${stamp()}`,
    fetchedAt: new Date().toISOString(), paragraphs: ['通常の評論記事です。', '数式のような記号 a*b が出ますが変数定義はありません。'], memo: '', tags: [],
  } });
  const { card } = await response.json();
  await page.goto('/');
  await page.locator('.card', { hasText: card.title }).click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  const paragraph = page.locator('#reader-article [data-index="1"]');
  await expect(paragraph).not.toHaveClass(/reader-tool-target/);
  await expect(page.locator('.reader-tool-panel')).toHaveCount(0);
});

test('searches a saved article, opens its linked memo in Reader, and saves a source-linked quote to the same card', async ({ page, request }) => {
  const id = stamp();
  const saved = await request.post('/api/reader/save', { data: {
    title: `Refind workflow ${id}`, url: `https://example.test/refind-workflow-${id}`,
    fetchedAt: new Date().toISOString(), paragraphs: ['保存済み記事の引用対象です。', '保存コピーと出典をReaderで再確認します。'],
    memo: '検索前からあるメモ', tags: [],
  } });
  expect(saved.ok()).toBeTruthy();
  const { card } = await saved.json();

  await page.goto('/');
  await page.locator('button[onclick="switchView(\'bm25\')"]').click();
  const cardsTarget = page.locator('#search-targets input[value="cards"]');
  await expect(cardsTarget).toBeVisible();
  if (!(await cardsTarget.isChecked())) await cardsTarget.check();
  await page.locator('#search-terms').fill(`Refind workflow ${id}`);
  await page.locator('#bm25-run-btn').click();
  const result = page.locator('#search-cards .score-card', { hasText: card.title });
  await expect(result).toBeVisible();
  await result.getByRole('button', { name: 'メモを読む' }).click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await expect(page.locator('#reader-memo')).toHaveValue('検索前からあるメモ');
  await expect(page.locator('#reader-url')).toHaveValue(card.url);

  await page.locator('#reader-article [data-index="0"]').selectText();
  await page.getByRole('button', { name: '選択を引用' }).click();
  await expect(page.locator('#reader-memo')).toHaveValue(/保存済み記事の引用対象です。 \[¶1\]/);
  await page.locator('#reader-save-btn').click();
  await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);
  const reopened = await request.get(`/api/reader/cards/${card.id}`);
  const updated = await reopened.json();
  expect(updated.id).toBe(card.id);
  expect(updated.url).toBe(card.url);
  expect(updated.memo).toContain('[¶1]');
  expect(updated.paragraphs[0]).toBe('保存済み記事の引用対象です。');
});

test('completes search, Reader tools, memo save, interruption, resume and source trace in one flow', async ({ page, request }) => {
  const id = stamp();
  const saved = await request.post('/api/reader/save', { data: {
    title: `Stable foundation integrated flow ${id}`, url: `https://example.test/integrated-${id}`,
    fetchedAt: new Date().toISOString(), paragraphs, memo: '既存メモを残して続ける', tags: [],
  } });
  expect(saved.ok()).toBeTruthy();
  const { card } = await saved.json();

  await page.goto('/');
  await page.locator('button[onclick="switchView(\'bm25\')"]').click();
  const cardsTarget = page.locator('#search-targets input[value="cards"]');
  if (!(await cardsTarget.isChecked())) await cardsTarget.check();
  await page.locator('#search-terms').fill(`Stable foundation integrated flow ${id}`);
  await page.locator('#bm25-run-btn').click();
  const result = page.locator('#search-cards .score-card', { hasText: card.title });
  await expect(result).toBeVisible();
  await result.getByRole('button', { name: 'メモを読む' }).click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await expect(page.locator('#reader-memo')).toHaveValue('既存メモを残して続ける');
  await expect(page.locator('#reader-url')).toHaveValue(card.url);

  await page.locator('#reader-article [data-index="0"]').selectText();
  await page.getByRole('button', { name: '選択を引用' }).click();
  await expect(page.locator('#reader-memo')).toHaveValue(/電気料金を試算できる条件を説明する記事。 \[¶1\]/);
  await page.locator('#reader-article [data-index="2"]').click();
  const calculator = page.locator('.reader-tool-panel[aria-label="計算: 月額料金"]');
  await calculator.getByRole('spinbutton', { name: '使用量 (kWh)' }).fill('400');
  await calculator.getByRole('spinbutton', { name: '単価 (円/kWh)' }).fill('30');
  await expect(calculator.locator('output')).toHaveText('結果: 12,000 円');
  await calculator.getByRole('button', { name: '操作パネルを閉じる' }).click();
  await page.locator('#reader-article [data-index="7"]').click();
  const comparison = page.locator('.reader-tool-panel[aria-label="比較: CPU候補"]');
  await comparison.getByRole('spinbutton', { name: 'A 性能' }).fill('85');
  await page.locator('#reader-save-btn').click();
  await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);
  const updated = await (await request.get(`/api/reader/cards/${card.id}`)).json();
  expect(updated.id).toBe(card.id);
  expect(updated.memo).toContain('[¶1]');

  await result.getByRole('button', { name: 'メモを読む' }).click();
  await expect(page.locator('#reader-article')).toContainText(card.title);
  await page.evaluate(() => (window as unknown as Window & { setContextualFeature: (feature: string, enabled: boolean) => void }).setContextualFeature('f4', true));
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mySearch:lastReaderSession:v1') || 'null')?.cardId)).toBe(card.id);
  await page.reload();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await expect(page.locator('#reader-memo')).toHaveValue(/電気料金を試算できる条件を説明する記事。 \[¶1\]/);
  await page.locator('#reader-article [data-index="2"]').click();
  const restoredCalculator = page.locator('.reader-tool-panel[aria-label="計算: 月額料金"]');
  await expect(restoredCalculator.getByRole('spinbutton', { name: '使用量 (kWh)' })).toHaveValue('400');
  await expect(restoredCalculator.getByRole('spinbutton', { name: '単価 (円/kWh)' })).toHaveValue('30');
  await restoredCalculator.getByRole('button', { name: '操作パネルを閉じる' }).click();
  await page.locator('#reader-article [data-index="7"]').click();
  const restoredComparison = page.locator('.reader-tool-panel[aria-label="比較: CPU候補"]');
  await expect(restoredComparison.getByRole('spinbutton', { name: 'A 性能' })).toHaveValue('85');
  await restoredComparison.getByRole('button', { name: '出典 ¶8' }).click();
  await expect(page.locator('#reader-article [data-index="7"]')).toBeInViewport();
  const allCards = await (await request.get('/api/cards')).json();
  expect(allCards.filter((item: { id: string }) => item.id === card.id)).toHaveLength(1);
});

test('keeps a saved article and memo readable when its original URL is offline', async ({ page, request }) => {
  const id = stamp();
  const saved = await request.post('/api/reader/save', { data: {
    title: `Offline saved copy ${id}`, url: `https://example.test/offline-saved-copy-${id}`,
    fetchedAt: new Date().toISOString(), paragraphs: ['保存時点の本文コピーです。', '外部URLが使えなくても残る段落です。'],
    memo: 'ネットワーク障害前のメモ', tags: [],
  } });
  expect(saved.ok()).toBeTruthy();
  const { card } = await saved.json();
  await page.route('https://example.test/**', route => route.abort());
  await page.goto('/');
  await page.locator('.card', { hasText: card.title }).click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await expect(page.locator('#reader-article')).toContainText('保存時点の本文コピーです。');
  await expect(page.locator('#reader-memo')).toHaveValue('ネットワーク障害前のメモ');
  await page.locator('#reader-memo').fill('オフライン中に追記したメモ');
  await page.locator('#reader-save-btn').click();
  await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);
  const reopened = await (await request.get(`/api/reader/cards/${card.id}`)).json();
  expect(reopened.memo).toBe('オフライン中に追記したメモ');
  expect(reopened.paragraphs).toContain('保存時点の本文コピーです。');
});

test('keeps saved-card search, Reader and memo updates available with AI and Reader tools disabled', async ({ page, request }) => {
  const id = stamp();
  const saved = await request.post('/api/reader/save', { data: {
    title: `No AI workflow ${id}`, url: `https://example.test/no-ai-${id}`,
    fetchedAt: new Date().toISOString(), paragraphs: ['AI機能なしでも読める保存済み記事です。'], memo: '以前からあるメモ', tags: [],
  } });
  expect(saved.ok()).toBeTruthy();
  const { card } = await saved.json();
  await page.route('**/api/features', route => route.fulfill({ json: { demo: false, ai: false, readerTools: false, pdfMaxMb: 20, samples: [] } }));
  await page.goto('/');
  await page.locator('button[onclick="switchView(\'bm25\')"]').click();
  const cardsTarget = page.locator('#search-targets input[value="cards"]');
  await expect(cardsTarget).toBeVisible();
  if (!(await cardsTarget.isChecked())) await cardsTarget.check();
  await page.locator('#search-terms').fill(`No AI workflow ${id}`);
  await page.locator('#bm25-run-btn').click();
  const result = page.locator('#search-cards .score-card', { hasText: card.title });
  await expect(result).toBeVisible();
  await result.getByRole('button', { name: 'メモを読む' }).click();
  await expect(page.locator('#reader-memo')).toHaveValue('以前からあるメモ');
  await expect(page.locator('#reader-article .reader-tool-target')).toHaveCount(0);
  await page.locator('#reader-memo').fill('AIなしで追記したメモ');
  await page.locator('#reader-save-btn').click();
  const reopened = await (await request.get(`/api/reader/cards/${card.id}`)).json();
  expect(reopened.memo).toBe('AIなしで追記したメモ');
  expect(reopened.paragraphs).toEqual(['AI機能なしでも読める保存済み記事です。']);
});

test('resumes the active saved article and reading position after reload without creating another card', async ({ page, request }) => {
  const id = stamp();
  const body = Array.from({ length: 12 }, (_, index) => `段落${index + 1}。${'保存した記事を読みながら作業を続けるための本文です。'.repeat(12)}`);
  const saved = await request.post('/api/reader/save', { data: {
    title: `Resume reader ${id}`, url: `https://example.test/resume-${id}`,
    fetchedAt: new Date().toISOString(), paragraphs: body, memo: '再開後も残るメモ', tags: [],
  } });
  expect(saved.ok()).toBeTruthy();
  const { card } = await saved.json();
  await page.goto('/');
  await page.locator('.card', { hasText: card.title }).click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await expect(page.locator('#reader-article')).toContainText('段落1');
  await expect(page.locator('#reader-memo')).toHaveValue('再開後も残るメモ');

  await page.locator('#reader-article [data-index="8"]').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mySearch:lastReaderSession:v1') || 'null')?.paragraphIndex)).toBe(8);
  await page.reload();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await expect(page.locator('#reader-article')).toContainText(card.title);
  await expect(page.locator('#reader-memo')).toHaveValue('再開後も残るメモ');
  await expect.poll(() => page.locator('.reader-left').evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  await page.locator("#modal-reader button[onclick=\"closeModal('modal-reader')\"]").click();
  await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);
  expect(await page.evaluate(() => localStorage.getItem('mySearch:lastReaderSession:v1'))).toBeNull();
  await page.reload();
  await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);
  const allCards = await request.get('/api/cards');
  const cards = await allCards.json();
  expect(cards.filter((item: { id: string }) => item.id === card.id)).toHaveLength(1);
});

test('reopening and saving the same logical article updates one card instead of duplicating it', async ({ page, request }) => {
  const id = stamp();
  const saved = await request.post('/api/reader/save', { data: {
    title: `Repeated save ${id}`, url: `https://example.test/repeated-save-${id}`,
    fetchedAt: new Date().toISOString(), paragraphs: ['同じ記事の保存コピーです。'], memo: '初回メモ', tags: [],
  } });
  expect(saved.ok()).toBeTruthy();
  const { card } = await saved.json();
  await page.goto('/');
  for (const memo of ['2回目のメモ', '3回目のメモ']) {
    await page.locator('.card', { hasText: card.title }).click();
    await expect(page.locator('#modal-reader')).toHaveClass(/active/);
    await expect(page.locator('#reader-memo')).not.toHaveValue('');
    await page.locator('#reader-memo').fill(memo);
    await page.locator('#reader-save-btn').click();
    await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);
  }
  const cards = await (await request.get('/api/cards')).json();
  expect(cards.filter((item: { id: string; url?: string }) => item.url === card.url)).toHaveLength(1);
  const updated = await (await request.get(`/api/reader/cards/${card.id}`)).json();
  expect(updated.memo).toBe('3回目のメモ');
  expect(updated.id).toBe(card.id);
});

test('shows a source-change warning and preserves saved tool values while memo edits continue', async ({ page, request }) => {
  const id = stamp();
  const saved = await request.post('/api/reader/save', { data: {
    title: `Changed source ${id}`, url: `https://example.test/changed-source-${id}`,
    fetchedAt: new Date().toISOString(), paragraphs, memo: '> 電気料金を試算できる条件を説明する記事。 [¶1]\n古い本文に基づくメモ', tags: [],
  } });
  const { card } = await saved.json();
  const opened = await request.get(`/api/reader/cards/${card.id}`);
  const current = await opened.json();
  const tool = current.tools.find((item: { kind: string }) => item.kind === 'calculator');
  expect(tool).toBeTruthy();
  const storedValues = { [tool.id]: { usage: 450, rate: 30 } };
  await request.put(`/api/reader/cards/${card.id}`, { data: {
    title: current.title, url: current.url, fetchedAt: current.fetchedAt,
    paragraphs: current.paragraphs, memo: current.memo, tags: [],
    toolState: { version: 1, sourceHash: current.toolsSourceHash, values: storedValues },
  } });
  const changedParagraphs = ['追加された新しい段落です。', ...current.paragraphs];
  await request.put(`/api/reader/cards/${card.id}`, { data: {
    title: current.title, url: current.url, fetchedAt: current.fetchedAt,
    paragraphs: changedParagraphs, memo: current.memo, tags: [],
  } });

  await page.goto('/');
  await page.locator('.card', { hasText: card.title }).click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await expect(page.locator('#reader-tool-state-stale')).toContainText('本文が保存時から変わった');
  await expect(page.locator('#reader-memo-source-stale')).toContainText('本文との一致がなく変更の可能性がある箇所');
  await expect(page.locator('#reader-article .reader-tool-target')).toHaveCount(0);
  await expect(page.locator('#reader-memo')).toHaveValue(/古い本文に基づくメモ/);
  await page.locator('#reader-memo').evaluate(element => { const memo = element as HTMLTextAreaElement; memo.focus(); memo.setSelectionRange(3, 3); });
  await page.keyboard.press('Alt+j');
  await expect(page.locator('#toast')).toContainText('引用元の本文と一致しません。メモと引用は保持');
  await expect(page.locator('.reader-left')).toHaveJSProperty('scrollTop', 0);
  await page.locator('#reader-memo').fill('更新確認を追記したメモ\n\n> 電気料金を試算できる条件を説明する記事。 [¶1]');
  await page.locator('#reader-save-btn').click();
  await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);

  const reopenedResponse = await request.get(`/api/reader/cards/${card.id}`);
  const reopened = await reopenedResponse.json();
  expect(reopened.memo).toContain('更新確認を追記したメモ');
  expect(reopened.memo).toContain('> 電気料金を試算できる条件を説明する記事。 [¶1]');
  expect(reopened.toolState.sourceHash).not.toBe(reopened.toolsSourceHash);
  await page.locator('.card', { hasText: card.title }).click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await expect(page.locator('#reader-tool-state-stale')).toBeVisible();
  await expect(page.locator('#reader-memo')).toHaveValue(/更新確認を追記したメモ/);
});

test('keeps a duplicate source quote and refuses to guess its Reader location', async ({ page, request }) => {
  const id = stamp();
  const duplicateQuote = '本文内で二度出てくる保存済みの引用文です。';
  const saved = await request.post('/api/reader/save', { data: {
    title: `Ambiguous saved quote ${id}`, url: `https://example.test/ambiguous-quote-${id}`,
    fetchedAt: new Date().toISOString(), paragraphs: [duplicateQuote, duplicateQuote],
    memo: `> ${duplicateQuote} [¶1]\n引用位置を曖昧扱いする確認`, tags: [],
  } });
  expect(saved.ok()).toBeTruthy();
  const { card } = await saved.json();

  await page.goto('/');
  await page.locator('.card', { hasText: card.title }).click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await expect(page.locator('#reader-memo-source-stale')).toContainText('本文内で引用が重複し位置を確定できない');
  const memoBefore = await page.locator('#reader-memo').inputValue();
  await page.locator('#reader-memo').evaluate(element => {
    const memo = element as HTMLTextAreaElement;
    memo.focus(); memo.setSelectionRange(3, 3);
  });
  await page.keyboard.press('Alt+j');
  await expect(page.locator('#toast')).toContainText('引用文が本文内で重複しており位置を特定できません');
  await expect(page.locator('.reader-left')).toHaveJSProperty('scrollTop', 0);
  await expect(page.locator('#reader-memo')).toHaveValue(memoBefore);
});

test('discards corrupt last-session cache without changing a saved memo or tool state', async ({ page, request }) => {
  const id = stamp();
  const saved = await request.post('/api/reader/save', { data: {
    title: `Corrupt session cache ${id}`, url: `https://example.test/corrupt-session-${id}`,
    fetchedAt: new Date().toISOString(), paragraphs, memo: '永続メモは維持', tags: [],
  } });
  expect(saved.ok()).toBeTruthy();
  const { card } = await saved.json();
  const before = await (await request.get(`/api/reader/cards/${card.id}`)).json();
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('mySearch:lastReaderSession:v1', '{broken json'));
  await page.reload();
  await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);
  await expect(page.getByRole('button', { name: '探す' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('mySearch:lastReaderSession:v1'))).toBeNull();
  const after = await (await request.get(`/api/reader/cards/${card.id}`)).json();
  expect(after).toEqual(before);
  await page.evaluate(cardId => localStorage.setItem('mySearch:lastReaderSession:v1', JSON.stringify({
    version: 1, cardId, url: null, candidateId: null, paragraphIndex: null,
    paragraphFingerprint: null, updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
  })), card.id);
  await page.reload();
  await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);
  expect(await page.evaluate(() => localStorage.getItem('mySearch:lastReaderSession:v1'))).toBeNull();
  expect(await (await request.get(`/api/reader/cards/${card.id}`)).json()).toEqual(before);
});

test('falls back to the top when the saved reading paragraph no longer exists', async ({ page, request }) => {
  const id = stamp();
  const saved = await request.post('/api/reader/save', { data: {
    title: `Changed reading position ${id}`, url: `https://example.test/changed-position-${id}`,
    fetchedAt: new Date().toISOString(), paragraphs: ['更新後の先頭段落です。', '更新後の本文です。'], memo: '更新前からのメモ', tags: [],
  } });
  expect(saved.ok()).toBeTruthy();
  const { card } = await saved.json();
  await page.goto('/');
  await page.evaluate(cardId => localStorage.setItem('mySearch:lastReaderSession:v1', JSON.stringify({
    version: 1, cardId, url: null, candidateId: null, paragraphIndex: 8,
    paragraphFingerprint: '10:deadbeef', updatedAt: Date.now(),
  })), card.id);
  await page.reload();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await expect(page.locator('#reader-resume-status')).toContainText('本文が保存時から変わった');
  await expect(page.locator('#reader-memo')).toHaveValue('更新前からのメモ');
  await expect(page.locator('.reader-left')).toHaveJSProperty('scrollTop', 0);
});

test('article-provided HTML-like labels stay inert in Reader and tool UI', async ({ page, request }) => {
  const payload = '<img src=x onerror=alert(1)>';
  const response = await request.post('/api/reader/save', { data: {
    title: `Untrusted tool label ${stamp()}`, url: `https://example.test/untrusted-${stamp()}`,
    fetchedAt: new Date().toISOString(), paragraphs: [
      '計算式のラベル安全性を確認する見本。',
      '計算: 安全な表示',
      '式: total (units) = value',
      `入力: value | ${payload} | units | 0 | 10 | 5`,
    ], memo: '', tags: [],
  } });
  const { card } = await response.json();
  await page.goto('/');
  await page.locator('.card', { hasText: card.title }).click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await page.locator('#reader-article p').filter({ hasText: '式: total (units)' }).click();
  await expect(page.locator('.reader-tool-panel')).toContainText(payload);
  await expect(page.locator('#reader-article img, .reader-tool-panel img')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('failed save keeps the Reader open with its memo and tool inputs available for retry', async ({ page, request }) => {
  await openSavedReader(page, request);
  const equation = page.locator('#reader-article p').filter({ hasText: '式: total (円)' });
  await equation.click();
  const panel = page.locator('.reader-tool-panel[aria-label="計算: 月額料金"]');
  await panel.getByRole('spinbutton', { name: '使用量 (kWh)' }).fill('450');
  await page.locator('#reader-memo').fill('保存失敗後も残るメモ');
  await page.route('**/api/reader/cards/**', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '保存失敗の試験', code: 'injected_failure', requestId: 'reader-save-test' }) })
    : route.continue());
  await page.locator('#reader-save-btn').click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await expect(page.locator('#reader-memo')).toHaveValue('保存失敗後も残るメモ');
  await expect(panel.getByRole('spinbutton', { name: '使用量 (kWh)' })).toHaveValue('450');
  await expect(page.locator('#toast')).toContainText('injected_failure');
});

test('article fetch failure falls back to manual reading and normal card saving', async ({ page }) => {
  await page.route('**/api/reader/extract', route => route.fulfill({
    status: 502, contentType: 'application/json', body: JSON.stringify({ error: '試験用の取得失敗', code: 'reader_fetch_failed' }),
  }));
  await page.goto('/');
  await page.locator('button[data-view="bm25"]').click();
  await page.getByRole('button', { name: '読む・メモ', exact: true }).first().click();
  await expect(page.locator('#modal-reader .reader-modal')).not.toHaveClass(/reader-has-source/);
  await page.locator('#reader-url').fill('https://example.test/offline-article');
  await page.locator('#modal-reader .reader-bar button').first().click();
  await expect(page.locator('#reader-article .reader-error')).toContainText('reader_fetch_failed');
  await page.locator('.reader-manual-source summary').click();
  const title = `Manual fallback ${stamp()}`;
  await page.locator('#reader-fallback-title').fill(title);
  await page.locator('#reader-manual-text').fill('ネットワーク取得に失敗した後の手動本文です。');
  await page.locator('.reader-manual-source button').click();
  await expect(page.locator('#reader-article')).toContainText('手動本文');
  await expect(page.locator('#modal-reader .reader-modal')).toHaveClass(/reader-has-source/);
  await expect(page.locator('.reader-right')).toBeVisible();
  await page.locator('#reader-memo').fill('通常のメモ保存へ戻れた');
  await page.locator('#reader-save-btn').click();
  await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);
  await expect(page.locator('#card-grid')).toContainText(title);
});

test('administration actions remain reachable from the compact top bar', async ({ page }) => {
  await page.goto('/');
  const menu = page.locator('#topbar .topbar-admin');
  await menu.locator('summary').click();
  await menu.getByRole('button', { name: '情報源を管理' }).click();
  await expect(page.locator('#source-modal')).toHaveClass(/active/);
  await page.locator('#source-modal').getByRole('button', { name: '閉じる' }).click();
  await menu.locator('summary').click();
  await menu.getByRole('button', { name: 'データ取り込み' }).click();
  await expect(page.locator('#modal-csv')).toHaveClass(/active/);
});

test('touch opens an applicable tool from its source paragraph', async ({ browser, request }) => {
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  try {
    const page = await context.newPage();
    const response = await request.post('/api/reader/save', { data: {
      title: `Touch reader ${stamp()}`, url: `https://example.test/touch-${stamp()}`,
      fetchedAt: new Date().toISOString(), paragraphs, memo: '', tags: [],
    } });
    const { card } = await response.json();
    await page.goto('/');
    await page.evaluate(id => (window as any).openReaderForCard(id), card.id);
    await expect(page.locator('#reader-article')).toContainText('電気料金');
    await page.locator('#reader-article [data-index="2"]').tap();
    await expect(page.locator('.reader-tool-panel[aria-label="計算: 月額料金"]')).toBeVisible();
  } finally { await context.close(); }
});

test('internal feature flag hides tools and preserves ordinary Reader', async ({ page, request }) => {
  test.skip(process.env.READER_TOOLS_ENABLED !== 'false', 'run with READER_TOOLS_ENABLED=false');
  const response = await request.post('/api/reader/save', { data: {
    title: `Flagged reader ${stamp()}`, url: `https://example.test/flagged-${stamp()}`,
    fetchedAt: new Date().toISOString(), paragraphs, memo: '保存は継続', tags: [],
  } });
  const { card } = await response.json();
  await page.goto('/');
  await page.evaluate(id => (window as any).openReaderForCard(id), card.id);
  await expect(page.locator('#reader-article')).toContainText('電気料金');
  await expect(page.locator('#reader-article .reader-tool-target')).toHaveCount(0);
  await expect(page.locator('.reader-tool-panel')).toHaveCount(0);
  await expect(page.locator('#reader-memo')).toHaveValue('保存は継続');
});

test('demo sample supports the full saved-article, tool, memo and resume flow', async ({ page }) => {
  test.skip(process.env.DEMO_MODE !== 'true', 'run against the isolated demo database');
  await page.goto('/');
  const title = '記事内の計算と比較を操作する見本';
  const sampleMenu = page.locator('#demo-banner .demo-samples');
  await expect(sampleMenu).toHaveJSProperty('open', false);
  await sampleMenu.locator('summary').click();
  await sampleMenu.getByRole('button', { name: title, exact: true }).click();
  await expect(page.locator('#reader-article')).toContainText('数値は説明用');
  await page.locator('#reader-article p').filter({ hasText: '式: total (円)' }).click();
  await expect(page.locator('.reader-tool-panel[aria-label="計算: 月額料金の簡易見積もり"]')).toBeVisible();
  await page.locator('.reader-tool-panel [aria-label="操作パネルを閉じる"]').click();
  await page.locator('#modal-reader').getByRole('button', { name: '閉じる' }).click();

  const card = page.locator('.card', { hasText: title });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await expect(page.locator('#reader-article')).toContainText('数値は説明用');

  await page.locator('#reader-article p').filter({ hasText: '式: total (円)' }).click();
  const calculator = page.locator('.reader-tool-panel[aria-label="計算: 月額料金の簡易見積もり"]');
  await calculator.getByRole('spinbutton', { name: '使用量 (kWh)' }).fill('500');
  await calculator.getByRole('spinbutton', { name: '単価 (円/kWh)' }).fill('20');
  await expect(calculator.locator('output')).toHaveText('結果: 10,000 円');
  await calculator.getByRole('button', { name: '操作パネルを閉じる' }).click();

  await page.locator('#reader-article p').filter({ hasText: '行: Cedar|80|65' }).click();
  const comparison = page.locator('.reader-tool-panel[aria-label="比較: 架空のCPU候補"]');
  await comparison.getByRole('spinbutton', { name: 'Cedar 性能' }).fill('88');
  await comparison.getByRole('button', { name: '操作パネルを閉じる' }).click();
  await page.locator('#reader-memo').fill('試算と比較を確認した。');
  await page.locator('#reader-save-btn').click();
  await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);

  await page.locator('.card', { hasText: title }).click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await page.locator('#reader-article p').filter({ hasText: '式: total (円)' }).click();
  await expect(page.locator('.reader-tool-panel input[aria-label="使用量 (kWh)"]')).toHaveValue('500');
  await page.locator('.reader-tool-panel [aria-label="操作パネルを閉じる"]').click();
  await page.locator('#reader-article p').filter({ hasText: '行: Cedar|80|65' }).click();
  await expect(page.locator('.reader-tool-panel input[aria-label="Cedar 性能"]')).toHaveValue('88');
  await expect(page.locator('#reader-memo')).toHaveValue('試算と比較を確認した。');
});

test('narrow viewport keeps primary navigation and Reader controls within the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '探す' })).toBeVisible();
  await expect(page.locator('#refind-study-list-control details')).toHaveJSProperty('open', false);
  const overflow = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('body *'))
    .filter(element => element.getBoundingClientRect().right > window.innerWidth + 1)
    .slice(0, 12)
    .map(element => ({ tag: element.tagName, id: element.id, className: String(element.className), right: Math.round(element.getBoundingClientRect().right), width: Math.round(element.getBoundingClientRect().width) })));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), JSON.stringify(overflow)).toBe(true);
  await page.getByRole('button', { name: '探す' }).click();
  await expect(page.locator('#search-terms')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('#topbar .topbar-library > summary').click();
  await page.locator('#topbar .topbar-library').getByRole('button', { name: '記事・メモを管理', exact: true }).click();
  await page.locator('button[data-view="bm25"]').click();
  await page.getByRole('button', { name: '読む・メモ', exact: true }).first().click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await expect(page.locator('#fab')).not.toBeVisible();
  const readerOverflow = await page.locator('#modal-reader .reader-modal').evaluate(element => ({
    scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
    children: Array.from(element.querySelectorAll<HTMLElement>('*')).filter(child => child.getBoundingClientRect().right > element.getBoundingClientRect().right + 1)
      .slice(0, 10).map(child => ({ tag: child.tagName, id: child.id, className: String(child.className), right: Math.round(child.getBoundingClientRect().right), width: Math.round(child.getBoundingClientRect().width) })),
  }));
  expect(readerOverflow.scrollWidth <= readerOverflow.clientWidth, JSON.stringify(readerOverflow)).toBe(true);
  await expect(page.locator('.reader-left')).toBeVisible();
  await expect(page.locator('.reader-right')).toBeHidden();
});
