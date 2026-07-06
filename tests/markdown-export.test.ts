import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app, cardsEngine, resetCards } from "./helpers.js";

function binaryParser(res: NodeJS.ReadableStream, callback: (error: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  res.on("end", () => callback(null, Buffer.concat(chunks)));
  res.on("error", callback);
}

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
    const fallbackName = disposition.match(/filename="([^"]+)"/)?.[1] ?? "";

    expect(disposition).toContain("attachment;");
    expect(disposition).toContain(".md");
    expect(disposition).toContain("filename*=");
    expect(fallbackName).not.toContain("<");
    expect(fallbackName).not.toContain(">");
    expect(fallbackName).not.toContain(":");
    expect(fallbackName).not.toContain("/");
    expect(fallbackName).not.toContain("\\");
    expect(fallbackName).not.toContain("|");
    expect(fallbackName).not.toContain("*");
    expect(fallbackName).not.toContain("?");
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

  it("exports multiple cards as a zip of Markdown files", async () => {
    const first = await cardsEngine.createCard({
      title: "Bulk Export One",
      body: "first markdown body",
      tags: ["bulk"],
    });
    const second = await cardsEngine.createCard({
      title: "Bulk Export Two",
      body: "second markdown body",
      tags: ["bulk"],
    });

    const response = await request(app)
      .post("/api/cards/export-md-bulk")
      .buffer(true)
      .parse(binaryParser as any)
      .send({ ids: [first.id, second.id] });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
    expect(response.headers["content-disposition"]).toContain(".zip");
    expect(response.body.subarray(0, 4).toString("hex")).toBe("504b0304");
    const zipText = response.body.toString("utf8");
    expect(zipText).toContain("Bulk Export One.md");
    expect(zipText).toContain("# Bulk Export One");
    expect(zipText).toContain("first markdown body");
    expect(zipText).toContain("Bulk Export Two.md");
    expect(zipText).toContain("# Bulk Export Two");
    expect(zipText).toContain("second markdown body");
  });

  it("returns 404 when bulk Markdown export finds no cards", async () => {
    const response = await request(app)
      .post("/api/cards/export-md-bulk")
      .send({ ids: ["missing-card"] });

    expect(response.status).toBe(404);
  });
});