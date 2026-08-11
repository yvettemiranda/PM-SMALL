import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { CandidateScanner } from "../src/domain/market-scanner.js";
import type { TokenOrderBook, TradeCandidate } from "../src/domain/types.js";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { LiveExecutorDisabled } from "../src/infrastructure/execution/live-executor-disabled.js";
import { CandidateService } from "../src/services/candidate-service.js";
import { EventOpportunityService } from "../src/services/event-opportunity-service.js";
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
        positionValue: "0",
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

  it("renders configurable buy bounds and a compact target sell formula", async () => {
    const { app } = makeTestApp([]);
    const page = await app.inject({ method: "GET", url: "/" });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('id="min-buy-price"');
    expect(page.body).toContain('id="max-buy-price"');
    expect(page.body).toContain('id="target-sell-increase"');
    expect(page.body).toContain('id="target-sell-multiplier"');
    expect(page.body).toMatch(/id="target-sell-increase"[\s\S]*?required/);
    expect(page.body).toMatch(/id="target-sell-multiplier"[\s\S]*?required/);
    expect(page.body).toMatch(/id="target-sell-formula"[^>]*tabindex="0"/);
    expect(page.body).toMatch(
      /id="target-sell-formula"[^>]*aria-keyshortcuts="ArrowLeft ArrowRight Home End"/,
    );
    expect(page.body).toContain("卖价=min(99¢,tick↑max(买价+1¢,买价×1.5))");
    expect(page.body).not.toContain("按市场 tick 向上取整");
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

  it("groups sibling Tokens into one Event row with one displayed representative", async () => {
    const first = makeCurrentCandidate({
      candidateId: "event-first:20000",
      tokenId: "event-first",
      conditionId: "event-first-condition",
      marketId: "event-first-market",
    });
    const sibling = makeCurrentCandidate({
      candidateId: "event-sibling:20000",
      tokenId: "event-sibling",
      conditionId: "event-sibling-condition",
      marketId: "event-sibling-market",
    });
    const { app, candidates } = makeTestApp([first, sibling], {
      marketStream: marketRuntime(),
    });
    await candidates.refresh();

    const dashboard = await app.inject({ method: "GET", url: "/api/dashboard" });

    expect(dashboard.json().marketScan).toMatchObject({
      eventCount: 1,
      displayEventCount: 1,
      tokenCount: 2,
      displayedEventCount: 1,
      candidates: [expect.objectContaining({ eventId: first.eventId })],
      events: [
        expect.objectContaining({
          eventId: first.eventId,
          marketCount: 2,
          tokenCount: 2,
          outcomes: [
            expect.objectContaining({ tokenId: first.tokenId }),
            expect.objectContaining({ tokenId: sibling.tokenId }),
          ],
        }),
      ],
    });
  });

  it("lists tradable Events first while preserving progress order within each group", async () => {
    const now = Date.now();
    const candidateAtProgress = (
      tokenId: string,
      eventId: string,
      progressPercent: number,
    ) => {
      const elapsedDays = (10 * progressPercent) / 100;
      return makeCurrentCandidate({
        candidateId: `${tokenId}:20000`,
        tokenId,
        eventId,
        eventTitle: eventId,
        conditionId: `${tokenId}-condition`,
        marketId: `${tokenId}-market`,
        openedAt: new Date(
          now - elapsedDays * 86_400_000,
        ).toISOString(),
        endsAt: new Date(
          now + (10 - elapsedDays) * 86_400_000,
        ).toISOString(),
        durationDays: 10,
        progressPercent,
      });
    };
    const candidatesInScanOrder = [
      candidateAtProgress("pending-low", "pending-low-event", 1),
      candidateAtProgress("ready-high", "ready-high-event", 8),
      candidateAtProgress("ready-low", "ready-low-event", 3),
      candidateAtProgress("pending-high", "pending-high-event", 9),
    ];
    const runtime = marketRuntime();
    const baseGetOrderBook = runtime.getOrderBook;
    const { app, candidates } = makeTestApp(candidatesInScanOrder, {
      marketStream: {
        ...runtime,
        getOrderBook: (candidate) => {
          const book = baseGetOrderBook?.(candidate);
          if (book === null || book === undefined) return null;
          return {
            ...book,
            asks: [
              {
                priceMicros: candidate.tokenId.startsWith("ready-")
                  ? 20_000
                  : 40_000,
                sizeMicros: 100_000_000,
              },
            ],
          };
        },
      },
    });
    await candidates.refresh();

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard?limit=20",
    });

    expect(
      dashboard
        .json()
        .marketScan.events.map((event: { eventId: string }) => event.eventId),
    ).toEqual([
      "ready-low-event",
      "ready-high-event",
      "pending-low-event",
      "pending-high-event",
    ]);

    const saved = await app.inject({
      method: "PUT",
      url: "/api/test/preferences",
      payload: {
        marketTypes: ["BINARY", "TERNARY"],
        allCategories: true,
        selectedCategoryIds: [],
        maxBuyPriceCents: 3,
        minBidAskRatioPercent: 50,
        maxMarketProgressPercent: 20,
        minMarketDurationDays: 1,
        maxMarketDurationDays: 30,
        candidateSortDirection: "DESC",
        initialCapital: 100,
        orderAmount: 1,
      },
    });
    expect(saved.statusCode).toBe(200);

    const descendingDashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard?limit=20",
    });
    expect(
      descendingDashboard
        .json()
        .marketScan.events.map((event: { eventId: string }) => event.eventId),
    ).toEqual([
      "ready-high-event",
      "ready-low-event",
      "pending-high-event",
      "pending-low-event",
    ]);
  });

  it("keeps a last-known eligible market visible but not tradable while quotes reconnect", async () => {
    const candidate = makeCurrentCandidate();
    const connectedRuntime = marketRuntime();
    const reconnectingRuntime: PaperMarketRuntime = {
      ...connectedRuntime,
      getStatus: () => ({
        ...connectedRuntime.getStatus(),
        connected: false,
        dataCompleteTokenCount: 0,
        unexpectedDisconnectCount: 1,
      }),
      isTokenReady: () => false,
      getQuoteStatus: () => "RECONNECTING",
    };
    const { app, candidates } = makeTestApp([candidate], {
      marketStream: reconnectingRuntime,
    });
    await candidates.refresh();
    candidates.updateQuote(candidate.tokenId, null, null, false);

    const response = await app.inject({ method: "GET", url: "/api/dashboard" });

    expect(response.json().marketScan).toMatchObject({
      candidateCount: 0,
      displayCandidateCount: 1,
      staleCandidateCount: 1,
      displayedCandidateCount: 1,
      candidates: [
        expect.objectContaining({
          tokenId: candidate.tokenId,
          executableBuyPrice: "0.03",
          tradable: false,
          quoteStatus: "RECONNECTING",
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
        marketTypes: ["BINARY", "TERNARY"],
        allCategories: false,
        selectedCategoryIds: ["tag-tech"],
        minBuyPriceCents: 0.6,
        maxBuyPriceCents: 99,
        targetSellPriceIncreaseCents: 0.125,
        targetSellPriceMultiplier: 1.812345,
        minBidAskRatioPercent: 60,
        maxMarketProgressPercent: 15,
        minMarketDurationDays: 7,
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
        minBuyPriceCents: 0.6,
        maxBuyPriceCents: 99,
        targetSellPriceIncreaseCents: 0.125,
        targetSellPriceMultiplier: 1.812345,
        minBidAskRatioPercent: 60,
        maxMarketProgressPercent: 15,
        minMarketDurationDays: 7,
        maxMarketDurationDays: 30,
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
        marketTypes: ["BINARY", "TERNARY"],
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

  it("rejects a configuration that disables every market type", async () => {
    const { app, tradingPreferences } = makeTestApp([]);

    const response = await app.inject({
      method: "PUT",
      url: "/api/test/preferences",
      payload: {
        marketTypes: [],
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
    expect(tradingPreferences.getSnapshot().marketTypes).toEqual([
      "BINARY",
      "TERNARY",
    ]);
  });

  it("round-trips a multi-only market type selection through the API", async () => {
    const { app } = makeTestApp([]);

    const saved = await app.inject({
      method: "PUT",
      url: "/api/test/preferences",
      payload: {
        marketTypes: ["MULTI"],
        allCategories: true,
        selectedCategoryIds: [],
        maxBuyPriceCents: 3,
        minMarketDurationDays: 1,
        maxMarketDurationDays: 30,
        candidateSortDirection: "ASC",
        initialCapital: 100,
        orderAmount: 1,
      },
    });
    const restored = await app.inject({
      method: "GET",
      url: "/api/test/preferences",
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().preferences.marketTypes).toEqual(["MULTI"]);
    expect(restored.json().preferences.marketTypes).toEqual(["MULTI"]);
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

  it("rejects a manual TEST request for a non-Winner sibling Token", async () => {
    const winner = makeCurrentCandidate({
      candidateId: "manual-winner:20000",
      tokenId: "manual-winner",
      conditionId: "manual-winner-condition",
      marketId: "a-manual-market",
      bestAskMicros: 20_000,
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
    });
    const sibling = makeCurrentCandidate({
      candidateId: "manual-loser:20000",
      tokenId: "manual-loser",
      conditionId: "manual-loser-condition",
      marketId: "z-manual-market",
      bestAskMicros: 20_000,
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
    });
    const { app, candidates, database } = makeTestApp([winner, sibling], {
      marketStream: marketRuntime(),
    });
    await candidates.refresh();
    await app.inject({ method: "POST", url: "/api/test/start" });

    const response = await app.inject({
      method: "POST",
      url: "/api/test/orders/buy",
      payload: { candidateId: sibling.candidateId },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Candidate is not the current Event winner",
    });
    expect(database.listPaperOrders()).toEqual([]);
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
        positionValue: "0",
        totalPnl: "-1",
        unrealizedPnl: "-1",
      },
      positions: [
        expect.objectContaining({
          tokenId: candidate.tokenId,
          eventLockState: "ACTIVE",
          activeTokenId: candidate.tokenId,
          cycleStatus: "ACCUMULATING",
          cycleBudget: "1",
          cycleSpent: "1",
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
      config: {
        ...testConfig,
        initialCapitalMicros: 120_000_000,
        totalBudgetMicros: 120_000_000,
        orderBudgetMicros: 2_000_000,
        minMarketDurationDays: 7,
        maxMarketDurationDays: 60,
        minBuyPriceMicros: 5_000,
        maxBuyPriceMicros: 100_000,
        targetSellPriceIncreaseMicros: 20_000,
        targetSellPriceMultiplierMicros: 2_000_000,
        minBidAskRatioPercent: 40,
        maxMarketProgressPercent: 30,
      },
    });
    await candidates.refresh();
    await app.inject({ method: "POST", url: "/api/test/start" });
    const buy = await app.inject({
      method: "POST",
      url: "/api/test/orders/buy",
      payload: { candidateId: candidate.candidateId },
    });
    expect(buy.statusCode, buy.body).toBe(201);

    const recordsBeforeReset = await app.inject({
      method: "GET",
      url: "/api/test/trade-records?limit=20",
    });
    expect(recordsBeforeReset.json()).toMatchObject({
      totalCount: 1,
      records: [{ type: "OPEN" }],
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
        marketTypes: ["BINARY", "TERNARY"],
        allCategories: true,
        selectedCategoryIds: [],
        maxBuyPriceCents: 3,
        maxMarketDurationDays: 30,
        candidateSortDirection: "ASC",
        initialCapital: 130,
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
      preferences: {
        orderAmount: "1",
        minBuyPriceCents: 0.1,
        maxBuyPriceCents: 99,
        targetSellPriceIncreaseCents: 1,
        targetSellPriceMultiplier: 1.5,
        minBidAskRatioPercent: 50,
        minMarketDurationDays: 1,
        maxMarketDurationDays: 30,
        maxMarketProgressPercent: 20,
      },
    });
    expect(database.listPaperOrders()).toEqual([]);
    expect(database.listPaperPositions()).toEqual([]);
    const recordsAfterReset = await app.inject({
      method: "GET",
      url: "/api/test/trade-records?limit=20",
    });
    expect(recordsAfterReset.json()).toEqual({ totalCount: 0, records: [] });
  });

  it("serves the compact single-column TEST UI without per-market participation controls", async () => {
    const { app } = makeTestApp([]);
    const page = await app.inject({ method: "GET", url: "/" });

    expect(page.body).toContain('id="mode-toggle"');
    expect(page.body).toMatch(/id="mode-toggle"[\s\S]*?>TEST<\/button>/);
    expect(page.body).not.toContain('id="test-mode"');
    expect(page.body).not.toContain('id="live-mode"');
    expect(page.body).toMatch(/id="run-toggle"[\s\S]*?>START<\/button>/);
    expect(page.body).toContain("交易配置");
    expect(page.body).toContain("市场类别");
    expect(page.body).toContain("全选");
    expect(page.body).toContain("最低买卖盘比例");
    expect(page.body).toContain("生命周期进度");
    expect(page.body).toContain("总模拟资金");
    expect(page.body).toContain("每 Event 每轮金额");
    expect(page.body).toContain("多元市场（4+）");
    expect(page.body).toContain("重置TEST");
    expect(page.body).toContain("总资金");
    expect(page.body).toContain("已实现");
    expect(page.body).toContain("未实现");
    expect(page.body).toContain("持仓价值");
    expect(page.body).toContain("单数");
    expect(page.body).toContain('id="realized-pnl"');
    expect(page.body).toContain('id="unrealized-pnl"');
    expect(page.body).toContain("当前持仓");
    expect(page.body).toContain("交易记录");
    expect(page.body).toContain("扫描事件");
    expect(page.body).toMatch(
      /id="trade-records-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="trade-records-content"/,
    );
    expect(page.body).toMatch(/id="trade-records-content"[^>]*hidden/);
    expect(page.body.indexOf("当前持仓")).toBeLessThan(
      page.body.indexOf("交易记录"),
    );
    expect(page.body.indexOf("交易记录")).toBeLessThan(
      page.body.indexOf("扫描事件"),
    );
    expect(page.body).toContain('id="scan-refresh-state"');
    expect(page.body).toContain('id="position-list-controls"');
    expect(page.body).toContain('id="toggle-positions"');
    expect(page.body.match(/data-sort-toggle/g)).toHaveLength(1);
    expect(page.body).toMatch(/data-sort-toggle[\s\S]*?<strong aria-hidden="true">↑<\/strong><\/button>/);
    expect(page.body).not.toContain("<span>进度</span>");
    expect(page.body).not.toContain('data-sort="ASC"');
    expect(page.body).not.toContain('data-sort="DESC"');
    expect(page.body).not.toContain("总盈亏");
    expect(page.body).not.toContain("市场选择（可多选）");
    expect(page.body).not.toContain("清空TEST交易范围");
    expect(page.body).not.toContain("进入时市场进度");
    expect(page.body).toContain('id="market-progress-filter"');
    expect(page.body).toContain('id="min-market-duration"');
    expect(page.body).toContain('id="max-market-duration"');
    expect(page.body).not.toContain('id="market-duration"');
    expect(page.body).not.toContain("开始新一轮");
    expect(page.body).not.toContain('id="new-cycle"');
    expect(page.body).not.toContain("PAPER");
  });

  it("returns recent TEST trade records as order-level position activities", async () => {
    vi.useFakeTimers();
    try {
      const { app, database } = makeTestApp([]);
      const candidate = makeCurrentCandidate({
        executableBuyPriceMicros: 20_000,
        makerBuyPriceMicros: 20_000,
        bestAskMicros: 20_000,
        fixedSellPriceMicros: 30_000,
      });
      database.setStrategyStatus("RUNNING");
      const executeBuy = (bookVersion: string) =>
        database.executeTestFakBuy({
          candidate,
          book: {
            tokenId: candidate.tokenId,
            conditionId: candidate.conditionId,
            bookVersion,
            bids: [{ priceMicros: 10_000, sizeMicros: 100_000_000 }],
            asks: [{ priceMicros: 20_000, sizeMicros: 10_000_000 }],
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

      vi.setSystemTime(new Date("2026-08-11T08:00:00.000Z"));
      expect(executeBuy("TRADE-RECORD-BUY-1").spentMicros).toBe(200_000);
      vi.setSystemTime(new Date("2026-08-11T08:01:00.000Z"));
      expect(executeBuy("TRADE-RECORD-BUY-2").spentMicros).toBe(200_000);
      vi.setSystemTime(new Date("2026-08-11T08:02:00.000Z"));
      expect(
        database.executeTestFakSells({
          tokenId: candidate.tokenId,
          bookVersion: "TRADE-RECORD-SELL-1",
          bids: [{ priceMicros: 30_000, sizeMicros: 5_000_000 }],
          minOrderSizeMicros: 5_000_000,
          feeRateMicros: 0,
          feeExponent: 1,
        }).filledSizeMicros,
      ).toBe(5_000_000);
      vi.setSystemTime(new Date("2026-08-11T08:03:00.000Z"));
      expect(
        database.executeTestFakSells({
          tokenId: candidate.tokenId,
          bookVersion: "TRADE-RECORD-SELL-2",
          bids: [{ priceMicros: 30_000, sizeMicros: 15_000_000 }],
          minOrderSizeMicros: 5_000_000,
          feeRateMicros: 0,
          feeExponent: 1,
        }).filledSizeMicros,
      ).toBe(15_000_000);

      const response = await app.inject({
        method: "GET",
        url: "/api/test/trade-records?limit=20",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ totalCount: 5 });
      expect(
        response.json().records.map((record: Record<string, unknown>) => ({
          type: record.type,
          quantity: record.quantity,
          price: record.price,
          amount: record.amount,
          realizedPnl: record.realizedPnl,
          eventTitle: record.eventTitle,
          marketQuestion: record.marketQuestion,
          direction: record.direction,
        })),
      ).toEqual([
        {
          type: "CLOSE",
          quantity: "10",
          price: "0.03",
          amount: "0.3",
          realizedPnl: "0.1",
          eventTitle: candidate.eventTitle,
          marketQuestion: candidate.marketQuestion,
          direction: "YES",
        },
        {
          type: "PARTIAL_CLOSE",
          quantity: "5",
          price: "0.03",
          amount: "0.15",
          realizedPnl: "0.05",
          eventTitle: candidate.eventTitle,
          marketQuestion: candidate.marketQuestion,
          direction: "YES",
        },
        {
          type: "PARTIAL_CLOSE",
          quantity: "5",
          price: "0.03",
          amount: "0.15",
          realizedPnl: "0.05",
          eventTitle: candidate.eventTitle,
          marketQuestion: candidate.marketQuestion,
          direction: "YES",
        },
        {
          type: "ADD",
          quantity: "10",
          price: "0.02",
          amount: "0.2",
          realizedPnl: null,
          eventTitle: candidate.eventTitle,
          marketQuestion: candidate.marketQuestion,
          direction: "YES",
        },
        {
          type: "OPEN",
          quantity: "10",
          price: "0.02",
          amount: "0.2",
          realizedPnl: null,
          eventTitle: candidate.eventTitle,
          marketQuestion: candidate.marketQuestion,
          direction: "YES",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps separate sell executions from the same millisecond as separate trade records", async () => {
    vi.useFakeTimers();
    try {
      const { app, database } = makeTestApp([]);
      const candidate = makeCurrentCandidate({
        executableBuyPriceMicros: 20_000,
        makerBuyPriceMicros: 20_000,
        bestAskMicros: 20_000,
        fixedSellPriceMicros: 30_000,
      });
      database.setStrategyStatus("RUNNING");
      vi.setSystemTime(new Date("2026-08-11T08:15:00.000Z"));

      expect(
        database.executeTestFakBuy({
          candidate,
          book: {
            tokenId: candidate.tokenId,
            conditionId: candidate.conditionId,
            bookVersion: "TRADE-RECORD-SAME-MS-BUY",
            bids: [{ priceMicros: 10_000, sizeMicros: 100_000_000 }],
            asks: [{ priceMicros: 20_000, sizeMicros: 20_000_000 }],
            minOrderSizeMicros: 5_000_000,
            tickSizeMicros: 10_000,
            isNegativeRisk: false,
          },
          maxPriceMicros: 30_000,
          orderBudgetMicros: 1_000_000,
          eligibility: testEligibilitySettings(),
          feeRateMicros: 0,
          feeExponent: 1,
        }).spentMicros,
      ).toBe(400_000);
      expect(
        database.executeTestFakSells({
          tokenId: candidate.tokenId,
          bookVersion: "TRADE-RECORD-SAME-MS-SELL-1",
          bids: [{ priceMicros: 30_000, sizeMicros: 5_000_000 }],
          minOrderSizeMicros: 5_000_000,
          feeRateMicros: 0,
          feeExponent: 1,
        }).filledSizeMicros,
      ).toBe(5_000_000);
      expect(
        database.executeTestFakSells({
          tokenId: candidate.tokenId,
          bookVersion: "TRADE-RECORD-SAME-MS-SELL-2",
          bids: [{ priceMicros: 30_000, sizeMicros: 15_000_000 }],
          minOrderSizeMicros: 5_000_000,
          feeRateMicros: 0,
          feeExponent: 1,
        }).filledSizeMicros,
      ).toBe(15_000_000);

      const response = await app.inject({
        method: "GET",
        url: "/api/test/trade-records?limit=20",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ totalCount: 3 });
      expect(
        response.json().records.map((record: Record<string, unknown>) => ({
          type: record.type,
          quantity: record.quantity,
        })),
      ).toEqual([
        { type: "CLOSE", quantity: "15" },
        { type: "PARTIAL_CLOSE", quantity: "5" },
        { type: "OPEN", quantity: "20" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("combines one TEST order's multi-level fills into one trade record", async () => {
    vi.useFakeTimers();
    try {
      const { app, database } = makeTestApp([]);
      const candidate = makeCurrentCandidate({
        executableBuyPriceMicros: 20_000,
        makerBuyPriceMicros: 20_000,
        bestAskMicros: 20_000,
      });
      database.setStrategyStatus("RUNNING");
      vi.setSystemTime(new Date("2026-08-11T08:30:00.000Z"));

      const result = database.executeTestFakBuy({
        candidate,
        book: {
          tokenId: candidate.tokenId,
          conditionId: candidate.conditionId,
          bookVersion: "TRADE-RECORD-MULTI-LEVEL-BUY",
          bids: [{ priceMicros: 10_000, sizeMicros: 100_000_000 }],
          asks: [
            { priceMicros: 20_000, sizeMicros: 5_000_000 },
            { priceMicros: 30_000, sizeMicros: 5_000_000 },
          ],
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
      expect(result.spentMicros).toBe(250_000);

      const response = await app.inject({
        method: "GET",
        url: "/api/test/trade-records?limit=20",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        totalCount: 1,
        records: [
          {
            type: "OPEN",
            quantity: "10",
            price: "0.025",
            amount: "0.25",
            occurredAt: "2026-08-11T08:30:00.000Z",
          },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes cached trade records with fee-adjusted quantities and proceeds", async () => {
    vi.useFakeTimers();
    try {
      const { app, database } = makeTestApp([]);
      const candidate = makeCurrentCandidate({
        executableBuyPriceMicros: 20_000,
        makerBuyPriceMicros: 20_000,
        bestAskMicros: 20_000,
        fixedSellPriceMicros: 30_000,
      });
      database.setStrategyStatus("RUNNING");
      vi.setSystemTime(new Date("2026-08-11T08:40:00.000Z"));

      const buy = database.executeTestFakBuy({
        candidate,
        book: {
          tokenId: candidate.tokenId,
          conditionId: candidate.conditionId,
          bookVersion: "TRADE-RECORD-FEE-BUY",
          bids: [{ priceMicros: 10_000, sizeMicros: 100_000_000 }],
          asks: [{ priceMicros: 20_000, sizeMicros: 10_000_000 }],
          minOrderSizeMicros: 5_000_000,
          tickSizeMicros: 10_000,
          isNegativeRisk: false,
        },
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        eligibility: testEligibilitySettings(),
        feeRateMicros: 50_000,
        feeExponent: 1,
      });
      expect(buy).toMatchObject({
        spentMicros: 200_000,
        feeMicros: 9_800,
        createdSellOrders: [{ originalSizeMicros: 9_510_000 }],
      });

      const afterBuy = await app.inject({
        method: "GET",
        url: "/api/test/trade-records?limit=20",
      });
      expect(afterBuy.json()).toMatchObject({
        totalCount: 1,
        records: [
          {
            type: "OPEN",
            quantity: "9.51",
            amount: "0.2",
            realizedPnl: null,
          },
        ],
      });

      vi.setSystemTime(new Date("2026-08-11T08:41:00.000Z"));
      const sell = database.executeTestFakSells({
        tokenId: candidate.tokenId,
        bookVersion: "TRADE-RECORD-FEE-SELL",
        bids: [{ priceMicros: 30_000, sizeMicros: 9_510_000 }],
        minOrderSizeMicros: 5_000_000,
        feeRateMicros: 50_000,
        feeExponent: 1,
      });
      expect(sell).toMatchObject({
        filledSizeMicros: 9_510_000,
        grossProceedsMicros: 285_300,
        feeMicros: 13_838,
        netProceedsMicros: 271_462,
      });

      const afterSell = await app.inject({
        method: "GET",
        url: "/api/test/trade-records?limit=20",
      });
      expect(afterSell.json()).toMatchObject({
        totalCount: 2,
        records: [
          {
            type: "CLOSE",
            quantity: "9.51",
            amount: "0.271462",
            realizedPnl: "0.071462",
          },
          { type: "OPEN", quantity: "9.51", amount: "0.2" },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes completed position settlements in recent TEST trade records", async () => {
    vi.useFakeTimers();
    try {
      const { app, database } = makeTestApp([]);
      const candidate = makeCurrentCandidate({
        executableBuyPriceMicros: 20_000,
        makerBuyPriceMicros: 20_000,
        bestAskMicros: 20_000,
      });
      database.setStrategyStatus("RUNNING");
      vi.setSystemTime(new Date("2026-08-11T09:00:00.000Z"));
      database.executeTestFakBuy({
        candidate,
        book: {
          tokenId: candidate.tokenId,
          conditionId: candidate.conditionId,
          bookVersion: "TRADE-RECORD-SETTLEMENT-BUY",
          bids: [{ priceMicros: 10_000, sizeMicros: 100_000_000 }],
          asks: [{ priceMicros: 20_000, sizeMicros: 10_000_000 }],
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
      const beforeSettlement = await app.inject({
        method: "GET",
        url: "/api/test/trade-records?limit=20",
      });
      expect(beforeSettlement.json()).toMatchObject({
        totalCount: 1,
        records: [{ type: "OPEN", amount: "0.2" }],
      });
      database.applyPaperSettlement({
        target: {
          conditionId: candidate.conditionId,
          marketId: candidate.marketId,
          eventId: candidate.eventId,
        },
        closed: true,
        resolutionStatus: "resolved",
        winningTokenId: candidate.tokenId,
        winningOutcome: "Yes",
        now: new Date("2026-08-11T09:01:00.000Z"),
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/test/trade-records?limit=20",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        totalCount: 2,
        records: [
          {
            type: "SETTLEMENT",
            tokenId: candidate.tokenId,
            direction: "YES",
            amount: "10",
            realizedPnl: "9.8",
            settlementOutcome: "WIN",
            winningOutcome: "Yes",
            occurredAt: "2026-08-11T09:01:00.000Z",
          },
          { type: "OPEN", amount: "0.2" },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds cached trade records when an older settlement is backfilled later", async () => {
    vi.useFakeTimers();
    try {
      const { app, database } = makeTestApp([]);
      const recentCandidate = makeCurrentCandidate({
        executableBuyPriceMicros: 20_000,
        makerBuyPriceMicros: 20_000,
        bestAskMicros: 20_000,
      });
      const backfilledCandidate = makeCurrentCandidate({
        candidateId: "backfilled-token:20000",
        tokenId: "backfilled-token",
        conditionId: "backfilled-condition",
        marketId: "backfilled-market",
        eventId: "backfilled-event",
        eventSlug: "backfilled-event",
        eventTitle: "Backfilled event",
        marketQuestion: "Was this settlement backfilled?",
        executableBuyPriceMicros: 20_000,
        makerBuyPriceMicros: 20_000,
        bestAskMicros: 20_000,
      });
      const executeBuy = (candidate: TradeCandidate, bookVersion: string) =>
        database.executeTestFakBuy({
          candidate,
          book: {
            tokenId: candidate.tokenId,
            conditionId: candidate.conditionId,
            bookVersion,
            bids: [{ priceMicros: 10_000, sizeMicros: 100_000_000 }],
            asks: [{ priceMicros: 20_000, sizeMicros: 10_000_000 }],
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
      const settle = (candidate: TradeCandidate, now: Date) =>
        database.applyPaperSettlement({
          target: {
            conditionId: candidate.conditionId,
            marketId: candidate.marketId,
            eventId: candidate.eventId,
          },
          closed: true,
          resolutionStatus: "resolved",
          winningTokenId: candidate.tokenId,
          winningOutcome: "Yes",
          now,
        });

      database.setStrategyStatus("RUNNING");
      vi.setSystemTime(new Date("2026-08-11T08:50:00.000Z"));
      executeBuy(backfilledCandidate, "TRADE-RECORD-BACKFILL-BUY");
      vi.setSystemTime(new Date("2026-08-11T09:00:00.000Z"));
      executeBuy(recentCandidate, "TRADE-RECORD-RECENT-BUY");
      settle(recentCandidate, new Date("2026-08-11T09:10:00.000Z"));

      const beforeBackfill = await app.inject({
        method: "GET",
        url: "/api/test/trade-records?limit=20",
      });
      expect(beforeBackfill.json()).toMatchObject({ totalCount: 3 });

      settle(backfilledCandidate, new Date("2026-08-11T09:20:00.000Z"));
      // Model an imported/backfilled row: its event time is old while the
      // monotonic update time still reflects when it reached this database.
      database["database"]
        .prepare(
          "UPDATE paper_settlements SET settled_at = ? WHERE condition_id = ?",
        )
        .run(
          "2026-08-11T08:55:00.000Z",
          backfilledCandidate.conditionId,
        );

      const response = await app.inject({
        method: "GET",
        url: "/api/test/trade-records?limit=20",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        totalCount: 4,
        records: [
          {
            type: "SETTLEMENT",
            conditionId: recentCandidate.conditionId,
            occurredAt: "2026-08-11T09:10:00.000Z",
          },
          { type: "OPEN", conditionId: recentCandidate.conditionId },
          {
            type: "SETTLEMENT",
            conditionId: backfilledCandidate.conditionId,
            occurredAt: "2026-08-11T08:55:00.000Z",
          },
          { type: "OPEN", conditionId: backfilledCandidate.conditionId },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
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
        eventId: `partial-event-${index}`,
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
    options: {
      marketStream?: PaperMarketRuntime;
      config?: typeof testConfig;
    } = {},
  ) {
    const config = options.config ?? testConfig;
    const scanner: CandidateScanner = { scan: async () => scannedCandidates };
    const candidates = new CandidateService(scanner, 15_000);
    const database = new PaperDatabase(":memory:", config.initialCapitalMicros);
    const tradingPreferences = new PaperTradingPreferencesService(
      database,
      config,
    );
    const eventOpportunities =
      options.marketStream === undefined
        ? null
        : new EventOpportunityService(
            candidates,
            database,
            options.marketStream,
            config,
            tradingPreferences,
          );
    const app = buildApp({
      config,
      database,
      candidates,
      tradingPreferences,
      liveExecutor: new LiveExecutorDisabled(),
      ...(options.marketStream === undefined
        ? {}
        : {
            marketStream: options.marketStream,
            paperAutomation: {
              getStatus: () => ({
                running: false,
                lastRunAt: null,
                lastError: null,
                placedBuyCount: 0,
                cancelledFilterBuyCount: 0,
                cancelledStartedBuyCount: 0,
                cancelledProgressedBuyCount: 0,
                eventsEvaluatedCount: 0,
                incompleteEventCount: 0,
                arbitrationCount: 0,
                arbitrationRecomputeCount: 0,
                staleArbitrationRejectionCount: 0,
                skippedLockedSiblingQuoteCount: 0,
                maxObservedResultCount: 0,
                recovery: null,
              }),
              getEventEvaluations: () =>
                candidates
                  .getEventIds()
                  .map((eventId) =>
                    eventOpportunities!.evaluateEvent(eventId),
                  ),
              requestRun: () => {},
            },
          }),
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
