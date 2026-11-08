import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate an isolated E2E port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function launchServer(port: number, dbPath: string, reset: boolean): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(port),
    CORS_ORIGIN: `http://127.0.0.1:${port}`,
    DB_PATH: dbPath,
    E2E_RESET_DB: String(reset),
    MOCK_AI_SUMMARY: 'false',
    IMPORT_RATE_LIMIT: '1000',
    RESEARCH_EXPERIMENTS_ENABLED: 'false',
    AI_PROVIDER: 'disabled',
    API_KEY: '',
    ANTHROPIC_API_KEY: '',
    GEMINI_API_KEY: '',
  };
  delete env.NODE_OPTIONS;
  return spawn(process.execPath, [
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    'scripts/start_e2e_server.ts',
  ], { cwd: root, env, stdio: 'ignore', windowsHide: true });
}

async function waitForHealthy(child: ChildProcess, baseUrl: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  let lastError = 'health check has not run';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Isolated E2E server exited (${child.exitCode ?? child.signalCode}): ${lastError}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = `healthz returned ${response.status}`;
    } catch (error) { lastError = String(error); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Isolated E2E server did not become healthy: ${lastError}`);
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  if (!child.killed) child.kill();
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10_000))]);
  if (child.exitCode === null && child.signalCode === null) throw new Error('Isolated E2E server did not stop');
}

async function jsonRequest<T>(baseUrl: string, route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, init);
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${route} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function selectText(page: Page, locator: string, text: string): Promise<void> {
  await page.locator(locator).evaluate((element: HTMLTextAreaElement, value: string) => {
    const at = element.value.indexOf(value);
    if (at < 0) throw new Error('Requested text was not present in the editor');
    element.focus();
    element.setSelectionRange(at, at + value.length);
  }, text);
}

test('saved-card quote and memo refinding plus integrated citations survive an actual server restart', async ({ page }) => {
  const isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'my-search-integrated-restart-'));
  const dbPath = path.join(isolatedDir, 'isolated.db');
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server = launchServer(port, dbPath, true);
  try {
    await waitForHealthy(server, baseUrl);
    const suffix = stamp();
    const sourceTitle = `再起動統合試験の保存資料 ${suffix}`;
    const quote = 'この保存資料の引用文は再起動後も元の出典位置を保ちます。';
    const memoryNote = 'メモ: 出典位置を保ったまま、再起動後に内容から探し直す。';
    const saved = await jsonRequest<{ card: { id: string; title: string } }>(baseUrl, '/api/reader/save', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: sourceTitle,
        url: `https://example.test/restart-${suffix}`,
        fetchedAt: new Date().toISOString(),
        paragraphs: [quote], memo: '', tags: [],
      }),
    });
    const workspaceResult = await jsonRequest<{ workspace: { id: string; name: string } }>(baseUrl, '/api/workspaces', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `再起動後も続く調査 ${suffix}`, purpose: '引用と原稿を再開する' }),
    });
    await jsonRequest(baseUrl, `/api/workspaces/${workspaceResult.workspace.id}/sources`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cardId: saved.card.id }),
    });

    await page.goto(baseUrl);
    await page.locator('.card', { hasText: sourceTitle }).click();
    await expect(page.locator('#modal-reader')).toHaveClass(/active/);
    await page.locator('#reader-article [data-index="0"]').evaluate((element: Element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    await page.getByRole('button', { name: '選択を引用' }).click();
    expect(await page.locator('#reader-memo').inputValue()).toContain(quote);
    await page.locator('#reader-memo').fill(`${await page.locator('#reader-memo').inputValue()}\n\n${memoryNote}`);
    await page.locator('#reader-save-btn').click();
    await expect(page.locator('#modal-reader')).not.toHaveClass(/active/);

    await page.locator('button[onclick="switchView(\'bm25\')"]').click();
    const initialCardsTarget = page.locator('#search-targets input[value="cards"]');
    if (!(await initialCardsTarget.isChecked())) await initialCardsTarget.check();
    await page.locator('#search-terms').fill('出典位置 再起動 内容から探し直す');
    await page.locator('#bm25-run-btn').click();
    const initialRefound = page.locator('#search-cards .score-card', { hasText: sourceTitle }).first();
    await expect(initialRefound).toBeVisible();
    await initialRefound.getByRole('button', { name: 'メモを読む' }).click();
    const initialMemo = await page.locator('#reader-memo').inputValue();
    expect(initialMemo).toContain(memoryNote);
    expect(initialMemo).toContain(quote);
    await page.locator('#modal-reader').getByRole('button', { name: '閉じる' }).click();

    await page.locator('button[data-view="investigations"]').click();
    await page.getByRole('button', { name: workspaceResult.workspace.name, exact: true }).click();
    await page.locator('[data-context-action="documents"]').click();
    await page.getByRole('button', { name: '＋ 新しい原稿' }).click();
    const title = `サーバー再起動後に復旧する調査原稿 ${suffix}`;
    const editor = page.locator('#document-markdown');
    await page.locator('#document-title').fill(title);
    await editor.fill(`## 出典確認\n\n${sourceTitle}\n`);
    await page.locator('#document-source-search').fill(sourceTitle);
    await page.locator('#research-writing-view .document-source-search').getByRole('button', { name: '検索', exact: true }).click();
    await page.locator('#document-source-results .document-source-row', { hasText: sourceTitle })
      .getByRole('button', { name: '資料に追加' }).click();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('#document-save-state')).toContainText('保存済み');
    await expect(page.locator('#investigation-documents')).toContainText(title);
    await selectText(page, '#document-markdown', sourceTitle);
    await page.getByRole('button', { name: '選択文から検索' }).click();
    await expect(page.locator('#search-terms')).toHaveValue(sourceTitle);
    const documentSearchCardsTarget = page.locator('#search-targets input[value="cards"]');
    if (!(await documentSearchCardsTarget.isChecked())) await documentSearchCardsTarget.check();
    await page.locator('#bm25-run-btn').click();
    await page.locator('#search-cards .score-card', { hasText: sourceTitle }).first()
      .getByRole('button', { name: 'メモを読む' }).click();
    const citationArticle = page.locator('#reader-article [data-index="0"]');
    await expect(citationArticle).toContainText(quote);
    await page.locator('#modal-reader').getByRole('button', { name: '閉じる' }).click();

    const listed = await jsonRequest<{ documents: Array<{ id: string; title: string }> }>(baseUrl, `/api/documents?q=${encodeURIComponent(title)}`);
    const documentId = listed.documents.find(document => document.title === title)?.id;
    expect(documentId).toBeTruthy();
    const current = await jsonRequest<{ document: { markdown: string; version: number } }>(baseUrl, `/api/documents/${documentId}`);
    const before = await jsonRequest<{ document: { markdown: string; citations: Array<{ id: string; verification: string; paragraphIndex: number }> } }>(baseUrl, `/api/documents/${documentId}/citations`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceCardId: saved.card.id,
        paragraphIndex: 0,
        quote,
        title,
        markdown: current.document.markdown,
        version: current.document.version,
        insertAt: current.document.markdown.length,
      }),
    });
    expect(before.document.citations).toHaveLength(1);
    expect(before.document.citations[0]).toMatchObject({ verification: 'verified', paragraphIndex: 0 });

    const thought = await jsonRequest<{ thought: { id: string; version: number } }>(baseUrl, '/api/thought-notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `再起動後も残る思考 ${suffix}`, body: '原文を確認してから根拠として使う。', kind: 'hypothesis' }),
    });
    const otherThought = await jsonRequest<{ thought: { id: string } }>(baseUrl, '/api/thought-notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `比較する思考 ${suffix}`, body: '条件をそろえて引用元を確認する。', kind: 'free' }),
    });
    await jsonRequest(baseUrl, `/api/workspaces/${workspaceResult.workspace.id}/thought-notes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ thoughtNoteId: thought.thought.id }),
    });
    await jsonRequest(baseUrl, `/api/workspaces/${workspaceResult.workspace.id}/thought-notes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ thoughtNoteId: otherThought.thought.id }),
    });
    const thoughtGroup = await jsonRequest<{ groupId: string }>(baseUrl, `/api/workspaces/${workspaceResult.workspace.id}/groups`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '確認待ち', position: 0 }),
    });
    await jsonRequest(baseUrl, `/api/workspaces/${workspaceResult.workspace.id}/thought-notes/${thought.thought.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ groupId: thoughtGroup.groupId, position: 4, x: 220, y: 140 }),
    });
    await jsonRequest(baseUrl, `/api/thought-notes/${thought.thought.id}/references`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceCardId: saved.card.id, quote }),
    });
    await jsonRequest(baseUrl, `/api/workspaces/${workspaceResult.workspace.id}/thought-links`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceThoughtId: thought.thought.id, targetThoughtId: otherThought.thought.id, description: '同じ引用元を確認する' }),
    });
    await jsonRequest(baseUrl, `/api/documents/${documentId}/thought-notes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ thoughtNoteId: thought.thought.id }),
    });
    await jsonRequest(baseUrl, `/api/workspaces/${workspaceResult.workspace.id}/state`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: { lastView: 'thoughts', thoughtNoteId: thought.thought.id, thoughtCompare: { noteIds: [thought.thought.id, otherThought.thought.id], criteria: ['主張'], values: {} } } }),
    });
    await jsonRequest(baseUrl, `/api/thought-notes/${thought.thought.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: `再起動後も残る思考 ${suffix}`, body: '更新後も旧版を履歴に残す。原文を確認してから根拠として使う。', kind: 'hypothesis', version: thought.thought.version }),
    });

    await stopServer(server);
    server = launchServer(port, dbPath, false);
    await waitForHealthy(server, baseUrl);

    await page.reload();
    await page.locator('button[data-view="investigations"]').click();
    await expect(page.locator('#investigation-workspace-list')).toContainText(workspaceResult.workspace.name);
    await page.getByRole('button', { name: workspaceResult.workspace.name, exact: true }).click();
    const reopenedThoughts = await jsonRequest<{ workspace: { thoughts: Array<{ id: string; groupId: string | null; position: number; x: number; y: number; references: Array<{ verification: string; paragraphIndex: number }> }>; thoughtLinks: Array<{ description: string }> } }>(baseUrl, `/api/workspaces/${workspaceResult.workspace.id}`);
    expect(reopenedThoughts.workspace.thoughts.find(row => row.id === thought.thought.id)).toMatchObject({ groupId: thoughtGroup.groupId, position: 4, x: 220, y: 140, references: [{ verification: 'verified', paragraphIndex: 0 }] });
    expect(reopenedThoughts.workspace.thoughtLinks).toMatchObject([{ description: '同じ引用元を確認する' }]);
    const reopenedRevisions = await jsonRequest<{ revisions: Array<{ version: number; body: string }> }>(baseUrl, `/api/thought-notes/${thought.thought.id}/revisions`);
    expect(reopenedRevisions.revisions).toMatchObject([{ version: 1, body: '原文を確認してから根拠として使う。' }]);
    const reopenedDocument = await jsonRequest<{ document: { thoughtNotes: Array<{ id: string }> } }>(baseUrl, `/api/documents/${documentId}`);
    expect(reopenedDocument.document.thoughtNotes.map(row => row.id)).toContain(thought.thought.id);
    await page.locator('[data-context-action="thoughts"]').click();
    await page.locator('#investigation-thought-search').fill(`再起動後も残る思考 ${suffix}`);
    await page.locator('.thought-search-row').getByRole('button', { name: 'メモを検索', exact: true }).click();
    await page.locator('#investigation-thought-list').getByRole('button', { name: new RegExp(`思考メモを開く: 再起動後も残る思考 ${suffix}`) }).click();
    await expect(page.locator('#thought-edit-body')).toHaveValue(/更新後も旧版を履歴に残す/);
    await page.locator('[data-context-action="documents"]').click();
    await expect(page.locator('#document-title')).toHaveValue(title);
    await page.locator('#document-search').fill(title);
    await page.locator('#document-list .document-list-item', { hasText: title }).click();
    await expect(editor).toHaveValue(/\[\[citation:/);
    await expect(page.locator('#document-citations')).toContainText('verified');
    await page.getByRole('button', { name: 'Readerで引用元へ' }).click();
    await expect(page.locator('#modal-reader')).toHaveClass(/active/);
    await expect(page.locator('#reader-article [data-index="0"]')).toContainText(quote);
    expect(await page.locator('#reader-memo').inputValue()).toContain(memoryNote);
    await page.locator('#modal-reader').getByRole('button', { name: '閉じる' }).click();

    await page.locator('button[onclick="switchView(\'bm25\')"]').click();
    const reFindCardsTarget = page.locator('#search-targets input[value="cards"]');
    if (!(await reFindCardsTarget.isChecked())) await reFindCardsTarget.check();
    await page.locator('#search-terms').fill('出典位置 再起動 内容から探し直す');
    await page.locator('#bm25-run-btn').click();
    const refound = page.locator('#search-cards .score-card', { hasText: sourceTitle }).first();
    await expect(refound).toBeVisible();
    await refound.getByRole('button', { name: 'メモを読む' }).click();
    const refoundMemo = await page.locator('#reader-memo').inputValue();
    expect(refoundMemo).toContain(memoryNote);
    expect(refoundMemo).toContain(quote);

    const after = await jsonRequest<{ document: { citations: Array<{ id: string; verification: string }> } }>(baseUrl, `/api/documents/${documentId}`);
    expect(after.document.citations).toMatchObject([{ id: before.document.citations[0]!.id, verification: 'verified' }]);
    const exported = await fetch(`${baseUrl}/api/documents/${documentId}/export.md`).then(response => response.text());
    expect(exported).toContain(quote);
    expect(exported).toContain(saved.card.id);
    const backlinks = await jsonRequest<{ documents: Array<{ id: string; citation_id: string | null }> }>(baseUrl, `/api/reader/cards/${saved.card.id}/documents`);
    expect(backlinks.documents.some(row => row.id === documentId && row.citation_id === before.document.citations[0]!.id)).toBe(true);
  } finally {
    if (server.exitCode === null && server.signalCode === null) await stopServer(server);
    // Retry removal recursively: Node only applies maxRetries for recursive rm.
    // Windows may briefly retain SQLite handles after the child server exits.
    await fs.rm(isolatedDir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  }
});
