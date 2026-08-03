import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { CandidateScanner } from "../src/domain/market-scanner.js";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { LiveExecutorDisabled } from "../src/infrastructure/execution/live-executor-disabled.js";
import { CandidateService } from "../src/services/candidate-service.js";
import { makeCandidate, testConfig } from "./helpers.js";

describe("HTTP app", () => {
  const resources: Array<{ close: () => void | Promise<void> }> = [];

  afterEach(async () => {
    for (const resource of resources.splice(0)) await resource.close();
  });

  it("starts in paper mode and creates a virtual buy", async () => {
    const scanner: CandidateScanner = {
      scan: async () => [makeCandidate()],
    };
    const candidates = new CandidateService(scanner, 15_000);
    const database = new PaperDatabase(":memory:", 100_000_000);
    const app = buildApp({
      config: testConfig,
      database,
      candidates,
      liveExecutor: new LiveExecutorDisabled(),
    });
    resources.push(app, database);

    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json().liveExecutionEnabled).toBe(false);
    expect(status.json().version).toBe("0.4.0");
    expect(status.json().paperSettlement).toMatchObject({
      running: false,
      settledMarketCount: 0,
    });

    await app.inject({ method: "POST", url: "/api/paper/start" });
    await app.inject({ method: "GET", url: "/api/candidates?refresh=true" });
    const orderResponse = await app.inject({
      method: "POST",
      url: "/api/paper/orders/buy",
      payload: { candidateId: "yes-token:20000" },
    });
    expect(orderResponse.statusCode).toBe(201);
    expect(orderResponse.json().order.status).toBe("OPEN");

    const positions = await app.inject({
      method: "GET",
      url: "/api/paper/positions",
    });
    const settlements = await app.inject({
      method: "GET",
      url: "/api/paper/settlements",
    });
    expect(positions.statusCode).toBe(200);
    expect(settlements.statusCode).toBe(200);
    expect(positions.json().positions).toEqual([]);
    expect(settlements.json().settlements).toEqual([]);
  });
});
