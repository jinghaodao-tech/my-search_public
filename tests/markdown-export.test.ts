import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app, cardsEngine, resetCards } from "./helpers.js";

describe("Markdown export", () => {
  beforeEach(() => {
    resetCards();
  });

  async function createExportCard(title = "Markdown Export Card") {
    const linked = await cardsEngine.createCard({
      title: "Linked card",
      body: "linked body",
    });
    const card = await cardsEngine.createCard({
      title,
      body: "Body text for markdown export.",
      summary: "Short summary.",
      tags: ["search", "sqlite", "bm25"],
      url: "https://example.test/card",
      links: [linked.id],
      type: "memo",
    });
    return { card, linked };
  }

  it("returns a card as Markdown", async () => {
    const { card } = await createExportCard();
    const response = await request(app).get(`/api/cards/${card.id}/export-md`);

    expect(response.status).toBe(200);
    expect(response.text).toContain("# Markdown Export Card");
    expect(response.text).toContain("Body text for markdown export.");
  });

  it("sets Markdown download headers", async () => {
    const { card } = await createExportCard();
    const response = await request(app).get(`/api/cards/${card.id}/export-md`);

    expect(response.headers["content-type"]).toContain("text/markdown");
    expect(response.headers["content-disposition"]).toContain("attachment;");
    expect(response.headers["content-disposition"]).toContain(".md");
  });

  it("includes summary, metadata, tags, URL, and links", async () => {
    const { card, linked } = await createExportCard();
    const response = await request(app).get(`/api/cards/${card.id}/export-md`);

    expect(response.text).toContain("## Summary");
    expect(response.text).toContain("Short summary.");
    expect(response.text).toContain("## Metadata");
    expect(response.text).toContain(`- ID: ${card.id}`);
    expect(response.text).toContain("- Type: memo");
    expect(response.text).toContain("- Tags: search, sqlite, bm25");
    expect(response.text).toContain("- URL: https://example.test/card");
    expect(response.text).toContain("## Links");
    expect(response.text).toContain(`- ${linked.id}`);
  });

  it("returns 404 for missing card IDs", async () => {
    const response = await request(app).get("/api/cards/missing-card/export-md");
    expect(response.status).toBe(404);
  });

  it("uses a safe filename for dangerous title characters", async () => {
    const { card } = await createExportCard('Bad <Title>: "Slash/Back\\Pipe|Star*Q?');
    const response = await request(app).get(`/api/cards/${card.id}/export-md`);
    const disposition = response.headers["content-disposition"];

    expect(disposition).toContain("attachment;");
    expect(disposition).toContain(".md");
    expect(disposition).not.toContain("<");
    expect(disposition).not.toContain(">");
    expect(disposition).not.toContain(":");
    expect(disposition).not.toContain("/");
    expect(disposition).not.toContain("\\");
    expect(disposition).not.toContain("|");
    expect(disposition).not.toContain("*");
    expect(disposition).not.toContain("?");
  });

  it("omits optional sections when summary, URL, and links are absent", async () => {
    const card = await cardsEngine.createCard({
      title: "Minimal card",
      body: "minimal body",
      tags: [],
    });
    const response = await request(app).get(`/api/cards/${card.id}/export-md`);

    expect(response.text).not.toContain("## Summary");
    expect(response.text).not.toContain("- URL:");
    expect(response.text).not.toContain("## Links");
    expect(response.text).toContain("- Tags: none");
  });
});
