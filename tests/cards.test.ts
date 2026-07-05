import { beforeEach, describe, expect, it } from "vitest";
import { cardsEngine, resetCards } from "./helpers.js";

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

  it("returns backlinks when A links to B", async () => {
    const first = await cardsEngine.createCard({ title: "Backlink A", body: "body" });
    const second = await cardsEngine.createCard({ title: "Backlink B", body: "body" });
    cardsEngine.linkCards(first.id, second.id);

    expect(cardsEngine.getBacklinks(second.id).some((card: any) => card.id === first.id)).toBe(true);
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
