import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, cardsEngine, database, resetCards } from "./helpers.js";

const db = database.db;

function cardTags(cardId: string) {
  return db.prepare("SELECT card_id, tag FROM card_tags WHERE card_id = ? ORDER BY rowid").all(cardId);
}

function cardLinks(sourceCardId: string) {
  return db.prepare("SELECT source_card_id, target_card_id FROM card_links WHERE source_card_id = ? ORDER BY rowid").all(sourceCardId);
}

describe("card workflows", () => {
  beforeEach(() => {
    resetCards();
  });

  it("creates, reads, updates, and deletes cards", async () => {
    const created = await cardsEngine.createCard({ title: "CRUD card", body: "initial body", tags: ["crud"] });
    expect(cardsEngine.getCard(created.id)?.title).toBe("CRUD card");

    const updated = await cardsEngine.updateCard(created.id, { title: "CRUD card updated" });
    expect(updated?.title).toBe("CRUD card updated");

    expect(cardsEngine.deleteCard(created.id)).toBe(true);
    expect(cardsEngine.getCard(created.id)).toBeNull();
  });

  it("archives and restores cards", async () => {
    const card = await cardsEngine.createCard({ title: "Archive card", body: "body" });
    cardsEngine.bulkArchiveCards([card.id]);
    expect(cardsEngine.getCard(card.id)?.archived).toBe(true);

    await cardsEngine.restoreCard(card.id);
    expect(Boolean(cardsEngine.getCard(card.id)?.archived)).toBe(false);
  });

  it("bulk archives multiple cards", async () => {
    const first = await cardsEngine.createCard({ title: "Bulk archive A", body: "body" });
    const second = await cardsEngine.createCard({ title: "Bulk archive B", body: "body" });
    const updated = cardsEngine.bulkArchiveCards([first.id, second.id]);

    expect(new Set(updated)).toEqual(new Set([first.id, second.id]));
    expect(cardsEngine.getCard(first.id)?.archived).toBe(true);
    expect(cardsEngine.getCard(second.id)?.archived).toBe(true);
  });

  it("bulk deletes cards and removes link references", async () => {
    const first = await cardsEngine.createCard({ title: "Bulk delete A", body: "body" });
    const second = await cardsEngine.createCard({ title: "Bulk delete B", body: "body" });
    const third = await cardsEngine.createCard({ title: "Bulk delete C", body: "body" });
    cardsEngine.linkCards(first.id, second.id);
    cardsEngine.linkCards(third.id, second.id);

    expect(cardsEngine.bulkDeleteCards([second.id])).toEqual([second.id]);
    expect(cardsEngine.getCard(second.id)).toBeNull();
    expect(cardsEngine.getCard(first.id)?.links).not.toContain(second.id);
    expect(cardsEngine.getCard(third.id)?.links).not.toContain(second.id);
  });

  it("adds, removes, and searches tags", async () => {
    const card = await cardsEngine.createCard({ title: "Tag card", body: "body", tags: ["alpha"] });
    expect(cardsEngine.getCards({ tag: "alpha" })).toHaveLength(1);

    await cardsEngine.updateCard(card.id, { tags: ["beta"] });
    expect(cardsEngine.getCards({ tag: "alpha" })).toHaveLength(0);
    expect(cardsEngine.getCards({ tag: "beta" })).toHaveLength(1);
    expect(cardsEngine.getCards({ q: "beta" })).toHaveLength(1);
  });

  it("stores tags in card_tags when cards are created", async () => {
    const card = await cardsEngine.createCard({ title: "Tag junction create", body: "body", tags: ["alpha", "beta"] });

    expect(cardTags(card.id)).toEqual([
      { card_id: card.id, tag: "alpha" },
      { card_id: card.id, tag: "beta" },
    ]);
  });

  it("replaces old tag relations when tags are updated", async () => {
    const card = await cardsEngine.createCard({ title: "Tag junction update", body: "body", tags: ["old"] });

    await cardsEngine.updateCard(card.id, { tags: ["new"] });

    expect(cardTags(card.id)).toEqual([{ card_id: card.id, tag: "new" }]);
    expect(cardsEngine.getCards({ tag: "old" })).toHaveLength(0);
    expect(cardsEngine.getCards({ tag: "new" })).toHaveLength(1);
  });

  it("removes tag relations when tags are cleared", async () => {
    const card = await cardsEngine.createCard({ title: "Tag junction clear", body: "body", tags: ["remove-me"] });

    await cardsEngine.updateCard(card.id, { tags: [] });

    expect(cardTags(card.id)).toEqual([]);
    expect(cardsEngine.getCard(card.id)?.tags).toEqual([]);
  });

  it("returns backlinks when A links to B", async () => {
    const first = await cardsEngine.createCard({ title: "Backlink A", body: "body" });
    const second = await cardsEngine.createCard({ title: "Backlink B", body: "body" });
    cardsEngine.linkCards(first.id, second.id);

    expect(cardsEngine.getBacklinks(second.id).some((card: any) => card.id === first.id)).toBe(true);
  });

  it("stores Zettelkasten links in card_links", async () => {
    const first = await cardsEngine.createCard({ title: "Link junction A", body: "body" });
    const second = await cardsEngine.createCard({ title: "Link junction B", body: "body" });

    cardsEngine.linkCards(first.id, second.id);

    expect(cardLinks(first.id)).toContainEqual({ source_card_id: first.id, target_card_id: second.id });
    expect(cardLinks(second.id)).toContainEqual({ source_card_id: second.id, target_card_id: first.id });
  });

  it("rejects self links through the API", async () => {
    const card = await cardsEngine.createCard({ title: "Self link", body: "body" });

    const response = await request(app)
      .post(`/api/cards/${card.id}/links`)
      .send({ targetId: card.id });

    expect(response.status).toBe(400);
    expect(cardLinks(card.id)).toEqual([]);
  });

  it("does not duplicate link rows when the same link is added twice", async () => {
    const first = await cardsEngine.createCard({ title: "Duplicate link A", body: "body" });
    const second = await cardsEngine.createCard({ title: "Duplicate link B", body: "body" });

    cardsEngine.linkCards(first.id, second.id);
    cardsEngine.linkCards(first.id, second.id);

    expect(cardLinks(first.id).filter((link: any) => link.target_card_id === second.id)).toHaveLength(1);
    expect(cardLinks(second.id).filter((link: any) => link.target_card_id === first.id)).toHaveLength(1);
  });

  it("removes link rows when cards are unlinked", async () => {
    const first = await cardsEngine.createCard({ title: "Unlink A", body: "body" });
    const second = await cardsEngine.createCard({ title: "Unlink B", body: "body" });
    cardsEngine.linkCards(first.id, second.id);

    cardsEngine.unlinkCards(first.id, second.id);

    expect(cardLinks(first.id)).toEqual([]);
    expect(cardLinks(second.id)).toEqual([]);
    expect(cardsEngine.getBacklinks(second.id)).toHaveLength(0);
  });

  it("persists tags and links through junction tables", async () => {
    const first = await cardsEngine.createCard({ title: "Junction A", body: "body", tags: ["junction", "db"] });
    const second = await cardsEngine.createCard({ title: "Junction B", body: "body" });
    cardsEngine.linkCards(first.id, second.id);

    expect(cardsEngine.getCard(first.id)?.tags).toEqual(["junction", "db"]);
    expect(cardsEngine.getCard(first.id)?.links).toContain(second.id);
    expect(cardsEngine.getAllTags().some(({ tag, count }) => tag === "junction" && count === 1)).toBe(true);

    await cardsEngine.updateCard(first.id, { tags: ["normalized"] });
    expect(cardsEngine.getCard(first.id)?.tags).toEqual(["normalized"]);
    expect(cardsEngine.getCards({ tag: "junction" })).toHaveLength(0);
    expect(cardsEngine.getCards({ tag: "normalized" })).toHaveLength(1);
  });

  it("removes tag and link relations when a card is deleted", async () => {
    const first = await cardsEngine.createCard({ title: "Delete relation A", body: "body", tags: ["delete-tag"] });
    const second = await cardsEngine.createCard({ title: "Delete relation B", body: "body" });
    cardsEngine.linkCards(first.id, second.id);

    cardsEngine.deleteCard(second.id);

    expect(cardLinks(first.id)).toEqual([]);
    expect(cardsEngine.getCard(first.id)?.links).toEqual([]);

    cardsEngine.deleteCard(first.id);
    expect(cardTags(first.id)).toEqual([]);
  });

  it("bulk delete removes related tag and link rows", async () => {
    const first = await cardsEngine.createCard({ title: "Bulk relation A", body: "body", tags: ["bulk-tag"] });
    const second = await cardsEngine.createCard({ title: "Bulk relation B", body: "body", tags: ["bulk-tag-2"] });
    const third = await cardsEngine.createCard({ title: "Bulk relation C", body: "body" });
    cardsEngine.linkCards(third.id, first.id);
    cardsEngine.linkCards(third.id, second.id);

    cardsEngine.bulkDeleteCards([first.id, second.id]);

    expect(cardTags(first.id)).toEqual([]);
    expect(cardTags(second.id)).toEqual([]);
    expect(cardLinks(third.id)).toEqual([]);
    expect(cardsEngine.getCard(third.id)?.links).toEqual([]);
  });

  it("keeps API responses compatible with tags and links arrays", async () => {
    const first = await cardsEngine.createCard({ title: "API relation A", body: "body", tags: ["api-tag"] });
    const second = await cardsEngine.createCard({ title: "API relation B", body: "body" });
    cardsEngine.linkCards(first.id, second.id);

    const response = await request(app).get(`/api/cards/${first.id}`);

    expect(response.status).toBe(200);
    expect(response.body.tags).toEqual(["api-tag"]);
    expect(response.body.links).toContain(second.id);
  });

  it("creates, updates, assigns, and deletes KJ groups", async () => {
    const card = await cardsEngine.createCard({ title: "KJ card", body: "body" });
    const group = cardsEngine.createKJGroup("Group A", "description");
    expect(cardsEngine.loadKJGroups()).toHaveLength(1);

    const updated = cardsEngine.updateKJGroup(group.id, { name: "Group B" });
    expect(updated?.name).toBe("Group B");

    await cardsEngine.assignKJGroup(card.id, group.id);
    expect(cardsEngine.getCard(card.id)?.kjGroupId).toBe(group.id);

    cardsEngine.deleteKJGroup(group.id);
    expect(cardsEngine.loadKJGroups()).toHaveLength(0);
    expect(cardsEngine.getCard(card.id)?.kjGroupId).toBeUndefined();
  });
});
