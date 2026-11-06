import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const screenshotDir = path.join(process.cwd(), 'artifacts', 'ui-surface-audit');

test('primary views and shared operational modals are reachable and consistent', async ({ page }) => {
  await mkdir(screenshotDir, { recursive: true });
  await page.goto('/');

  const surfaces = [
    { label: 'カード一覧', selector: '#card-grid' },
    { label: '候補レビュー', selector: '#candidate-view' },
    { label: 'グルーピングボード', selector: '#kj-board' },
    { label: 'Zettelkasten', selector: '#zettel-view' },
    { label: '探す', selector: '#bm25-view' },
  ];

  for (const surface of surfaces) {
    if (surface.label === 'グルーピングボード' || surface.label === 'Zettelkasten') {
      await page.locator('#topbar .tab-group > details.topbar-more').first().locator('summary').click();
    }
    await page.getByRole('button', { name: surface.label, exact: true }).click();
    await expect(page.locator(surface.selector)).toBeVisible();
    await page.screenshot({ path: path.join(screenshotDir, `${surface.label}.png`), fullPage: true });
  }

  await page.getByRole('button', { name: '探す', exact: true }).click();
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

  await page.locator('#topbar .tab-group > details.topbar-more').first().locator('summary').click();
  await page.getByRole('button', { name: 'グルーピングボード', exact: true }).click();
  await page.locator('#kj-board button[onclick="openNewGroupModal()"]').click();
  await expect(page.locator('#modal-group')).toHaveClass(/active/);
  await page.screenshot({ path: path.join(screenshotDir, 'グループ作成.png'), fullPage: true });
  await page.locator('#modal-group button[onclick="closeModal(\'modal-group\')"]').click();

  const admin = page.locator('#topbar details.topbar-admin');
  await admin.locator('summary').click();
  await admin.getByRole('button', { name: 'ソース管理' }).click();
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

  await page.getByRole('button', { name: '読んでメモ', exact: true }).click();
  await expect(page.locator('#modal-reader')).toHaveClass(/active/);
  await page.screenshot({ path: path.join(screenshotDir, 'Reader.png'), fullPage: true });
  await page.locator('#modal-reader').getByRole('button', { name: '閉じる', exact: true }).click();
});
