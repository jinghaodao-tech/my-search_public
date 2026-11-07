import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

declare const api: { get(path: string): Promise<unknown> };

type Card = {
  id: string;
  title: string;
  body: string;
  tags: string[];
};

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function createCard(request: APIRequestContext, title: string, body: string, tags: string[] = []): Promise<Card> {
  const response = await request.post("/api/cards", {
    data: { title, body, tags, type: "memo" },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function openApp(page: Page) {
  await page.goto("/");
  await expect(page.locator("#card-grid")).toBeVisible();
}

async function releaseFixtureCard(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/candidates/${id}`);
  if (!response.ok()) return;
  const candidate = await response.json();
  if (candidate.savedCardId) expect((await request.delete(`/api/cards/${candidate.savedCardId}`)).ok()).toBeTruthy();
}

async function createCardViaUi(page: Page, title: string, body: string, tags = "e2e") {
  await openApp(page);
  await page.locator('button[onclick="openNewCardModal()"]').first().click();
  await expect(page.locator("#modal-reader")).toHaveClass(/active/);
  await expect(page.locator("#modal-reader .reader-modal")).toHaveClass(/reader-plain-mode/);
  await page.locator("#reader-edit-title").fill(title);
  await page.locator("#reader-memo").fill(body);
  await page.locator("#reader-tags").fill(tags);
  await page.locator("#reader-save-btn").click();
  await expect(page.locator("#modal-reader")).not.toHaveClass(/active/);
  await expect(page.locator("#card-grid")).toContainText(title);
}

test.describe("core user flows", () => {
  test("creates a card from the browser UI", async ({ page }) => {
    const title = `E2E create ${stamp()}`;
    await createCardViaUi(page, title, "Created from Playwright");
  });

  test("runs BM25 search from the browser UI", async ({ page, request }) => {
    const id = stamp();
    const targetTitle = `E2E BM25 target ${id}`;
    const noiseTitle = `E2E BM25 noise ${id}`;
    await createCard(request, targetTitle, "search implementation BM25 e2e-target", ["search", "implementation"]);
    await createCard(request, noiseTitle, "unrelated noise", ["noise"]);

    await openApp(page);
    await page.locator(`button[onclick="switchView('bm25')"]`).click();
    // search only the user's own cards
    await expect(page.locator('#search-targets input[value="cards"]')).toBeAttached();
    // sources without articles sit in a folded group: clear every box, folded or not
    await page.evaluate(() => { for (const box of document.querySelectorAll<HTMLInputElement>('#search-targets input[type=checkbox]')) box.checked = false; });
    await page.locator('#search-targets input[value="cards"]').check();
    await page.locator("#search-terms").fill("search");
    await page.evaluate(() => {
      // @ts-expect-error Browser globals from the app.
      bm25Keywords = [{ term: "search", weight: 2, synonyms: "implementation" }];
      // @ts-expect-error Browser globals from the app.
      bm25Params.arch = -1;
      // @ts-expect-error Browser globals from the app.
      bm25Params.limit = 10;
      // @ts-expect-error Browser globals from the app.
      renderKeywords();
    });
    const savedCardSearch = page.waitForResponse(response =>
      response.url().includes("/api/cards/search") && response.request().method() === "POST",
    );
    await page.locator("#bm25-run-btn").click();
    const savedCardResponse = await savedCardSearch;
    expect(savedCardResponse.ok()).toBeTruthy();
    const savedCardSearchBody = await savedCardResponse.json();
    const expectedSearchMethod = process.env.E2E_CARD_SEARCH_ENGINE === "fts5-raw"
      ? "fts5-raw-saved-cards"
      : process.env.E2E_CARD_SEARCH_ENGINE === "fts5-morph"
        ? "fts5-morph-saved-cards"
        : "fts5-rrf-saved-cards";
    expect(savedCardSearchBody.scope.searchMethod).toBe(expectedSearchMethod);
    expect(savedCardSearchBody.active[0]?.scoreSources?.method).toBe(
      process.env.E2E_CARD_SEARCH_ENGINE === "fts5-raw" ? "sqlite-fts5-raw-bm25"
        : process.env.E2E_CARD_SEARCH_ENGINE === "fts5-morph" ? "sqlite-fts5-morphological-bm25" : "sqlite-fts5-rrf",
    );
    const resultBody = page.locator("#bm25-result-body");
    await expect(resultBody).toContainText(targetTitle);
    await expect(resultBody.locator(".score-card").first()).toContainText(targetTitle);
  });

  test("keeps distinct FAQ cards in saved-card search unless deduplication is selected", async ({ page, request }) => {
    const title = `E2E origin rule ${stamp()}`;
    await createCard(request, title, "購入した材料・部品についても、輸出する産品と同様、当該材料・部品に適用される原産地規則を満たしていれば原産品として扱うことができます。");
    await createCard(request, title, "自社で内製した材料・部品についても、輸出する産品と同様、当該材料・部品に適用される原産地規則を満たしていれば原産品として扱うことができます。");

    await openApp(page);
    await page.locator(`button[onclick="switchView('bm25')"]`).click();
    await expect(page.locator('#search-targets input[value="cards"]')).toBeAttached();
    await page.evaluate(() => { for (const box of document.querySelectorAll<HTMLInputElement>('#search-targets input[type=checkbox]')) box.checked = false; });
    await page.locator('#search-targets input[value="cards"]').check();
    await page.locator('#search-terms').fill('購入 材料 部品 原産');
    await page.evaluate(() => {
      // @ts-expect-error Browser globals from the app.
      bm25Keywords = ['購入', '材料', '部品', '原産'].map(term => ({ term, weight: 1, synonyms: '' }));
      // @ts-expect-error Browser globals from the app.
      bm25Params.arch = -1;
      // @ts-expect-error Browser globals from the app.
      bm25Params.limit = 10;
      // @ts-expect-error Browser globals from the app.
      renderKeywords();
    });

    const japaneseSearch = page.waitForResponse(response =>
      response.url().includes("/api/cards/search") && response.request().method() === "POST",
    );
    await page.locator('#bm25-run-btn').click();
    const japaneseSearchBody = await (await japaneseSearch).json();
    if (process.env.E2E_CARD_SEARCH_ENGINE === "fts5-raw") {
      expect(japaneseSearchBody.scope.searchMethod).toBe("fts5-raw-fallback-rrf-saved-cards");
      expect(japaneseSearchBody.scope.fallbackUsed).toBe(true);
    } else if (process.env.E2E_CARD_SEARCH_ENGINE === "fts5-morph") {
      expect(japaneseSearchBody.scope.searchMethod).toBe("fts5-morph-saved-cards");
      expect(japaneseSearchBody.scope.fallbackUsed).toBe(false);
    }
    const results = page.locator('#bm25-result-body .score-card');
    await expect(results).toHaveCount(2);

    await page.evaluate(() => {
      // @ts-expect-error Browser globals from the app.
      bm25Params.dedup = 0.8;
    });
    await page.locator('#bm25-run-btn').click();
    await expect(results).toHaveCount(1);
  });

  test("archives and restores a card through the list UI", async ({ page, request }) => {
    const title = `E2E archive ${stamp()}`;
    await createCard(request, title, "Archive restore flow");

    await openApp(page);
    await expect(page.locator("#card-grid")).toContainText(title);
    await page.locator("#multi-select-btn").click();
    await page.locator(".card", { hasText: title }).click();
    await page.locator("#bulk-archive-btn").click();
    await expect(page.locator("#card-grid")).not.toContainText(title);

    await page.locator("#archive-filter-btn").click();
    await expect(page.locator("#card-grid")).toContainText(title);
    await page.locator("#multi-select-btn").click();
    await page.locator(".card", { hasText: title }).click();
    await page.locator("#bulk-restore-btn").click();
    await expect(page.locator("#card-grid")).not.toContainText(title);

    await page.locator("#normal-filter-btn").click();
    await expect(page.locator("#card-grid")).toContainText(title);
  });

  test("shows KJ group assignment and supports group rename/delete", async ({ page, request }) => {
    const id = stamp();
    const card = await createCard(request, `E2E KJ card ${id}`, "KJ board flow");
    const groupName = `E2E Group ${id}`;
    const updatedName = `E2E Group Updated ${id}`;

    await openApp(page);
    await page.locator("#topbar .tab-group .topbar-more summary").click();
    await page.getByRole("button", { name: "グルーピングボード" }).click();
    await page.getByRole("button", { name: "グループ追加" }).click();
    await page.locator("#group-name").fill(groupName);
    await page.locator("#modal-group .btn-primary").click();
    await expect(page.locator("#kj-canvas")).toContainText(groupName);

    const groupsResponse = await request.get("/api/kj/groups");
    const groups = await groupsResponse.json();
    const group = groups.groups.find((item: { name: string }) => item.name === groupName);
    expect(group?.id).toBeTruthy();
    await request.post(`/api/kj/groups/${group.id}/cards`, { data: { cardId: card.id } });
    await page.reload();
    await page.locator("#topbar .tab-group .topbar-more summary").click();
    await page.getByRole("button", { name: "グルーピングボード" }).click();
    await expect(page.locator("#kj-canvas")).toContainText(card.title);

    page.once("dialog", dialog => dialog.accept(updatedName));
    await page.locator(".kj-group-col", { hasText: groupName }).locator("button").first().click();
    await expect(page.locator("#kj-canvas")).toContainText(updatedName);

    page.once("dialog", dialog => dialog.accept());
    await page.locator(".kj-group-col", { hasText: updatedName }).locator("button").nth(1).click();
    await expect(page.locator("#kj-canvas")).not.toContainText(updatedName);
  });

  test("adds a Zettelkasten link and shows the backlink", async ({ page, request }) => {
    const id = stamp();
    const source = await createCard(request, `E2E Link A ${id}`, "Source card");
    const target = await createCard(request, `E2E Link B ${id}`, "Target card");

    await openApp(page);
    await page.locator(".card").filter({ has: page.locator(".card-title").getByText(source.title, { exact: true }) }).click();
    await page.locator("#link-search").fill(target.title);
    await page.locator(".link-candidate", { hasText: target.title }).click();
    await expect(page.locator("#detail-body")).toContainText(target.title);

    await page.locator(".card").filter({ has: page.locator(".card-title").getByText(target.title, { exact: true }) }).click();
    await expect(page.locator("#detail-body")).toContainText(source.title);

    await request.delete(`/api/cards/${source.id}/links/${target.id}`);
    await page.reload();
    await page.locator(".card").filter({ has: page.locator(".card-title").getByText(target.title, { exact: true }) }).click();
    await expect(page.locator("#detail-body")).not.toContainText(source.title);
  });
  test("reviews and saves a collected candidate from the browser UI", async ({ page, request }) => {
    const collected = await request.post("/api/collect", { data: { fixture: "portfolio-demo" } });
    expect(collected.ok()).toBeTruthy();
    await releaseFixtureCard(request, 'fixture-portfolio-search');
    await openApp(page);
    await page.locator('button[onclick="switchView(\'candidates\')"]').click();
    await expect(page.locator("#candidate-grid")).toContainText("Portfolio search architecture");
    const candidate = page.locator("#candidate-grid .candidate-card", { hasText: "Portfolio search architecture" });
    const review = candidate.getByRole('button', { name: 'レビュー済み', exact: true });
    if (await review.count()) { await review.click(); await expect(candidate).toContainText('確認済み'); }
    await candidate.getByRole('button', { name: 'カードに保存', exact: true }).click();
    await expect(candidate).toContainText("保存済み");
  });
});test("completes the candidate-to-knowledge workflow", async ({ page, request }) => {
  const collected = await request.post("/api/collect", { data: { fixture: "portfolio-demo" } });
  expect(collected.ok()).toBeTruthy();
  await releaseFixtureCard(request, 'fixture-portfolio-ops');
  const title = "Portfolio operations and verification";
  await openApp(page);
  await page.locator('button[onclick="switchView(\'candidates\')"]').click();
  const candidate = page.locator("#candidate-grid .candidate-card", { hasText: title });
  await expect(candidate).toBeVisible();
  const review = candidate.getByRole('button', { name: 'レビュー済み', exact: true });
  if (await review.count()) await review.click();
  await expect(candidate).toContainText("確認済み");
  const saveResponse = page.waitForResponse(response =>
    response.url().includes("/api/candidates/fixture-portfolio-ops/save") && response.request().method() === "POST",
  );
  await candidate.getByRole('button', { name: 'カードに保存', exact: true }).click();
  const saved = await saveResponse;
  expect(saved.status()).toBe(201);
  await expect(candidate).toContainText("保存済み");
  await page.locator('button[onclick="switchView(\'cards\')"]').click();
  await page.locator("#search-input").fill(title);
  await expect(page.locator("#card-grid")).toContainText(title);
  const cardsResponse = await request.get("/api/cards?q=" + encodeURIComponent(title));
  const cards = await cardsResponse.json();
  const card = cards.find((item: { title: string }) => item.title === title);
  expect(card?.id).toBeTruthy();
  const exportResponse = await request.get("/api/cards/" + card.id + "/export-md");
  expect(exportResponse.ok()).toBeTruthy();
  expect(await exportResponse.text()).toContain(title);
});
test("returns stable errors for invalid candidate and search operations", async ({ request }) => {
  const collected = await request.post("/api/collect", { data: { fixture: "portfolio-demo" } });
  expect(collected.ok()).toBeTruthy();
  await releaseFixtureCard(request, 'fixture-portfolio-design');

  const firstSave = await request.post("/api/candidates/fixture-portfolio-design/save");
  const secondSave = await request.post("/api/candidates/fixture-portfolio-design/save");
  expect(firstSave.status()).toBe(201);
  expect(secondSave.status()).toBe(409);
  expect((await secondSave.json()).code).toBe("candidate_already_saved");

  const invalidSearch = await request.post("/api/run", {
    data: {
      config: { k1: -1, b: 2, lambda: 0, contextBonus: 1, keywords: [] },
      articles: [],
    },
  });
  expect(invalidSearch.status()).toBe(400);
  expect((await invalidSearch.json()).code).toBe("validation_failed");

  const missingExport = await request.get("/api/cards/missing-card/export-md");
  expect(missingExport.status()).toBe(404);
  expect((await missingExport.json()).code).toBe("card_not_found");
});

test("shows API request details when a browser request fails", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    window.setTimeout(() => void api.get("/api/cards/missing-card/export-md"), 0);
  });
  await expect(page.locator("#toast")).toContainText("card_not_found");
  await expect(page.locator("#toast")).toContainText("requestId:");
});
