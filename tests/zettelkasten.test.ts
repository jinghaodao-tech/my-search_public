import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app, cardsEngine, resetCards } from "./helpers.js";

describe("Zettelkasten graph", () => {
  beforeEach(() => {
    resetCards();
  });

  it("excludes isolated cards from nodes", async () => {
    const linkedA = await cardsEngine.createCard({ title: "Linked A", body: "body" });
    const linkedB = await cardsEngine.createCard({ title: "Linked B", body: "body" });
    const isolated = await cardsEngine.createCard({ title: "Isolated", body: "body" });
    cardsEngine.linkCards(linkedA.id, linkedB.id);

    const response = await request(app).get("/api/zettelkasten/graph");
    expect(response.status).toBe(200);
    const nodeIds = response.body.nodes.map((node: any) => node.id);

    expect(nodeIds).toContain(linkedA.id);
    expect(nodeIds).toContain(linkedB.id);
    expect(nodeIds).not.toContain(isolated.id);
  });
});
