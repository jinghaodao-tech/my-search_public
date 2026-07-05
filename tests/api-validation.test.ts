import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app, resetCards } from "./helpers.js";

describe("API validation", () => {
  beforeEach(() => {
    resetCards();
  });

  it("returns 404 for invalid IDs", async () => {
    const response = await request(app).get("/api/cards/not-found-id");
    expect(response.status).toBe(404);
  });

  it("returns 400 for empty create bodies", async () => {
    const response = await request(app).post("/api/cards").send({});
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid request");
  });
});
