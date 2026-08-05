import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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
    expect(status.json().paperValidation).toMatchObject({
      running: false,
      validationCount: 0,
      lastResult: null,
    });

    const compactStatus = await app.inject({
      method: "GET",
      url: "/api/status?compact=true",
    });
    expect(compactStatus.statusCode).toBe(200);
    expect(compactStatus.json().marketScan).toMatchObject({
      candidateCount: 0,
      lastScanAt: null,
    });
    expect(compactStatus.json().marketScan).not.toHaveProperty("candidates");

    const validation = await app.inject({
      method: "GET",
      url: "/api/paper/validation",
    });
    expect(validation.statusCode).toBe(200);
    expect(validation.json().validation).toMatchObject({
      passed: true,
      sqliteIntegrity: "ok",
    });

    await app.inject({ method: "POST", url: "/api/paper/start" });
    const refreshedCandidates = await app.inject({
      method: "GET",
      url: "/api/candidates?refresh=true",
    });
    expect(refreshedCandidates.statusCode).toBe(200);
    expect(refreshedCandidates.json()).toMatchObject({
      candidateCount: 1,
      scanning: false,
      lastError: null,
    });
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

  it("reports an unhealthy ledger without mutating it during a GET check", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-validation-api-"));
    const databasePath = join(directory, "paper.db");
    const scanner: CandidateScanner = { scan: async () => [] };
    const candidates = new CandidateService(scanner, 15_000);
    const database = new PaperDatabase(databasePath, 100_000_000);
    const app = buildApp({
      config: { ...testConfig, databasePath },
      database,
      candidates,
      liveExecutor: new LiveExecutorDisabled(),
    });
    resources.push(app, database, {
      close: () => rmSync(directory, { recursive: true, force: true }),
    });

    database.setStrategyStatus("RUNNING");
    database.placePaperBuy(makeCandidate(), 100_000_000);
    const rawDatabase = new Database(databasePath);
    try {
      rawDatabase
        .prepare("UPDATE strategy_state SET reserved_cash_micros = 0 WHERE id = 1")
        .run();
    } finally {
      rawDatabase.close();
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/paper/validation",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().validation).toMatchObject({
      passed: false,
      errors: expect.arrayContaining([
        "Reserved paper cash does not match active buy orders",
      ]),
    });
    expect(database.getStrategyState().status).toBe("RUNNING");
  });
});
