import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app, cardsEngine, resetCards } from "./helpers.js";

const jp = {
  "title": "文字化け確認",
  "body": "これは日本語の本文です。検索・タグ・リンク・エクスポートで文字化けしないことを確認します。",
  "tag": "日本語",
  "search": "検索",
  "mojibake": "文字化け",
  "group": "日本語グループ",
  "csvBody": "これはCSVの日本語本文です",
  "jsonTitle": "JSON文字化け確認",
  "jsonBody": "これはJSONの日本語本文です。"
};

describe("UTF-8 Japanese text handling", () => {
  beforeEach(() => {
    resetCards();
  });

  it("preserves Japanese text across API create, read, tag filter, KJ group, and Markdown export", async () => {
    const created = await request(app)
      .post("/api/cards")
      .send({ title: jp.title, body: jp.body, tags: [jp.tag, jp.search, jp.mojibake] });
    expect(created.status).toBe(201);

    const fetched = await request(app).get(`/api/cards/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.title).toBe(jp.title);
    expect(fetched.body.body).toBe(jp.body);
    expect(fetched.body.tags).toContain(jp.tag);

    const tagged = await request(app).get(`/api/cards?tag=${encodeURIComponent(jp.tag)}`);
    expect(tagged.status).toBe(200);
    expect(tagged.body.map((card: { id: string }) => card.id)).toContain(created.body.id);

    const group = await request(app)
      .post("/api/kj/groups")
      .send({ name: jp.group, color: "#4D96FF" });
    expect(group.status).toBe(201);
    expect(group.body.name).toBe(jp.group);

    const assigned = await request(app)
      .post(`/api/kj/groups/${group.body.id}/cards`)
      .send({ cardId: created.body.id });
    expect(assigned.status).toBe(200);

    const groups = await request(app).get("/api/kj/groups");
    expect(groups.body.groups.map((item: { name: string }) => item.name)).toContain(jp.group);

    const exported = await request(app).get(`/api/cards/${created.body.id}/export-md`);
    expect(exported.status).toBe(200);
    expect(exported.text).toContain(`# ${jp.title}`);
    expect(exported.text).toContain(jp.body);
    expect(exported.text).toContain(jp.tag);
  });

  it("preserves Japanese text through CSV and JSON imports", async () => {
    const csv = `title,body,tags\n${jp.title},${jp.csvBody},"${jp.tag},${jp.search}"`;
    const csvCards = await cardsEngine.parseAndImportCSV(csv);
    expect(csvCards[0].title).toBe(jp.title);
    expect(csvCards[0].body).toBe(jp.csvBody);
    expect(csvCards[0].tags).toContain(jp.tag);

    resetCards();
    const jsonCards = await cardsEngine.parseAndImportJSON(JSON.stringify([
      {
        title: jp.jsonTitle,
        body: jp.jsonBody,
        tags: [jp.tag, jp.mojibake],
      },
    ]));
    expect(jsonCards.cards[0].title).toBe(jp.jsonTitle);
    expect(jsonCards.cards[0].body).toBe(jp.jsonBody);
    expect(jsonCards.cards[0].tags).toContain(jp.mojibake);
  });
});
