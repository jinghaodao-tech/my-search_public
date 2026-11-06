import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function createReaderCard(request: APIRequestContext, title: string, paragraphs: string[], memo = '') {
  const response = await request.post('/api/reader/save', { data: {
    title, url: `https://example.test/${encodeURIComponent(title)}`, fetchedAt: new Date().toISOString(),
    paragraphs, memo, tags: [],
  } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).card;
}

async function openSearch(page: Page, query: string) {
  await page.locator('button[onclick="switchView(\'bm25\')"]').click();
  await page.locator('#search-terms').fill(query);
  await page.locator('#bm25-run-btn').click();
}

async function openCardReader(page: Page, title: string) {
  await page.locator('.card', { hasText: title }).click();
  await page.locator('button[onclick="openReaderForCard(currentCardId)"]').click();
  await expect(page.locator('#reader-article')).toBeVisible();
}

async function openAutomationSettings(page: Page) {
  await page.locator('#topbar .topbar-admin > summary').click();
  await page.getByRole('button', { name: '状況別の補助機能' }).click();
  await expect(page.locator('#modal-contextual-settings')).toHaveClass(/active/);
}

test('F1 opens only verified snippet positions and preserves the saved-card search list', async ({ page, request }) => {
  const id = stamp();
  const articles = [
    await createReaderCard(request, `F1 unique ${id}`, ['先頭段落。', '一致する検索スニペットの本文です。', '末尾段落。']),
    await createReaderCard(request, `F1 ambiguous ${id}`, ['重複する検索スニペットです。', '別の段落。', '重複する検索スニペットです。']),
    await createReaderCard(request, `F1 missing ${id}`, ['保存本文には別の文章だけがあります。']),
  ];
  const snippets = ['一致する検索スニペットの本文です。', '重複する検索スニペットです。', '検索抜粋にしかない文章です。'];
  await page.route('**/api/cards/search', route => route.fulfill({ json: {
    active: articles.map((article, index) => ({ article, score: 3 - index, snippet: snippets[index], matchedKeywords: [] })),
    archived: [], scope: { corpus: 'cards', totalCount: articles.length, searchedCount: articles.length },
  } }));

  await page.goto('/');
  await openSearch(page, `F1 ${id}`);
  const unique = page.locator('.score-card', { hasText: articles[0].title });
  await expect(unique).toBeVisible();
  await unique.getByRole('button', { name: '本文の該当箇所を見る' }).click();
  await expect(page.locator('#reader-search-passage-choice')).toContainText('一意な一致を確認');
  await expect(page.locator('#reader-article [data-index="1"]')).toHaveClass(/quote-flash/);
  await page.locator('#modal-reader').getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('#search-terms')).toHaveValue(`F1 ${id}`);
  await expect(unique).toBeVisible();

  const ambiguous = page.locator('.score-card', { hasText: articles[1].title });
  await ambiguous.getByRole('button', { name: '本文の該当箇所を見る' }).click();
  await expect(page.locator('#reader-search-passage-choice')).toContainText('2箇所');
  await expect(page.locator('#reader-search-passage-choice button')).toHaveCount(2);
  await expect(page.locator('#reader-article .quote-flash')).toHaveCount(0);
  await page.locator('#modal-reader').getByRole('button', { name: '閉じる' }).click();

  const missing = page.locator('.score-card', { hasText: articles[2].title });
  await missing.getByRole('button', { name: '本文の該当箇所を見る' }).click();
  await expect(page.locator('#reader-search-passage-choice')).toContainText('一意に確認できません');
  await expect(page.locator('#reader-article .quote-flash')).toHaveCount(0);
});

test('F2 distinguishes a saved-card search API failure from zero results and retries unchanged terms', async ({ page, request }) => {
  const id = stamp();
  const card = await createReaderCard(request, `F2 retry ${id}`, ['障害から復旧する保存カードです。'], '元のメモ');
  let attempts = 0;
  await page.route('**/api/cards/search', async route => {
    attempts++;
    if (attempts === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary failure' }) });
    else await route.continue();
  });
  await page.goto('/');
  await openSearch(page, card.title);
  const failure = page.locator('#search-cards [role="status"]');
  await expect(failure).toContainText('エラーが発生しました');
  await expect(failure).not.toContainText('見つかりませんでした');
  await expect(page.locator('#search-terms')).toHaveValue(card.title);
  await failure.getByRole('button', { name: '同じ条件で再試行' }).click();
  await expect(page.locator('.score-card', { hasText: card.title })).toBeVisible();
  expect(attempts).toBe(2);
});

test('F2 gives a retry path for collected-search API errors without changing scope or query', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/search/targets', route => route.fulfill({ json: {
    collected: [{ value: 'rss:fixture', label: 'テストフィード', kind: 'feed', count: 1, searchable: 'fulltext' }],
    collectedTotal: 1,
    cards: { value: 'cards', label: '自分のカード', count: 0 },
    web: [],
  } }));
  await page.route('**/api/run', async route => {
    attempts++;
    if (attempts === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary failure' }) });
    else await route.continue();
  });
  await page.goto('/');
  await openSearch(page, '障害後も検索文を保持');
  const failure = page.locator('#search-collected #collected-search-failure');
  await expect(failure).toContainText('今回の収集記事検索を完了できませんでした');
  await expect(failure).toContainText('記事が存在しないとは判断できません');
  await expect(page.locator('#search-terms')).toHaveValue('障害後も検索文を保持');
  await failure.getByRole('button', { name: '同じ条件で再試行' }).click();
  await expect(page.locator('#collected-search-failure')).toHaveCount(0);
  expect(attempts).toBe(2);
});

test('F2 records one display event for a saved-card no-result hint', async ({ page, request }) => {
  const id = stamp();
  await createReaderCard(request, `F2 telemetry ${id}`, ['保存記事の存在を検索します。']);
  await page.goto('/');
  await openAutomationSettings(page);
  await page.locator('#contextual-study-consent').check();
  await page.locator('#modal-contextual-settings .modal-footer button').click();
  await page.route('**/api/cards/search', route => route.fulfill({ json: {
    active: [], archived: [], scope: { corpus: 'cards', totalCount: 1, searchedCount: 1 },
  } }));
  await openSearch(page, `no-match-${id}`);
  await expect(page.locator('#search-cards .no-result-box')).toBeVisible();
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('mySearch:contextualStudy:events:v1') || '[]')
    .filter((event: { feature: string; event: string; trigger: string }) => event.feature === 'f2' && event.event === 'shown' && event.trigger === 'search_no_results').length)).toBe(1);
});

test('search-term AI suggestions are cancelled when the user changes the query', async ({ page }) => {
  await page.addInitScript(() => {
    const globals = window as unknown as { LanguageModel: unknown; mockPromptStarted: boolean };
    globals.mockPromptStarted = false;
    globals.LanguageModel = {
      availability: async () => 'available',
      create: async () => ({ clone: async () => ({
        prompt: async (_text: string, options: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
          globals.mockPromptStarted = true;
          const timer = window.setTimeout(() => resolve('{"terms":["古い検索の候補"]}'), 500);
          options.signal?.addEventListener('abort', () => {
            window.clearTimeout(timer);
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        }),
        destroy() {},
      }) }),
    };
  });
  await page.goto('/');
  await openAutomationSettings(page);
  await page.locator('#contextual-study-consent').check();
  await page.locator('#modal-contextual-settings .modal-footer button').click();
  await openSearch(page, '古い検索語');
  const config = page.locator('#bm25-config');
  if (await config.evaluate(element => element.classList.contains('collapsed'))) {
    await page.locator('#bm25-config-header button').click();
  }
  await expect(page.locator('#search-details > summary')).toBeVisible();
  await page.locator('#search-details > summary').click();
  await page.locator('#search-advanced > summary').click();
  await page.getByRole('button', { name: 'AI類義語追加' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { mockPromptStarted: boolean }).mockPromptStarted)).toBe(true);
  await page.locator('#search-terms').fill('新しい検索語');
  await expect(page.locator('#search-terms')).toHaveValue('新しい検索語');
  await page.waitForTimeout(550);
  await expect(page.locator('#kw-list')).not.toContainText('古い検索の候補');
  const recordedEvents = await page.evaluate(() => JSON.parse(localStorage.getItem('mySearch:contextualStudy:events:v1') || '[]'));
  expect(recordedEvents).toContainEqual(expect.objectContaining({ feature: 'f2', event: 'started', trigger: 'user_action' }));
  expect(recordedEvents).toContainEqual(expect.objectContaining({ feature: 'f2', event: 'cancelled', outcome: 'cancelled', processor: 'chrome_local' }));
  expect(JSON.stringify(recordedEvents)).not.toContain('古い検索語');
  expect(JSON.stringify(recordedEvents)).not.toContain('新しい検索語');
});

test('F3 appends a source-linked quote to the selected memo and keeps it exportable', async ({ page, request }) => {
  const id = stamp();
  const quote = '別の記事から引き継ぐ引用文です。';
  const source = await createReaderCard(request, `F3 source ${id}`, ['引用の前置きです。', quote, '引用の後です。'], '引用元の既存メモ');
  const target = await createReaderCard(request, `F3 target ${id}`, ['比較メモ側の保存本文です。'], '比較前のメモは残します');

  await page.goto('/');
  await openCardReader(page, source.title);
  await page.locator('#reader-article [data-index="1"]').selectText();
  await page.getByRole('button', { name: '別メモへ引用' }).click();
  const transfer = page.locator('#reader-cross-quote');
  await expect(transfer).toBeVisible();
  await transfer.locator('#reader-cross-quote-target').selectOption(target.id);
  await transfer.getByRole('button', { name: '出典付きで追加' }).click();
  await expect(page.locator('#toast')).toContainText('引用と出典を保存メモへ追加');

  const sourceAfter = await (await request.get(`/api/reader/cards/${source.id}`)).json();
  const targetAfter = await (await request.get(`/api/reader/cards/${target.id}`)).json();
  expect(sourceAfter.paragraphs).toEqual(['引用の前置きです。', quote, '引用の後です。']);
  expect(sourceAfter.memo).toBe('引用元の既存メモ');
  expect(targetAfter.memo).toContain('比較前のメモは残します');
  expect(targetAfter.memo).toContain(quote);
  expect(targetAfter.memo).toContain(`保存カード ${source.id} · ¶2`);
  expect(targetAfter.memo).toContain('#my-search-source:');
  expect(targetAfter.paragraphs).toEqual(['比較メモ側の保存本文です。']);
  const markdown = await (await request.get(`/api/cards/${target.id}/export-md`)).text();
  expect(markdown).toContain(quote);
  expect(markdown).toContain(`#my-search-source:${source.id}`);
});

test('F4 offers a recoverable local draft and removes it when explicitly discarded', async ({ page, request }) => {
  const id = stamp();
  const card = await createReaderCard(request, `F4 draft ${id}`, ['再開確認用の本文です。'], '保存済みのメモ');
  await page.goto('/');
  await openCardReader(page, card.title);
  await page.locator('#reader-memo').fill('端末内だけの未保存メモ');
  const draftKey = `readerDraft:card:${card.id}`;
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), draftKey)).not.toBeNull();

  await page.locator('#modal-reader').getByRole('button', { name: '閉じる' }).click();
  await openCardReader(page, card.title);
  await expect(page.locator('#reader-draft')).toBeVisible();
  await page.locator('#reader-draft').getByRole('button', { name: '破棄' }).click();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), draftKey)).toBeNull();
  await expect(page.locator('#reader-memo')).toHaveValue('保存済みのメモ');
  await page.locator('#modal-reader').getByRole('button', { name: '閉じる' }).click();
  await page.reload();
  await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);
  await openCardReader(page, card.title);
  await expect(page.locator('#reader-draft')).toBeHidden();
  const persisted = await (await request.get(`/api/reader/cards/${card.id}`)).json();
  expect(persisted.memo).toBe('保存済みのメモ');
});

test('F5 is opt-in, validates a local model proposal, and does not persist the ephemeral tool', async ({ page, request }) => {
  const id = stamp();
  const paragraph = '数量は10〜20個（初期値15個）で、単価は20〜50円（初期値30円）です。';
  const card = await createReaderCard(request, `F5 proposal ${id}`, [paragraph]);
  await page.addInitScript(() => {
    const proposal = {
      supported: true,
      title: '合計額',
      expression: 'quantity*unitPrice',
      resultUnit: '円',
      sourceQuote: '数量は10〜20個（初期値15個）で、単価は20〜50円（初期値30円）です。',
      variables: [
        { key: 'quantity', label: '数量', unit: '個', min: 10, max: 20, initial: 15, quote: '数量は10〜20個（初期値15個）' },
        { key: 'unitPrice', label: '単価', unit: '円', min: 20, max: 50, initial: 30, quote: '単価は20〜50円（初期値30円）' },
      ],
    };
    (window as unknown as { LanguageModel: unknown }).LanguageModel = {
      availability: async () => 'available',
      create: async () => ({ clone: async () => ({ prompt: async () => JSON.stringify(proposal), destroy() {} }) }),
    };
  });

  await page.goto('/');
  await openAutomationSettings(page);
  const toggle = page.locator('[data-context-feature="f5"]');
  await expect(toggle).not.toBeChecked();
  await page.locator('#modal-contextual-settings .modal-footer button').click();
  await openCardReader(page, card.title);
  await page.locator('#reader-article [data-index="0"]').selectText();
  await expect(page.locator('#reader-ai-tool-propose')).toBeHidden();
  await page.locator('#modal-reader').getByRole('button', { name: '閉じる' }).click();

  await openAutomationSettings(page);
  await toggle.check();
  await page.locator('#modal-contextual-settings .modal-footer button').click();
  await openCardReader(page, card.title);
  await page.locator('#reader-article [data-index="0"]').selectText();
  const propose = page.locator('#reader-ai-tool-propose');
  await expect(propose).toBeVisible();
  await propose.click();
  const panel = page.locator('.reader-tool-panel[aria-label="計算: 合計額"]');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('式の意味・単位の整合性は未検証');
  await panel.getByRole('spinbutton', { name: '数量 (個)' }).fill('18');
  await panel.getByRole('spinbutton', { name: '単価 (円)' }).fill('40');
  await expect(panel.locator('output')).toHaveText('結果: 720 円');
  await panel.getByRole('button', { name: 'この提案を破棄' }).click();
  await expect(page.locator('.reader-tool-panel')).toHaveCount(0);
  await page.locator('#reader-save-btn').click();
  await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);
  const persisted = await (await request.get(`/api/reader/cards/${card.id}`)).json();
  expect(persisted.toolState).toBeNull();
  expect(persisted.paragraphs).toEqual([paragraph]);

  await openAutomationSettings(page);
  await expect(page.locator('[data-context-feature="f5"]')).toBeChecked();
  await page.locator('[data-context-feature="f5"]').uncheck();
  await page.locator('#modal-contextual-settings .modal-footer button').click();
  await openCardReader(page, card.title);
  await page.locator('#reader-article [data-index="0"]').selectText();
  await expect(page.locator('#reader-ai-tool-propose')).toBeHidden();
});

test('F6 first shows exact source passages without AI, then runs the mock only after an explicit action', async ({ page, request }) => {
  const id = stamp();
  const paragraph = '夜間バックアップは毎晩23時に実行します。失敗した場合は朝にログを確認して再実行します。';
  const card = await createReaderCard(request, `F6 backup ${id}`, [paragraph]);
  await page.goto('/');
  await openSearch(page, 'バックアップ');
  const result = page.locator('.score-card', { hasText: card.title });
  await expect(result).toBeVisible();
  await result.getByRole('button', { name: '検索目的に近い箇所を見る' }).click();
  await expect(page.locator('#reader-evidence-details')).toHaveJSProperty('open', true);
  await expect(page.locator('#evidence-results')).toContainText('検索目的の語をもとにしたルール処理');
  await expect(page.locator('#evidence-results')).toContainText('夜間バックアップは毎晩23時に実行します。');
  await expect(page.locator('#evidence-engine')).toContainText('テスト用のAIモック');
  await page.locator('#evidence-run').click();
  await expect(page.locator('#evidence-results')).toContainText('試験用モックの要点候補');
  await expect(page.locator('#evidence-results')).toContainText('実際のAI生成結果ではありません');
  const evidenceRow = page.locator('#evidence-results .evidence-row').first();
  const quote = evidenceRow.locator('.evidence-quote');
  await expect(quote).toContainText('夜間バックアップは毎晩23時に実行します。');
  await evidenceRow.getByRole('button', { name: '本文で見る' }).click();
  await expect(page.locator('#reader-article [data-index="0"]')).toHaveClass(/quote-flash/);
});

test('contextual study recording requires consent, exports locally, and excludes user content', async ({ page, request }) => {
  const privateQuery = `study-secret-${stamp()}`;
  const card = await createReaderCard(request, privateQuery, ['ローカル記録の対象本文です。']);
  await page.goto('/');
  await openAutomationSettings(page);
  const consent = page.locator('#contextual-study-consent');
  await expect(consent).not.toBeChecked();
  await consent.check();
  await page.locator('#modal-contextual-settings .modal-footer button').click();
  await openSearch(page, privateQuery);
  const result = page.locator('.score-card', { hasText: card.title });
  await expect(result).toBeVisible();
  await result.getByRole('button', { name: '本文の該当箇所を見る' }).click();
  const eventKey = 'mySearch:contextualStudy:events:v1';
  await expect.poll(async () => {
    const raw = await page.evaluate(key => localStorage.getItem(key), eventKey);
    return raw ? JSON.parse(raw).some((event: { feature: string; event: string }) => event.feature === 'f1' && event.event === 'started') : false;
  }).toBe(true);
  const saved = await page.evaluate(key => localStorage.getItem(key), eventKey);
  expect(saved).not.toBeNull();
  expect(saved).not.toContain(privateQuery);
  expect(saved).not.toContain(card.id);
  const events = JSON.parse(saved!);
  expect(events.some((event: { feature: string; event: string; trigger: string }) => event.feature === 'f1' && event.event === 'shown' && event.trigger === 'snippet_match')).toBe(true);
  expect(events.some((event: { feature: string; event: string; mode?: string }) => event.feature === 'f1' && event.event === 'started' && event.mode === 'manual')).toBe(true);

  await page.locator('#modal-reader').getByRole('button', { name: '閉じる' }).click();
  const downloadWait = page.waitForEvent('download');
  await page.locator('#topbar .topbar-admin > summary').click();
  await page.getByRole('button', { name: '状況別の補助機能' }).click();
  await page.locator('#contextual-study-export').click();
  const download = await downloadWait;
  expect(download.suggestedFilename()).toBe('my-search-contextual-study.json');
  await page.getByRole('button', { name: '記録を削除', exact: true }).click();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), eventKey)).toBeNull();
  await expect(page.locator('#contextual-study-count')).toContainText('0件');
  await consent.uncheck();
});

test('turning contextual features off hides only assistance and keeps ordinary search, Reader and saved data', async ({ page, request }) => {
  const id = stamp();
  const card = await createReaderCard(request, `off-mode ${id}`, ['機能停止中も読める本文です。'], '停止中も保持する既存メモ');
  await page.goto('/');
  await openAutomationSettings(page);
  for (const feature of ['f1', 'f2', 'f3', 'f4', 'f6']) await page.locator(`[data-context-feature="${feature}"]`).uncheck();
  await page.locator('#modal-contextual-settings .modal-footer button').click();

  await openSearch(page, card.title);
  const result = page.locator('.score-card', { hasText: card.title });
  await expect(result).toBeVisible();
  await expect(result.getByRole('button', { name: '本文の該当箇所を見る' })).toHaveCount(0);
  await expect(result.getByRole('button', { name: '検索目的に近い箇所を見る' })).toHaveCount(0);
  await result.getByRole('button', { name: 'メモを読む' }).click();
  await expect(page.locator('#reader-article')).toBeVisible();
  await expect(page.locator('#reader-cross-quote-open')).toBeHidden();
  const draftKey = `readerDraft:card:${card.id}`;
  await page.evaluate(({ key, memo }) => localStorage.setItem(key, JSON.stringify({ memo, tags: '', savedAt: new Date().toISOString() })), { key: draftKey, memo: 'OFF時に自動表示しない下書き' });
  await page.reload();
  await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);
  await openCardReader(page, card.title);
  await expect(page.locator('#reader-draft')).toBeHidden();
  await expect(page.locator('#reader-memo')).toHaveValue('停止中も保持する既存メモ');
  await page.locator('#modal-reader').getByRole('button', { name: '閉じる' }).click();

  await page.route('**/api/cards/search', route => route.fulfill({ json: {
    active: [], archived: [], scope: { corpus: 'cards', totalCount: 1, searchedCount: 1 },
  } }));
  await openSearch(page, `zzqmissing${id.replace(/[^a-z0-9]/gi, '')}zzq`);
  await expect(page.locator('#search-cards')).toContainText('合うカードはありませんでした');
  await expect(page.locator('#search-cards .no-result-box')).toHaveCount(0);
  const persisted = await (await request.get(`/api/reader/cards/${card.id}`)).json();
  expect(persisted.memo).toBe('停止中も保持する既存メモ');
  expect(persisted.paragraphs).toEqual(['機能停止中も読める本文です。']);
});
