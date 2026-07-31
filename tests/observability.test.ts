import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app, resetCards } from "./helpers.js";
import { clearTestLogRecords, testLogRecords } from "../utils/logger.js";

describe("logging and error observability", () => {
  beforeEach(() => {
    resetCards();
    clearTestLogRecords();
  });

  it("returns the request ID header", async () => {
    const response = await request(app)
      .get("/api/cards")
      .set("X-Request-Id", "test-request-id");

    expect(response.status).toBe(200);
    expect(response.headers["x-request-id"]).toBe("test-request-id");
  });

  it("exposes aggregated request metrics without private payloads", async () => {
    await request(app).get("/api/cards");
    await new Promise(resolve => setImmediate(resolve));
    const response = await request(app).get("/metrics");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.metrics.some((metric: { route: string; count: number; averageMs: number }) => metric.route.includes("/api/cards") && metric.count > 0)).toBe(true);
  });

  it("includes requestId in validation errors", async () => {
    const response = await request(app)
      .post("/api/cards")
      .set("X-Request-Id", "validation-request-id")
      .send({});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: "Invalid request",
      requestId: "validation-request-id",
    });
  });

  it("includes requestId in 404 errors", async () => {
    const response = await request(app)
      .get("/api/cards/not-found-id")
      .set("X-Request-Id", "not-found-request-id");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      error: "Not found",
      requestId: "not-found-request-id",
    });
  });

  it("does not expose stack traces in 500 responses", async () => {
    const response = await request(app)
      .get("/api/test/error")
      .set("X-Request-Id", "error-request-id");

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      error: "Internal server error",
      requestId: "error-request-id",
    });
    expect(JSON.stringify(response.body)).not.toContain("stack");
    expect(JSON.stringify(response.body)).not.toContain("synthetic test failure");
  });

  it("does not log sensitive request headers or private card body content", async () => {
    await request(app)
      .post("/api/cards")
      .set("Authorization", "Bearer SECRET_API_TOKEN")
      .set("Cookie", "session=SECRET_COOKIE")
      .send({
        title: "observability card",
        body: "SECRET_PRIVATE_NOTE",
      });

    const logs = JSON.stringify(testLogRecords);
    expect(logs).not.toContain("SECRET_API_TOKEN");
    expect(logs).not.toContain("SECRET_COOKIE");
    expect(logs).not.toContain("SECRET_PRIVATE_NOTE");
  });
});
