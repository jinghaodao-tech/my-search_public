import { beforeEach, describe, expect, it } from "vitest";
import { cardsEngine, resetCards } from "./helpers.js";

describe("card import", () => {
  beforeEach(() => {
    resetCards();
  });

  it("imports valid CSV", async () => {
    const imported = await cardsEngine.parseAndImportCSV("title,body,tags\nCSV card,CSV body,\"csv,import\"");
    expect(imported).toHaveLength(1);
    const saved = cardsEngine.loadCards()[0];
    expect(saved.tokens?.length).toBeGreaterThan(0);
    expect(saved.docLength).toBeGreaterThan(0);
  });

  it("imports valid JSON", async () => {
    const result = await cardsEngine.parseAndImportJSON(
      JSON.stringify([{ title: "JSON card", body: "JSON body", tags: ["json"] }]),
    );
    expect(result.cards).toHaveLength(1);
    const saved = cardsEngine.loadCards()[0];
    expect(saved.tokens?.length).toBeGreaterThan(0);
    expect(saved.docLength).toBeGreaterThan(0);
  });

  it("does not crash the process for invalid import input", async () => {
    await expect(cardsEngine.parseAndImportCSV("title,body")).resolves.toEqual([]);
    await expect(cardsEngine.parseAndImportJSON("{ invalid json")).rejects.toThrow();
  });
});