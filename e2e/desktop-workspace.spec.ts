import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'node:path';

test('Electron separates remote pages, allows two HTTPS tabs, and refuses unsafe destinations', async () => {
  test.setTimeout(90_000);
  const app = await electron.launch({
    args: [path.resolve('desktop/main.mjs'), '--trial'],
    timeout: 60_000,
  });
  try {
    const main = await app.firstWindow();
    await main.waitForLoadState('domcontentloaded');
    await expect(main.locator('#desktop-browser-open')).toBeVisible();
    const initialContents = await app.evaluate(electronApi => (electronApi as any).webContents.getAllWebContents().map((contents: any) => contents.id));
    await main.evaluate(() => (window as any).mySearchDesktop.openBrowser('https://first.test.invalid/'));
    await expect.poll(() => app.windows().length).toBe(2);
    const browser = app.windows().find(window => window.url().startsWith('file:'))!;
    await expect(browser.locator('#tabs button[role="tab"]')).toHaveCount(1);
    await browser.evaluate(() => (window as any).desktopBrowser.openTab('https://second.test.invalid/'));
    await expect(browser.locator('#tabs button[role="tab"]')).toHaveCount(2);

    const unsafeResult = await browser.evaluate(async () => {
      try { await (window as any).desktopBrowser.navigate('http://127.0.0.1:3000/api/cards'); return 'allowed'; }
      catch (error) { return String((error as Error).message); }
    });
    expect(unsafeResult).toContain('HTTPS');

    const readRemotePages = () => app.evaluate(async (electronApi, knownIds) => {
      const candidates = (electronApi as any).webContents.getAllWebContents()
        .filter((candidate: any) => !knownIds.includes(candidate.id)
          && !candidate.getLastWebPreferences().preload
          && !candidate.getURL().startsWith('file:'));
      return Promise.all(candidates.map(async (candidate: any) => {
          const prefs = candidate.getLastWebPreferences();
          const globals = await candidate.executeJavaScript('JSON.stringify({process: typeof process, require: typeof require, electron: typeof window.mySearchDesktop})').catch(() => 'unavailable');
          return { preferences: { nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, webSecurity: prefs.webSecurity, preload: prefs.preload || null }, globals };
        }));
    }, initialContents);
    await expect.poll(() => readRemotePages().then(pages => pages.length)).toBe(2);
    const remotePages = await readRemotePages();
    for (const remote of remotePages) {
      expect(remote.preferences).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, preload: null });
      expect(remote.globals).toBe('{"process":"undefined","require":"undefined","electron":"undefined"}');
    }
  } finally {
    await app.close();
  }
});
