import { beforeEach, describe, expect, it } from "vitest";
import { cardsEngine, resetCards } from "./helpers.js";

describe("card import", () => {
  beforeEach(() => {
    resetCards();
  });

  it("imports valid CSV", () => {
    const imported = cardsEngine.parseAndImportCSV("title,body,tags\nCSV card,CSV body,\"csv,import\"");
    expect(imported).toHaveLength(1);
    expect(cardsEngine.loadCards()).toHaveLength(1);
  });

  it("imports valid JSON", () => {
    const result = cardsEngine.parseAndImportJSON(
      JSON.stringify([{ title: "JSON card", body: "JSON body", tags: ["json"] }]),
    );
    expect(result.cards).toHaveLength(1);
    expect(cardsEngine.loadCards()).toHaveLength(1);
  });

  it("does not crash the process for invalid import input", () => {
    expect(() => cardsEngine.parseAndImportCSV("title,body")).not.toThrow();
    expect(() => cardsEngine.parseAndImportJSON("{ invalid json")).toThrow();
  });
});
