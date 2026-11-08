import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const screenshotDir = path.join(process.cwd(), 'artifacts', 'ui-surface-audit');

async function openLibraryView(page: import('@playwright/test').Page, label: string) {
  const menu = page.locator('#topbar .topbar-library');
  await menu.locator('summary').click();
  await menu.getByRole('button', { name: label, exact: true }).click();
}

async function openGlobalCardViews(page: import('@playwright/test').Page) {
  const details = page.locator('#sidebar .global-card-views');
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) {
    await details.locator('summary').click();
  }
}

test('primary views and shared operational modals are reachable and consistent', async ({ page }) => {
  await mkdir(screenshotDir, { recursive: true });
  await page.goto('/');

  const surfaces = [
    { label: '保存済み', selector: '#card-grid' },
    { label: '候補レビュー', selector: '#candidate-view' },
    { label: '全カードのグルーピング', selector: '#kj-board' },
    { label: '全カードの関係図', selector: '#zettel-view' },
    { label: '探す', selector: '#bm25-view' },
  ];

  for (const surface of surfaces) {
    if (surface.label === '候補レビュー') {
      await openLibraryView(page, '収集した記事を確認');
    } else if (surface.label === '全カードのグルーピング' || surface.label === '全カードの関係図') {
      await openLibraryView(page, '記事・メモを管理');
      await openGlobalCardViews(page);
      await page.locator('#sidebar').getByRole('button', { name: surface.label, exact: true }).click();
    } else if (surface.label === '探す') {
      await page.getByRole('button', { name: '探す', exact: true }).click();
    } else {
      await openLibraryView(page, '記事・メモを管理');
    }
    await expect(page.locator(surface.selector)).toBeVisible();
    await page.screenshot({ path: path.join(screenshotDir, `${surface.label}.png`), fullPage: true });
  }

  await expect(page.locator('#topbar [data-view="writing"]')).toHaveCount(0);
  await expect(page.locator('#topbar > .tab-group > button[data-view="kj"]')).toHaveCount(0);
  await expect(page.locator('#topbar > .tab-group > button[data-view="zettel"]')).toHaveCount(0);
  await expect(page.locator('#tag-search')).toBeHidden();
  await expect(page.locator('#tag-cloud')).toBeHidden();
  await expect(page.getByText('タグを整理', { exact: true })).toBeHidden();

  await page.getByRole('button', { name: '探す', exact: true }).click();
  await page.locator('#bm25-config-body').getByRole('button', { name: '情報源を管理', exact: true }).click();
  await expect(page.locator('#source-modal')).toHaveClass(/active/);
  await page.locator('#source-modal').getByRole('button', { name: '閉じる', exact: true }).click();
  page.on('dialog', dialog => dialog.dismiss());
  await page.locator('#search-details > summary').evaluate(el => el.scrollIntoView({ block: 'center' }));
  await page.locator('#search-details > summary').click();
  await page.locator('#search-advanced summary').evaluate(el => el.scrollIntoView({ block: 'center' }));
  await page.locator('#search-advanced summary').click();
  await page.locator('button[onclick="addBM25Mode()"]').click();
  await expect(page.locator('#mode-manager-modal')).toHaveClass(/active/);
  await expect(page.locator('#new-mode-name')).toBeFocused();
  await page.locator('#new-mode-name').fill('UI audit mode');
  await page.locator('#mode-manager-modal').getByRole('button', { name: '追加', exact: true }).click();
  await expect(page.locator('#mode-tabs')).toContainText('UI audit mode');
  await expect(page.locator('#mode-manager-list .mode-edit-name').last()).toHaveValue('UI audit mode');
  await page.screenshot({ path: path.join(screenshotDir, '検索モード管理.png'), fullPage: true });
  await page.locator('#mode-manager-modal button[onclick="closeModal(\'mode-manager-modal\')"]').click();

  await openLibraryView(page, '記事・メモを管理');
  await openGlobalCardViews(page);
  await page.getByRole('button', { name: '全カードのグルーピング', exact: true }).click();
  await page.locator('#kj-board button[onclick="openNewGroupModal()"]').click();
  await expect(page.locator('#modal-group')).toHaveClass(/active/);
  await page.screenshot({ path: path.join(screenshotDir, 'グループ作成.png'), fullPage: true });
  await page.locator('#modal-group button[onclick="closeModal(\'modal-group\')"]').click();

  const admin = page.locator('#topbar details.topbar-admin');
  await admin.locator('summary').click();
  await admin.getByRole('button', { name: '情報源を管理' }).click();
  await expect(page.locator('#source-modal')).toHaveClass(/active/);
  await page.screenshot({ path: path.join(screenshotDir, '情報源管理.png'), fullPage: true });
  await page.locator('#source-modal button[onclick="closeModal(\'source-modal\')"]').click();

  await admin.locator('summary').click();
  await admin.getByRole('button', { name: 'データ取り込み' }).click();
  await expect(page.locator('#modal-csv')).toHaveClass(/active/);
  await page.screenshot({ path: path.join(screenshotDir, 'データ取り込み.png'), fullPage: true });
  await page.locator('#modal-csv button[onclick="closeModal(\'modal-csv\')"]').click();

  await admin.locator('summary').click();
  await admin.getByRole('button', { name: '状況別の補助機能' }).click();
  await expect(page.locator('#modal-contextual-settings')).toHaveClass(/active/);
  await page.screenshot({ path: path.join(screenshotDir, '状況別の補助機能.png'), fullPage: true });
  await page.locator('#modal-contextual-settings button[onclick="closeModal(\'modal-contextual-settings\')"]').last().click();

  await openLibraryView(page, '記事・メモを管理');
  await page.getByRole('button', { name: 'メモを作成', exact: true }).first().click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await page.locator('#modal-reader').getByRole('button', { name: '閉じる', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#fab-main').click();
  await page.getByRole('button', { name: 'メモを作成', exact: true }).last().click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await page.locator('#modal-reader').getByRole('button', { name: '閉じる', exact: true }).click();
  await page.locator('#fab-main').click();
  await page.getByRole('button', { name: 'データ取り込み', exact: true }).last().click();
  await expect(page.locator('#modal-csv')).toHaveClass(/active/);
  await page.locator('#modal-csv').getByRole('button', { name: 'キャンセル', exact: true }).click();

  await page.locator('button[data-view="bm25"]').click();
  await page.getByRole('button', { name: '読む・メモ', exact: true }).first().click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await page.screenshot({ path: path.join(screenshotDir, 'Reader.png'), fullPage: true });
  await page.locator('#modal-reader').getByRole('button', { name: '閉じる', exact: true }).click();
});
