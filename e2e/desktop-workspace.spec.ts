import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'node:path';

test('Electron separates remote pages, allows two HTTPS tabs, and refuses unsafe destinations', async () => {
  // App startup and graceful shutdown include a real SQLite-backed server child;
  // allow slower hosted CI runners enough time after local measurements.
  test.setTimeout(180_000);
  const app = await electron.launch({
    args: [path.resolve('desktop/main.mjs'), '--trial'],
    timeout: 60_000,
  });
  try {
    const main = await app.firstWindow();
    await main.waitForLoadState('domcontentloaded');
    await expect(main.locator('#desktop-browser-open')).toBeVisible();
    const initialContents = await app.evaluate(electronApi => (electronApi as any).webContents.getAllWebContents().map((contents: any) => contents.id));
    // These are security-context probes only; a closed loopback port fails immediately
    // and keeps the test independent of public DNS and network availability.
    await main.evaluate(() => (window as any).mySearchDesktop.openBrowser('https://127.0.0.1:1/'));
    const browserWindowId = async () => app.evaluate((electronApi, mainId) => {
      const windows = (electronApi as any).BrowserWindow.getAllWindows();
      return windows.find((window: any) => window.webContents.id !== mainId)?.webContents.id ?? null;
    }, initialContents[0]);
    await expect.poll(browserWindowId).not.toBeNull();
    const browserId = await browserWindowId();
    const browserTabCount = () => app.evaluate(async (electronApi, id) => {
      const contents = (electronApi as any).webContents.fromId(id);
      if (!contents || contents.isDestroyed()) return -1;
      return contents.executeJavaScript("document.querySelectorAll('#tabs button[role=tab]').length").catch(() => -1);
    }, browserId);
    await expect.poll(browserTabCount).toBe(1);
    await app.evaluate(async (electronApi, id) => {
      const contents = (electronApi as any).webContents.fromId(id);
      await contents.executeJavaScript("window.desktopBrowser.openTab('https://127.0.0.1:1/')");
    }, browserId);
    await expect.poll(browserTabCount).toBe(2);

    const unsafeResult = await app.evaluate(async (electronApi, id) => {
      const contents = (electronApi as any).webContents.fromId(id);
      try { await contents.executeJavaScript("window.desktopBrowser.navigate('http://127.0.0.1:3000/api/cards')"); return 'allowed'; }
      catch (error) { return String((error as Error).message); }
    }, browserId);
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
