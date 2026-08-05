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
import type {
  MarketStreamStatus,
  PaperMarketRuntime,
} from "../src/services/market-stream-service.js";
import { PaperTradingPreferencesService } from "../src/services/paper-trading-preferences-service.js";
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
    const tradingPreferences = new PaperTradingPreferencesService(
      database,
      testConfig,
    );
    const app = buildApp({
      config: testConfig,
      database,
      candidates,
      tradingPreferences,
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
    expect(status.json().runtime).toEqual({
      uptimeSeconds: expect.any(Number),
      rssBytes: expect.any(Number),
      heapTotalBytes: expect.any(Number),
      heapUsedBytes: expect.any(Number),
      externalBytes: expect.any(Number),
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
    expect(compactStatus.json().runtime).toEqual({
      uptimeSeconds: expect.any(Number),
      rssBytes: expect.any(Number),
      heapTotalBytes: expect.any(Number),
      heapUsedBytes: expect.any(Number),
      externalBytes: expect.any(Number),
    });

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
    const tradingPreferences = new PaperTradingPreferencesService(
      database,
      testConfig,
    );
    const app = buildApp({
      config: { ...testConfig, databasePath },
      database,
      candidates,
      tradingPreferences,
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

  it("applies TEST UI filters and candidate selection through PAPER APIs", async () => {
    const scanner: CandidateScanner = {
      scan: async () => [
        makeCandidate(),
        makeCandidate({
          candidateId: "ternary-token:30000",
          tokenId: "ternary-token",
          resultCount: 3,
          direction: "NO",
        }),
      ],
    };
    const candidates = new CandidateService(scanner, 15_000);
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    const tradingPreferences = new PaperTradingPreferencesService(
      database,
      testConfig,
    );
    const app = buildApp({
      config: testConfig,
      database,
      candidates,
      tradingPreferences,
      liveExecutor: new LiveExecutorDisabled(),
    });
    resources.push(app, database);

    const updated = await app.inject({
      method: "PUT",
      url: "/api/paper/preferences",
      payload: {
        resultCounts: [3],
        maxBuyPriceCents: 3,
        maxMarketDurationDays: 60,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().preferences).toMatchObject({
      resultCounts: [3],
      maxBuyPriceCents: 3,
      maxMarketDurationDays: 60,
    });

    const cleared = await app.inject({
      method: "PUT",
      url: "/api/paper/candidate-selection",
      payload: { action: "none" },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().selectedCandidateCount).toBe(0);

    const selected = await app.inject({
      method: "PUT",
      url: "/api/paper/candidate-selection",
      payload: { action: "set", tokenId: "ternary-token", selected: true },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().selectedCandidateCount).toBe(1);

    const snapshot = await app.inject({ method: "GET", url: "/api/candidates" });
    expect(snapshot.json()).toMatchObject({
      candidateCount: 1,
      selectedCandidateCount: 1,
      candidates: [
        expect.objectContaining({ tokenId: "ternary-token", selected: true }),
      ],
    });

    await app.inject({ method: "POST", url: "/api/paper/start" });
    const rejectedExcludedBuy = await app.inject({
      method: "POST",
      url: "/api/paper/orders/buy",
      payload: { candidateId: "yes-token:20000" },
    });
    expect(rejectedExcludedBuy.statusCode).toBe(409);
    expect(rejectedExcludedBuy.json().error).toMatch(/current TEST filters/);

    const unknownSelection = await app.inject({
      method: "PUT",
      url: "/api/paper/candidate-selection",
      payload: { action: "set", tokenId: "unknown-token", selected: false },
    });
    expect(unknownSelection.statusCode).toBe(404);
  });

  it("serves position display data, mark-to-market PnL, and the compact TEST UI", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-dashboard-position-"));
    const databasePath = join(directory, "paper.db");
    const candidates = new CandidateService(
      { scan: async () => [makeCandidate()] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(databasePath, 100_000_000);
    const tradingPreferences = new PaperTradingPreferencesService(
      database,
      testConfig,
    );
    database.setStrategyStatus("RUNNING");
    const buy = database.placePaperBuy(makeCandidate({ queueAheadSizeMicros: 0 }), 100_000_000);
    database.applyPaperTrade({
      orderId: buy.id,
      sourceTradeId: "dashboard-position-fill",
      tradePriceMicros: 20_000,
      tradeSizeMicros: 2_000_000,
      dataComplete: true,
    });
    const rawDatabase = new Database(databasePath);
    try {
      rawDatabase
        .prepare(
          `UPDATE paper_market_metadata
          SET event_slug = NULL, event_title = NULL,
              market_question = NULL, direction = NULL
          WHERE token_id = ?`,
        )
        .run("yes-token");
    } finally {
      rawDatabase.close();
    }
    const app = buildApp({
      config: testConfig,
      database,
      candidates,
      tradingPreferences,
      liveExecutor: new LiveExecutorDisabled(),
      marketStream: marketRuntimeWithBestBid(30_000),
    });
    resources.push(app, database, {
      close: () => rmSync(directory, { recursive: true, force: true }),
    });

    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.json().portfolio).toEqual({
      totalFunds: "100.02",
      totalPnl: "0.02",
      realizedPnl: "0",
      unrealizedPnl: "0.02",
    });

    const positions = await app.inject({
      method: "GET",
      url: "/api/paper/positions",
    });
    expect(positions.json().positions).toEqual([
      expect.objectContaining({
        marketQuestion: "Will this test pass?",
        direction: "YES",
        averageBuyPrice: "0.02",
        markPrice: "0.03",
        unrealizedPnl: "0.02",
        marketUrl: "https://polymarket.com/event/test-event",
      }),
    ]);

    const page = await app.inject({ method: "GET", url: "/" });
    expect(page.body).toContain("TEST");
    expect(page.body).toContain("LIVE");
    expect(page.body).toContain("交易配置");
    expect(page.body).toContain("总资金");
    expect(page.body).toContain("当前持仓");
    expect(page.body).toContain("扫描市场");
    expect(page.body).toContain('max="3"');
    expect(page.body).toContain("市场总时长上限");
    expect(page.body).not.toContain("PAPER ONLY");
    expect(page.body).not.toContain("测试订单");
    expect(page.body).not.toContain("结算与纸面赎回");
  });
});

function marketRuntimeWithBestBid(bestBidMicros: number): PaperMarketRuntime {
  return {
    getStatus: (): MarketStreamStatus => ({
      running: true,
      connected: true,
      subscribedTokenCount: 1,
      dataCompleteTokenCount: 1,
      lastEventAt: null,
      processedTradeEvents: 0,
      ignoredTradeEvents: 0,
      paperBuyFillCount: 0,
      paperSellFillCount: 0,
      createdPaperSellCount: 0,
      connectionCount: 1,
      fullSnapshotCount: 1,
      unexpectedDisconnectCount: 0,
      recoveryCount: 0,
      lastFullSnapshotDurationMs: 1,
      lastRecoveryDurationMs: null,
      lastError: null,
    }),
    refreshSubscriptions: () => {},
    isTokenReady: () => true,
    getBestBidMicros: () => bestBidMicros,
  };
}
