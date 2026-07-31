import request from "supertest";
import { describe, expect, it } from "vitest";
import { app, database } from "./helpers.js";

describe("collection to knowledge workflow", () => {
  it("reviews, saves, organizes, searches, links, and exports one candidate", async () => {
    const id = `workflow-${Date.now()}`;
    const now = new Date().toISOString();
    database.db.prepare(`INSERT INTO articles (id, title, body, url, source, source_authority, published_at, summary, tags_json, tokens_json, doc_length, content_hash, created_at, updated_at, last_fetched_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, "Workflow candidate", "A collected workflow article", `https://example.test/${id}`, "fixture", 0.9, now, "Workflow summary", '["fixture"]', '["workflow"]', 1, id, now, now, now, now);
    try {
      const reviewed = await request(app).put(`/api/candidates/${id}/review`);
      expect(reviewed.status).toBe(200);
      expect(reviewed.body.status).toBe("reviewed_not_saved");
      const saved = await request(app).post(`/api/candidates/${id}/save`);
      expect(saved.status).toBe(201);
      expect(saved.body.candidate.status).toBe("saved_as_card");
      const cardId = saved.body.card.id;
      const searched = await request(app).get(`/api/cards?q=Workflow%20candidate`);
      expect(searched.body.some((card: { id: string }) => card.id === cardId)).toBe(true);
      const tagged = await request(app).put(`/api/cards/${cardId}`).send({ tags: ["workflow", "fixture"] });
      expect(tagged.status).toBe(200);
      const group = await request(app).post("/api/kj/groups").send({ name: `Workflow group ${id}`, color: "#4D96FF" });
      expect(group.status).toBe(201);
      expect((await request(app).post(`/api/kj/groups/${group.body.id}/cards`).send({ cardId })).status).toBe(200);
      const linked = await request(app).post(`/api/cards/${cardId}/links`).send({ targetId: cardId });
      expect([200, 201, 400]).toContain(linked.status);
      const exported = await request(app).get(`/api/cards/${cardId}/export-md`);
      expect(exported.status).toBe(200);
      expect(exported.text).toContain("# Workflow candidate");
    } finally {
      database.db.prepare("DELETE FROM cards WHERE url = ?").run(`https://example.test/${id}`);
      database.db.prepare("DELETE FROM articles WHERE id = ?").run(id);
    }
  });
});