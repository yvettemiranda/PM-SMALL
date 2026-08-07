import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { CandidateScanner } from "../src/domain/market-scanner.js";
import type { TokenOrderBook, TradeCandidate } from "../src/domain/types.js";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { LiveExecutorDisabled } from "../src/infrastructure/execution/live-executor-disabled.js";
import { CandidateService } from "../src/services/candidate-service.js";
import type {
  MarketStreamStatus,
  PaperMarketRuntime,
} from "../src/services/market-stream-service.js";
import { PaperTradingPreferencesService } from "../src/services/paper-trading-preferences-service.js";
import { makeCandidate, testConfig, testEligibilitySettings } from "./helpers.js";

describe("HTTP app", () => {
  const resources: Array<{ close: () => void | Promise<void> }> = [];

  afterEach(async () => {
    for (const resource of resources.splice(0).reverse()) await resource.close();
  });

  it("exposes TEST as the only enabled execution mode and a compact dashboard", async () => {
    const { app, candidates } = makeTestApp([makeCurrentCandidate()]);
    await candidates.refresh();

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json()).toEqual({ status: "ok", mode: "TEST" });

    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.json()).toMatchObject({
      version: "0.5.0",
      executionMode: "TEST",
      liveExecutionEnabled: false,
      strategy: { mode: "TEST", status: "PAUSED" },
      capitalEditable: true,
    });

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard?limit=20",
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json()).toMatchObject({
      executionMode: "TEST",
      liveExecutionEnabled: false,
      strategy: { mode: "TEST", status: "PAUSED" },
      portfolio: {
        totalFunds: "100",
        totalPnl: "0",
        realizedPnl: "0",
        unrealizedPnl: "0",
      },
      marketScan: {
        candidateCount: 1,
        displayedCandidateCount: 1,
        candidates: [
          expect.objectContaining({
            tokenId: "yes-token",
            executableBuyPrice: "0.03",
          }),
        ],
      },
    });

    const expandedDashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard?limit=501",
    });
    expect(expandedDashboard.statusCode).toBe(200);
  });

  it("promotes a monitored market immediately when its live ask reaches the cap", async () => {
    const monitored = makeCurrentCandidate({
      bestAskMicros: 40_000,
      executableBuyPriceMicros: 40_000,
      makerBuyPriceMicros: 40_000,
    });
    const { app, candidates } = makeTestApp([monitored]);
    await candidates.refresh();

    const before = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(before.json().marketScan).toMatchObject({ candidateCount: 0 });

    candidates.updateQuote(monitored.tokenId, 20_000, 30_000);

    const after = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(after.json().marketScan).toMatchObject({
      candidateCount: 1,
      candidates: [
        expect.objectContaining({
          tokenId: monitored.tokenId,
          executableBuyPrice: "0.03",
        }),
      ],
    });
  });

  it("saves category, market, price, duration, ordering, capital, and order amount settings", async () => {
    const { app, candidates } = makeTestApp([
      makeCurrentCandidate({
        candidateId: "tech:30000",
        tokenId: "tech",
        category: "Tech",
        categoryIds: ["tag-tech"],
        categoryLabels: ["Technology"],
      }),
      makeCurrentCandidate({
        candidateId: "sports:30000",
        tokenId: "sports",
        category: "Sports",
        categoryIds: ["tag-sports"],
        categoryLabels: ["Sports"],
      }),
    ]);
    await candidates.refresh();

    const response = await app.inject({
      method: "PUT",
      url: "/api/test/preferences",
      payload: {
        resultCounts: [2, 3],
        allCategories: false,
        selectedCategoryIds: ["tag-tech"],
        maxBuyPriceCents: 3,
        minBidAskRatioPercent: 60,
        maxMarketProgressPercent: 15,
        maxMarketDurationDays: 30,
        candidateSortDirection: "DESC",
        initialCapital: 120,
        orderAmount: 2,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      strategy: { initialCapital: "120", availableCash: "120" },
      preferences: {
        allCategories: false,
        selectedCategoryIds: ["tag-tech"],
        selectedCategories: ["tag-tech"],
        candidateSortDirection: "DESC",
        minBidAskRatioPercent: 60,
        maxMarketProgressPercent: 15,
        orderAmount: "2",
      },
    });
    const snapshot = await app.inject({ method: "GET", url: "/api/candidates" });
    expect(snapshot.json()).toMatchObject({
      candidateCount: 1,
      candidates: [expect.objectContaining({ tokenId: "tech" })],
    });
    expect(snapshot.json()).not.toHaveProperty("selectedCandidateCount");
    expect(snapshot.body).not.toContain('"selected"');

    const status = await app.inject({ method: "GET", url: "/api/status?compact=true" });
    expect(status.json()).toMatchObject({
      configuration: { initialCapital: "120" },
    });
  });

  it("saves running TEST filters when the submitted capital is unchanged", async () => {
    const { app } = makeTestApp([]);
    await app.inject({ method: "POST", url: "/api/test/start" });

    const response = await app.inject({
      method: "PUT",
      url: "/api/test/preferences",
      payload: {
        resultCounts: [2, 3],
        allCategories: true,
        selectedCategories: [],
        maxBuyPriceCents: 2,
        maxMarketDurationDays: 14,
        candidateSortDirection: "ASC",
        initialCapital: 100,
        orderAmount: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      strategy: { status: "RUNNING", initialCapital: "100" },
      preferences: {
        maxBuyPriceCents: 2,
        maxMarketDurationDays: 14,
      },
    });
  });

  it("rejects a configuration that disables both binary and ternary markets", async () => {
    const { app, tradingPreferences } = makeTestApp([]);

    const response = await app.inject({
      method: "PUT",
      url: "/api/test/preferences",
      payload: {
        resultCounts: [],
        allCategories: true,
        selectedCategories: [],
        maxBuyPriceCents: 3,
        maxMarketDurationDays: 30,
        candidateSortDirection: "ASC",
        initialCapital: 100,
        orderAmount: 1,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(tradingPreferences.getSnapshot().resultCounts).toEqual([2, 3]);
  });

  it("executes a manual TEST request through the same FAK path without leaving an active buy", async () => {
    const candidate = makeCurrentCandidate({
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
      bestAskMicros: 20_000,
    });
    const { app, candidates, database } = makeTestApp([candidate], {
      marketStream: marketRuntime(),
    });
    await candidates.refresh();
    await app.inject({ method: "POST", url: "/api/test/start" });

    const response = await app.inject({
      method: "POST",
      url: "/api/test/orders/buy",
      payload: { candidateId: candidate.candidateId },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      outcome: "FILLED",
      order: { executionKind: "FAK", status: "FILLED" },
      spent: "1",
    });
    expect(
      database.listActivePaperOrders().filter((order) => order.side === "BUY"),
    ).toEqual([]);
    expect(database.listCurrentPaperPositionViews()).toEqual([
      expect.objectContaining({ tokenId: candidate.tokenId }),
    ]);
  });

  it("marks a position at zero when the live book has no executable bid", async () => {
    const candidate = makeCurrentCandidate({
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
      bestAskMicros: 20_000,
      bestBidMicros: 10_000,
    });
    const marketStream = marketRuntime();
    marketStream.getBestBidMicros = () => null;
    const { app, candidates } = makeTestApp([candidate], { marketStream });
    await candidates.refresh();
    await app.inject({ method: "POST", url: "/api/test/start" });
    await app.inject({
      method: "POST",
      url: "/api/test/orders/buy",
      payload: { candidateId: candidate.candidateId },
    });

    const dashboard = await app.inject({ method: "GET", url: "/api/dashboard" });

    expect(dashboard.json()).toMatchObject({
      portfolio: {
        totalFunds: "99",
        totalPnl: "-1",
        unrealizedPnl: "-1",
      },
      positions: [
        expect.objectContaining({
          tokenId: candidate.tokenId,
          currentSellPrice: null,
          currentSellPriceStatus: "NO_BID",
          unrealizedPnl: "-1",
        }),
      ],
    });
  });

  it("rejects a stale candidate after the market has ended", async () => {
    const now = Date.now();
    const staleCandidate = makeCandidate({
      progressPercent: 10,
      openedAt: new Date(now - 10 * 86_400_000).toISOString(),
      endsAt: new Date(now - 1).toISOString(),
      durationDays: 10,
    });
    const { app, candidates, database } = makeTestApp([staleCandidate], {
      marketStream: marketRuntime(),
    });
    await candidates.refresh();
    database.setStrategyStatus("RUNNING");

    const buy = await app.inject({
      method: "POST",
      url: "/api/test/orders/buy",
      payload: { candidateId: staleCandidate.candidateId },
    });
    expect(buy.statusCode).toBe(409);
    expect(database.listPaperOrders()).toEqual([]);
  });

  it("requires pause and an exact confirmation before resetting all TEST data", async () => {
    const candidate = makeCurrentCandidate({
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
      bestAskMicros: 20_000,
    });
    const { app, candidates, database } = makeTestApp([candidate], {
      marketStream: marketRuntime(),
    });
    await candidates.refresh();
    await app.inject({ method: "POST", url: "/api/test/start" });
    await app.inject({
      method: "POST",
      url: "/api/test/orders/buy",
      payload: { candidateId: candidate.candidateId },
    });

    const whileRunning = await app.inject({
      method: "POST",
      url: "/api/test/reset",
      payload: {
        confirmation: "RESET TEST",
        finalConfirmation: "RESET TEST AGAIN",
      },
    });
    expect(whileRunning.statusCode).toBe(409);

    await app.inject({ method: "POST", url: "/api/test/pause" });
    const capitalChangeAfterHistory = await app.inject({
      method: "PUT",
      url: "/api/test/preferences",
      payload: {
        resultCounts: [2, 3],
        allCategories: true,
        selectedCategoryIds: [],
        maxBuyPriceCents: 3,
        maxMarketDurationDays: 30,
        candidateSortDirection: "ASC",
        initialCapital: 120,
        orderAmount: 1,
      },
    });
    expect(capitalChangeAfterHistory.statusCode).toBe(409);
    const dashboardAfterHistory = await app.inject({
      method: "GET",
      url: "/api/dashboard",
    });
    expect(dashboardAfterHistory.json()).toMatchObject({ capitalEditable: false });
    const wrongConfirmation = await app.inject({
      method: "POST",
      url: "/api/test/reset",
      payload: { confirmation: "reset", finalConfirmation: "reset" },
    });
    expect(wrongConfirmation.statusCode).toBe(400);

    const reset = await app.inject({
      method: "POST",
      url: "/api/test/reset",
      payload: { confirmation: "RESET TEST" },
    });
    expect(reset.statusCode).toBe(400);

    const confirmedReset = await app.inject({
      method: "POST",
      url: "/api/test/reset",
      payload: {
        confirmation: "RESET TEST",
        finalConfirmation: "RESET TEST AGAIN",
      },
    });
    expect(confirmedReset.statusCode).toBe(200);
    expect(confirmedReset.json()).toMatchObject({
      strategy: {
        status: "PAUSED",
        initialCapital: "100",
        availableCash: "100",
        realizedPnl: "0",
        positionCost: "0",
      },
      preferences: { orderAmount: "1", maxBuyPriceCents: 3 },
    });
    expect(database.listPaperOrders()).toEqual([]);
    expect(database.listPaperPositions()).toEqual([]);
  });

  it("serves the compact single-column TEST UI without per-market participation controls", async () => {
    const { app } = makeTestApp([]);
    const page = await app.inject({ method: "GET", url: "/" });

    expect(page.body).toContain("TEST");
    expect(page.body).toContain("LIVE");
    expect(page.body).toContain("交易配置");
    expect(page.body).toContain("市场类别");
    expect(page.body).toContain("最低买卖盘比例");
    expect(page.body).toContain("生命周期进度");
    expect(page.body).toContain("总模拟资金");
    expect(page.body).toContain("每单使用金额");
    expect(page.body).toContain("重置TEST");
    expect(page.body).toContain("总资金");
    expect(page.body).toContain("当前持仓");
    expect(page.body).toContain("扫描市场");
    expect(page.body).toContain('id="scan-refresh-state"');
    expect(page.body).not.toContain("市场选择（可多选）");
    expect(page.body).not.toContain("全选");
    expect(page.body).not.toContain("清空TEST交易范围");
    expect(page.body).not.toContain("进入时市场进度");
    expect(page.body).toContain('id="market-progress-filter"');
    expect(page.body).not.toContain("开始新一轮");
    expect(page.body).not.toContain('id="new-cycle"');
    expect(page.body).not.toContain("PAPER");
  });

  it("does not expose a manual new-cycle endpoint", async () => {
    const { app } = makeTestApp([]);

    const response = await app.inject({
      method: "POST",
      url: "/api/test/cycle/start",
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns all 101 distinct current token positions", async () => {
    const { app, database } = makeTestApp([]);
    database.setStrategyStatus("RUNNING");
    for (let index = 0; index < 101; index += 1) {
      const tokenId = `partial-token-${index}`;
      const candidate = makeCurrentCandidate({
        candidateId: `${tokenId}:20000`,
        tokenId,
        conditionId: `partial-condition-${index}`,
        marketId: `partial-market-${index}`,
      });
      const result = database.executeTestFakBuy({
        candidate,
        book: {
          tokenId,
          conditionId: candidate.conditionId,
          bookVersion: `PARTIAL-BOOK-${index}`,
          bids: [{ priceMicros: 10_000, sizeMicros: 100_000_000 }],
          asks: [{ priceMicros: 20_000, sizeMicros: 25_000_000 }],
          minOrderSizeMicros: 5_000_000,
          tickSizeMicros: 10_000,
          isNegativeRisk: false,
        },
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        eligibility: testEligibilitySettings(),
        feeRateMicros: 0,
        feeExponent: 1,
      });
      expect(result.spentMicros).toBe(500_000);
    }

    const positions = await app.inject({ method: "GET", url: "/api/test/positions" });
    expect(positions.statusCode).toBe(200);
    expect(positions.json().positions).toHaveLength(101);
    const dashboard = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(dashboard.json().positions).toHaveLength(101);
  });

  function makeTestApp(
    scannedCandidates: TradeCandidate[],
    options: { marketStream?: PaperMarketRuntime } = {},
  ) {
    const scanner: CandidateScanner = { scan: async () => scannedCandidates };
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
      ...(options.marketStream === undefined
        ? {}
        : { marketStream: options.marketStream }),
    });
    resources.push(app, database);
    return { app, candidates, database, tradingPreferences };
  }
});

function makeCurrentCandidate(
  overrides: Parameters<typeof makeCandidate>[0] = {},
): TradeCandidate {
  const now = Date.now();
  return makeCandidate({
    openedAt: new Date(now - 86_400_000).toISOString(),
    endsAt: new Date(now + 9 * 86_400_000).toISOString(),
    durationDays: 10,
    progressPercent: 10,
    ...overrides,
  });
}

function marketRuntime(): PaperMarketRuntime {
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
    getBestBidMicros: () => 10_000,
    getBestAskMicros: () => 20_000,
    getOrderBook: (candidate: TradeCandidate): TokenOrderBook => ({
      tokenId: candidate.tokenId,
      conditionId: candidate.conditionId,
      bookVersion: "APP-TEST-BOOK-1",
      bids: [{ priceMicros: 10_000, sizeMicros: 100_000_000 }],
      asks: [{ priceMicros: 20_000, sizeMicros: 100_000_000 }],
      minOrderSizeMicros: candidate.minOrderSizeMicros,
      tickSizeMicros: candidate.tickSizeMicros,
      isNegativeRisk: candidate.isNegativeRisk,
    }),
  };
}
