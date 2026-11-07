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
  await page.locator('#investigation-source-query').fill(first.title);
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await page.locator('#investigation-source-results .document-source-row', { hasText: first.title }).getByRole('button', { name: '資料に追加' }).click();
  await page.locator('#investigation-source-query').fill(second.title);
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await page.locator('#investigation-source-results .document-source-row', { hasText: second.title }).getByRole('button', { name: '資料に追加' }).click();
  await expect(page.locator('#investigation-sources .investigation-source-row')).toHaveCount(2);

  await page.getByRole('button', { name: '整理', exact: true }).click();
  await page.locator('#investigation-group-name').fill('根拠候補');
  await page.getByRole('button', { name: '分類を追加' }).click();
  await page.getByRole('button', { name: 'ボード', exact: true }).click();
  await expect(page.locator('#investigation-groups')).toContainText(first.title);
  await expect(page.locator('#investigation-groups')).toContainText(second.title);
  const renamedGroup = '根拠候補（修正）';
  page.once('dialog', dialog => dialog.accept(renamedGroup));
  await page.locator('#investigation-groups .investigation-kanban-column', { hasText: '根拠候補' }).getByRole('button', { name: '名前変更' }).click();
  await expect(page.locator('#investigation-groups')).toContainText(renamedGroup);
  await page.getByRole('button', { name: '一覧', exact: true }).click();
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

  await page.getByRole('button', { name: '比較', exact: true }).click();
  await expect(page.locator('#investigation-compare-source-selection .investigation-compare-choice')).toHaveCount(2);
  await expect(page.locator('#investigation-compare-source-selection input[type="checkbox"]:checked')).toHaveCount(2);
  await page.locator('#investigation-compare-purpose').fill('SQLite 同時更新 永続化 競合条件');
  await page.getByRole('button', { name: '保存本文から根拠候補' }).click();
  await expect(page.locator('#investigation-evidence .document-evidence-row').first()).toBeVisible();
  await expect(page.locator('#investigation-evidence')).toContainText('語の一致');

  await page.getByRole('button', { name: '原稿', exact: true }).click();
  await page.locator('#investigation-document-select').selectOption(document.document.id);
  await page.getByRole('button', { name: '原稿を追加' }).click();
  await expect(page.locator('#investigation-documents')).toContainText(document.document.title);
  await expect(page.locator('#research-writing-view')).toBeVisible();
  const workspaceDraftTitle = `調査内原稿 ${suffix}`;
  await page.getByRole('button', { name: '＋ 新しい原稿' }).click();
  await page.locator('#document-title').fill(workspaceDraftTitle);
  await page.locator('#document-markdown').fill('この原稿は開いている調査に関連付けて保存される。');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#investigation-documents')).toContainText(workspaceDraftTitle);
  await page.locator('#investigation-search-select').selectOption(savedSearch.id);
  await page.getByRole('button', { name: '保存検索を追加' }).click();
  await expect(page.locator('#investigation-saved-searches')).toContainText(savedSearch.name);

  await page.getByRole('button', { name: '資料', exact: true }).click();
  await page.locator('#investigation-search-query').fill('SQLite 同時更新');
  await page.getByRole('button', { name: '保存記事を検索' }).click();
  await expect(page.locator('#investigation-search-results')).toContainText(first.title);
  await page.reload();
  await page.locator('button[data-view="investigations"]').click();
  await page.getByRole('button', { name: '資料', exact: true }).click();
  await expect(page.locator('#investigation-search-query')).toHaveValue('SQLite 同時更新');
  await expect(page.locator('#investigation-compare-purpose')).toHaveValue('SQLite 同時更新 永続化 競合条件');
  await expect(page.locator('#investigation-sources')).toContainText(first.title);
  await expect(page.locator('#investigation-documents')).toContainText(document.document.title);
  await expect(page.locator('#investigation-saved-searches')).toContainText(savedSearch.name);

  const screenshotDir = path.join(process.cwd(), 'artifacts', 'ui-investigation-integration');
  await mkdir(screenshotDir, { recursive: true });
  await page.getByRole('button', { name: '整理', exact: true }).click();
  await page.getByRole('button', { name: 'ボード', exact: true }).click();
  await page.screenshot({ path: path.join(screenshotDir, 'desktop-workspace-board.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '資料', exact: true }).click();
  await page.screenshot({ path: path.join(screenshotDir, 'mobile-workspace-materials.png'), fullPage: true });
  await expect(page.locator('#investigation-name')).toBeVisible();
  await expect(page.locator('#investigation-source-query')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '原稿', exact: true }).click();
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
  await page.getByRole('button', { name: '原稿', exact: true }).click();
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
