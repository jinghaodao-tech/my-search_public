import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

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

async function createCardViaUi(page: Page, title: string, body: string, tags = "e2e") {
  await openApp(page);
  await page.locator('button[onclick="openNewCardModal()"]').first().click();
  await expect(page.locator("#modal-new")).toHaveClass(/active/);
  await page.locator("#new-title").fill(title);
  await page.locator("#new-body").fill(body);
  await page.locator("#new-tags").fill(tags);
  await page.locator("#modal-new .btn-primary").click();
  await expect(page.locator("#modal-new")).not.toHaveClass(/active/);
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
    await page.getByRole("button", { name: /BM25/ }).click();
    await page.locator('input[name="bm25src"][value="cards"]').check();
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
    await page.locator("#bm25-run-btn").click();
    const resultBody = page.locator("#bm25-result-body");
    await expect(resultBody).toContainText(targetTitle);
    await expect(resultBody.locator(".score-card").first()).toContainText(targetTitle);
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
    await page.locator(".card", { hasText: source.title }).click();
    await page.locator("#link-search").fill(target.title);
    await page.locator(".link-candidate", { hasText: target.title }).click();
    await expect(page.locator("#detail-body")).toContainText(target.title);

    await page.locator(".card", { hasText: target.title }).click();
    await expect(page.locator("#detail-body")).toContainText(source.title);

    await request.delete(`/api/cards/${source.id}/links/${target.id}`);
    await page.reload();
    await page.locator(".card", { hasText: target.title }).click();
    await expect(page.locator("#detail-body")).not.toContainText(source.title);
  });
  test("reviews and saves a collected candidate from the browser UI", async ({ page }) => {
    const Database = (await import("better-sqlite3")).default;
    const candidateId = `e2e-candidate-${stamp()}`;
    const db = new Database("data/e2e-test.db");
    db.prepare(`INSERT INTO articles (id, title, body, url, source, source_authority, published_at, summary, tags_json, tokens_json, doc_length, content_hash, created_at, updated_at, last_fetched_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(candidateId, "E2E candidate article", "Candidate review body", `https://example.test/${candidateId}`, "rss:e2e", 0.8, new Date().toISOString(), "Candidate summary", "[]", "[]", 0, "e2e", new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    db.close();
    try {
      await openApp(page);
      await page.getByRole("button", { name: "候補レビュー" }).click();
      await expect(page.locator("#candidate-grid")).toContainText("E2E candidate article");
      await page.locator("#candidate-grid .candidate-card").getByRole("button", { name: "レビュー済み" }).click();
      await expect(page.locator("#candidate-grid")).toContainText("確認済み・未保存");
      await page.locator("#candidate-grid .candidate-card").getByRole("button", { name: "カードに保存" }).click();
      await expect(page.locator("#candidate-grid")).toContainText("保存済み");
    } finally {
      const cleanup = new Database("data/e2e-test.db");
      cleanup.prepare("DELETE FROM articles WHERE id = ?").run(candidateId);
      cleanup.prepare("DELETE FROM cards WHERE url = ?").run(`https://example.test/${candidateId}`);
      cleanup.close();
    }
  });
});
test("completes the candidate-to-knowledge workflow", async ({ page, request }) => {
  const Database = (await import("better-sqlite3")).default;
  const id = `e2e-workflow-${stamp()}`;
  const title = `E2E workflow ${id}`;
  const now = new Date().toISOString();
  const db = new Database("data/e2e-test.db");
  db.prepare(`INSERT INTO articles (id, title, body, url, source, source_authority, published_at, summary, tags_json, tokens_json, doc_length, content_hash, created_at, updated_at, last_fetched_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, title, "Collected workflow body", `https://example.test/${id}`, "fixture", 0.9, now, "Collected workflow summary", "[]", "[]", 0, id, now, now, now, now);
  db.close();
  try {
    await openApp(page);
    await page.locator('button[onclick="switchView(\'candidates\')"]').click();
    await expect(page.locator("#candidate-grid")).toContainText(title);
    const candidate = page.locator("#candidate-grid .candidate-card", { hasText: title });
    await candidate.getByRole("button", { name: /レビュー/ }).click();
    await candidate.getByRole("button", { name: /カードに保存/ }).click();
    await page.locator('button[onclick="switchView(\'cards\')"]').click();
    await page.locator("#search-input").fill(title);
    await expect(page.locator("#card-grid")).toContainText(title);
    await page.locator(".card", { hasText: title }).click();
    await page.locator("#tag-add-input").fill("workflow");
    await page.locator("#tag-add-input").press("Enter");
    await expect(page.locator("#detail-body")).toContainText("workflow");
    const cardsResponse = await request.get(`/api/cards?q=${encodeURIComponent(title)}`);
    const cards = await cardsResponse.json();
    const card = cards.find((item: { title: string }) => item.title === title);
    expect(card?.id).toBeTruthy();
    const exportResponse = await request.get(`/api/cards/${card.id}/export-md`);
    expect(exportResponse.ok()).toBeTruthy();
    expect(await exportResponse.text()).toContain(title);
  } finally {
    const cleanup = new Database("data/e2e-test.db");
    cleanup.prepare("DELETE FROM articles WHERE id = ?").run(id);
    cleanup.prepare("DELETE FROM cards WHERE url = ?").run(`https://example.test/${id}`);
    cleanup.close();
  }
});