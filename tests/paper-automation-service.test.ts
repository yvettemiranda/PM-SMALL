import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { LiveExecutorDisabled } from "../src/infrastructure/execution/live-executor-disabled.js";
import { CandidateService } from "../src/services/candidate-service.js";
import type {
  MarketStreamStatus,
  PaperMarketRuntime,
} from "../src/services/market-stream-service.js";
import { PaperAutomationService } from "../src/services/paper-automation-service.js";
import { PaperTradingPreferencesService } from "../src/services/paper-trading-preferences-service.js";
import {
  makeCandidate,
  testConfig,
  testEligibilitySettings,
} from "./helpers.js";
import type { BookLevel, TokenOrderBook, TradeCandidate } from "../src/domain/types.js";

class FakeMarketRuntime implements PaperMarketRuntime {
  public refreshCount = 0;
  public bookRevision = 1;
  public askSizeMicros = 100_000_000;
  public asks: BookLevel[] | null = null;
  public consumeLiquidity = false;
  public bids: BookLevel[] = [
    { priceMicros: 20_000, sizeMicros: 100_000_000 },
  ];
  public executeTargetSellsForToken: ((tokenId: string) => void) | null = null;

  public getStatus(): MarketStreamStatus {
    return {
      running: true,
      connected: true,
      subscribedTokenCount: 0,
      dataCompleteTokenCount: 0,
      lastEventAt: null,
      processedTradeEvents: 0,
      ignoredTradeEvents: 0,
      paperBuyFillCount: 0,
      paperSellFillCount: 0,
      createdPaperSellCount: 0,
      connectionCount: 0,
      fullSnapshotCount: 0,
      unexpectedDisconnectCount: 0,
      recoveryCount: 0,
      lastFullSnapshotDurationMs: null,
      lastRecoveryDurationMs: null,
      lastError: null,
    };
  }

  public refreshSubscriptions(): void {
    this.refreshCount += 1;
  }

  public isTokenReady(_tokenId: string): boolean {
    return true;
  }

  public getOrderBook(candidate: TradeCandidate): TokenOrderBook {
    return {
      tokenId: candidate.tokenId,
      conditionId: candidate.conditionId,
      bookVersion: `FAKE-BOOK-${this.bookRevision}`,
      bids: this.bids.map((level) => ({ ...level })),
      asks:
        this.asks?.map((level) => ({ ...level })) ??
        [{ priceMicros: candidate.executableBuyPriceMicros, sizeMicros: this.askSizeMicros }],
      minOrderSizeMicros: candidate.minOrderSizeMicros,
      tickSizeMicros: candidate.tickSizeMicros,
      isNegativeRisk: candidate.isNegativeRisk,
    };
  }

  public getOrderBookRevision(): number {
    return this.bookRevision;
  }

  public consumeTestBuyLiquidity(
    _tokenId: string,
    consumedAsks: readonly BookLevel[],
  ): void {
    if (!this.consumeLiquidity || this.asks === null) return;
    for (const consumed of consumedAsks) {
      const level = this.asks.find(
        (item) => item.priceMicros === consumed.priceMicros,
      );
      if (level !== undefined) {
        level.sizeMicros = Math.max(0, level.sizeMicros - consumed.sizeMicros);
      }
    }
    this.asks = this.asks.filter((level) => level.sizeMicros > 0);
  }

  public executeTargetSells(tokenId: string): void {
    this.executeTargetSellsForToken?.(tokenId);
  }
}

class FlippingWinnerRuntime extends FakeMarketRuntime {
  private orderBookCallCount = 0;

  public override getOrderBook(candidate: TradeCandidate): TokenOrderBook {
    this.orderBookCallCount += 1;
    const secondEvaluation = this.orderBookCallCount > 2;
    const firstOption = candidate.tokenId === "stale-first";
    const bestBidMicros = secondEvaluation === firstOption ? 10_000 : 20_000;
    return {
      tokenId: candidate.tokenId,
      conditionId: candidate.conditionId,
      bookVersion: secondEvaluation ? "RECHECKED" : "INITIAL",
      bids: [{ priceMicros: bestBidMicros, sizeMicros: 100_000_000 }],
      asks: [{ priceMicros: 20_000, sizeMicros: 100_000_000 }],
      minOrderSizeMicros: candidate.minOrderSizeMicros,
      tickSizeMicros: candidate.tickSizeMicros,
      isNegativeRisk: candidate.isNegativeRisk,
    };
  }

  public override getOrderBookRevision(): number {
    return this.orderBookCallCount > 2 ? 2 : 1;
  }
}

describe("PaperAutomationService", () => {
  const resources: Array<{
    close?: () => void;
    stop?: () => Promise<void>;
  }> = [];

  afterEach(async () => {
    for (const resource of resources.splice(0).reverse()) {
      await resource.stop?.();
      resource.close?.();
    }
  });

  it("executes an eligible TEST FAK buy automatically while running", async () => {
    const candidate = makeCurrentCandidate();
    const candidates = new CandidateService(
      { scan: async () => [candidate] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const marketStream = new FakeMarketRuntime();
    const automation = new PaperAutomationService(
      candidates,
      database,
      marketStream,
      { ...testConfig, paperSchedulerIntervalMs: 10 },
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(() => database.listPaperPositions().length === 1);

    expect(database.listPaperOrders().find((order) => order.side === "BUY")).toMatchObject({
      tokenId: candidate.tokenId,
      side: "BUY",
      executionKind: "FAK",
      status: "CANCELLED",
    });
    expect(database.listActivePaperOrders().filter((order) => order.side === "BUY")).toEqual([]);
    expect(automation.getStatus()).toMatchObject({
      running: true,
      lastError: null,
      placedBuyCount: 1,
      recovery: { passed: true },
    });
    expect(marketStream.refreshCount).toBeGreaterThan(0);
  });

  it("rechecks the same book for an immediately executable target after buying", async () => {
    const candidate = makeCurrentCandidate({
      bestAskMicros: 20_000,
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
    });
    const candidates = new CandidateService(
      { scan: async () => [candidate] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const marketStream = new FakeMarketRuntime();
    marketStream.bids = [
      { priceMicros: 35_000, sizeMicros: 100_000_000 },
    ];
    marketStream.executeTargetSellsForToken = (tokenId) => {
      database.executeTestFakSells({
        tokenId,
        bookVersion: `FAKE-BOOK-${marketStream.bookRevision}`,
        bids: marketStream.bids,
        minOrderSizeMicros: candidate.minOrderSizeMicros,
        feeRateMicros: candidate.feeRateMicros,
        feeExponent: candidate.feeExponent,
      });
    };
    const automation = new PaperAutomationService(
      candidates,
      database,
      marketStream,
      { ...testConfig, paperSchedulerIntervalMs: 60_000 },
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(() =>
      database
        .listPaperOrders()
        .some((order) => order.side === "SELL" && order.status === "FILLED"),
    );

    expect(database.listCurrentPaperPositionViews()).toEqual([]);
  });

  it("buys a monitored market as soon as its streamed ask reaches the cap", async () => {
    const candidate = makeCurrentCandidate({
      bestAskMicros: 40_000,
      executableBuyPriceMicros: 40_000,
      makerBuyPriceMicros: 40_000,
    });
    const candidates = new CandidateService(
      { scan: async () => [candidate] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const preferences = new PaperTradingPreferencesService(database, testConfig);
    const marketStream = new FakeMarketRuntime();
    const automation = new PaperAutomationService(
      candidates,
      database,
      marketStream,
      { ...testConfig, paperSchedulerIntervalMs: 10 },
      preferences,
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(() => automation.getStatus().lastRunAt !== null);
    expect(database.listPaperPositions()).toEqual([]);

    marketStream.bookRevision += 1;
    candidates.updateQuote(candidate.tokenId, 20_000, 30_000);

    await waitFor(() => database.listPaperPositions().length === 1);
    expect(database.listPaperPositions()[0]).toMatchObject({
      tokenId: candidate.tokenId,
    });
  });

  it("re-evaluates every sibling in only the changed Event after a quote update", async () => {
    const firstCandidate = makeCurrentCandidate();
    const secondCandidate = makeCurrentCandidate({
      candidateId: "second-token:30000",
      tokenId: "second-token",
    });
    const candidates = new CandidateService(
      { scan: async () => [firstCandidate, secondCandidate] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const evaluatedTokenIds: string[] = [];
    const automation = new PaperAutomationService(
      candidates,
      database,
      new FakeMarketRuntime(),
      { ...testConfig, paperSchedulerIntervalMs: 60_000 },
      {
        isCandidateEnabled: () => false,
        candidateMatchesStaticFilters: (candidate) => {
          evaluatedTokenIds.push(candidate.tokenId);
          return true;
        },
      },
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(() => evaluatedTokenIds.length >= 2);
    evaluatedTokenIds.length = 0;

    candidates.updateQuote(secondCandidate.tokenId, 10_000, 20_000);
    await waitFor(() => evaluatedTokenIds.length >= 2);

    expect(evaluatedTokenIds.sort()).toEqual(
      [firstCandidate.tokenId, secondCandidate.tokenId].sort(),
    );
  });

  it("does not re-evaluate another Event after a Token quote update", async () => {
    const firstCandidate = makeCurrentCandidate();
    const secondCandidate = makeCurrentCandidate({
      candidateId: "other-event-token:30000",
      tokenId: "other-event-token",
      eventId: "other-event",
      conditionId: "other-condition",
      marketId: "other-market",
    });
    const candidates = new CandidateService(
      { scan: async () => [firstCandidate, secondCandidate] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const evaluatedTokenIds: string[] = [];
    const automation = new PaperAutomationService(
      candidates,
      database,
      new FakeMarketRuntime(),
      { ...testConfig, paperSchedulerIntervalMs: 60_000 },
      {
        isCandidateEnabled: () => false,
        candidateMatchesStaticFilters: (candidate) => {
          evaluatedTokenIds.push(candidate.tokenId);
          return true;
        },
      },
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(() => evaluatedTokenIds.length >= 2);
    evaluatedTokenIds.length = 0;
    candidates.updateQuote(secondCandidate.tokenId, 10_000, 20_000);
    await waitFor(() => evaluatedTokenIds.length >= 1);

    expect(evaluatedTokenIds).toEqual([secondCandidate.tokenId]);
  });

  it("does not open an unlocked Event while a static sibling Book is incomplete", async () => {
    const first = makeCurrentCandidate();
    const sibling = makeCurrentCandidate({
      candidateId: "not-ready-sibling:20000",
      tokenId: "not-ready-sibling",
      conditionId: "not-ready-condition",
      marketId: "not-ready-market",
    });
    const candidates = new CandidateService(
      { scan: async () => [first, sibling] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const marketStream = new FakeMarketRuntime();
    marketStream.isTokenReady = (tokenId) => tokenId !== sibling.tokenId;
    const automation = new PaperAutomationService(
      candidates,
      database,
      marketStream,
      { ...testConfig, paperSchedulerIntervalMs: 60_000 },
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(() => automation.getStatus().lastRunAt !== null);

    expect(database.listPaperPositions()).toEqual([]);
    expect(automation.getStatus().incompleteEventCount).toBeGreaterThan(0);
  });

  it("opens only the unique Event winner when multiple siblings are executable", async () => {
    const first = makeCurrentCandidate({
      candidateId: "first-winner-option:20000",
      tokenId: "first-winner-option",
      conditionId: "first-winner-condition",
      marketId: "a-market",
    });
    const sibling = makeCurrentCandidate({
      candidateId: "second-winner-option:20000",
      tokenId: "second-winner-option",
      conditionId: "second-winner-condition",
      marketId: "b-market",
    });
    const candidates = new CandidateService(
      { scan: async () => [first, sibling] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const automation = new PaperAutomationService(
      candidates,
      database,
      new FakeMarketRuntime(),
      { ...testConfig, paperSchedulerIntervalMs: 60_000 },
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(() => database.listPaperPositions().length === 1);

    const positions = database.listPaperPositions();
    const lock = database.getPaperEventLock(first.eventId);
    expect(positions).toHaveLength(1);
    expect(lock).toMatchObject({
      state: "ACTIVE",
      activeTokenId: positions[0]?.tokenId,
    });
    expect(
      database.listPaperOrders().filter((order) => order.side === "BUY"),
    ).toHaveLength(1);
  });

  it("rejects a stale winner and executes the latest Event arbitration result", async () => {
    const first = makeCurrentCandidate({
      candidateId: "stale-first:20000",
      tokenId: "stale-first",
      conditionId: "stale-first-condition",
      marketId: "stale-first-market",
      bestAskMicros: 20_000,
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
    });
    const second = makeCurrentCandidate({
      candidateId: "fresh-second:20000",
      tokenId: "fresh-second",
      conditionId: "fresh-second-condition",
      marketId: "fresh-second-market",
      bestAskMicros: 20_000,
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
    });
    const candidates = new CandidateService(
      { scan: async () => [first, second] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const automation = new PaperAutomationService(
      candidates,
      database,
      new FlippingWinnerRuntime(),
      { ...testConfig, paperSchedulerIntervalMs: 60_000 },
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(() => database.listPaperPositions().length === 1);

    expect(database.listPaperPositions()[0]?.tokenId).toBe(second.tokenId);
    expect(automation.getStatus()).toMatchObject({
      staleArbitrationRejectionCount: 1,
      arbitrationRecomputeCount: 1,
    });
  });

  it("skips sibling quote arbitration while an Event is locked", async () => {
    const active = makeCurrentCandidate({
      candidateId: "active-option:20000",
      tokenId: "active-option",
      conditionId: "active-condition",
      marketId: "active-market",
    });
    const sibling = makeCurrentCandidate({
      candidateId: "locked-quote-sibling:20000",
      tokenId: "locked-quote-sibling",
      conditionId: "locked-quote-condition",
      marketId: "locked-quote-market",
    });
    const candidates = new CandidateService(
      { scan: async () => [active, sibling] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    database.executeTestFakBuy({
      candidate: active,
      book: {
        tokenId: active.tokenId,
        conditionId: active.conditionId,
        bookVersion: "LOCKED-INITIAL",
        bids: [{ priceMicros: 20_000, sizeMicros: 100_000_000 }],
        asks: [{ priceMicros: 20_000, sizeMicros: 5_000_000 }],
        minOrderSizeMicros: active.minOrderSizeMicros,
        tickSizeMicros: active.tickSizeMicros,
        isNegativeRisk: active.isNegativeRisk,
      },
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      feeRateMicros: 0,
      feeExponent: 1,
      eligibility: testEligibilitySettings(),
    });
    const automation = new PaperAutomationService(
      candidates,
      database,
      new FakeMarketRuntime(),
      { ...testConfig, paperSchedulerIntervalMs: 60_000 },
      { isCandidateEnabled: () => false },
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(() => automation.getStatus().lastRunAt !== null);
    const before = automation.getStatus();
    candidates.updateQuote(sibling.tokenId, 10_000, 20_000);
    const after = automation.getStatus();

    expect(after.skippedLockedSiblingQuoteCount).toBe(
      before.skippedLockedSiblingQuoteCount + 1,
    );
    expect(after.eventsEvaluatedCount).toBe(before.eventsEvaluatedCount);
  });

  it("does not place automatic buys while stopped", async () => {
    const candidates = new CandidateService(
      { scan: async () => [makeCurrentCandidate()] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    const automation = new PaperAutomationService(
      candidates,
      database,
      new FakeMarketRuntime(),
      { ...testConfig, paperSchedulerIntervalMs: 10 },
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(() => automation.getStatus().lastRunAt !== null);

    expect(database.listPaperOrders()).toHaveLength(0);
  });

  it("keeps the event loop responsive during a wide-price full refresh", async () => {
    const eventCount = 1_500;
    const scannedCandidates = Array.from({ length: eventCount }, (_, index) =>
      makeCurrentCandidate({
        candidateId: `wide-token-${index}:500000`,
        tokenId: `wide-token-${index}`,
        eventId: `wide-event-${index}`,
        conditionId: `wide-condition-${index}`,
        marketId: `wide-market-${index}`,
        bestBidMicros: 250_000,
        bestAskMicros: 500_000,
        executableBuyPriceMicros: 500_000,
        makerBuyPriceMicros: 500_000,
        fixedSellPriceMicros: 750_000,
        minOrderSizeMicros: 1_000_000,
      }),
    );
    const candidates = new CandidateService(
      { scan: async () => scannedCandidates },
      15_000,
    );
    const database = new PaperDatabase(":memory:", 100_000_000);
    const preferences = new PaperTradingPreferencesService(database, testConfig);
    preferences.updateMarketFilters({
      marketTypes: ["BINARY", "TERNARY"],
      minBuyPriceMicros: 1_000,
      maxBuyPriceMicros: 990_000,
      maxMarketDurationDays: 30,
    });
    const marketStream = new FakeMarketRuntime();
    marketStream.bids = [
      { priceMicros: 250_000, sizeMicros: 100_000_000 },
    ];
    const automation = new PaperAutomationService(
      candidates,
      database,
      marketStream,
      { ...testConfig, paperSchedulerIntervalMs: 60_000 },
      preferences,
    );
    const app = buildApp({
      config: { ...testConfig, paperSchedulerIntervalMs: 60_000 },
      database,
      candidates,
      tradingPreferences: preferences,
      liveExecutor: new LiveExecutorDisabled(),
      marketStream,
      paperAutomation: automation,
    });
    resources.push(database, automation, app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    automation.start();
    await waitFor(() => automation.getStatus().lastRunAt !== null);
    const previousRunAt = automation.getStatus().lastRunAt;
    const previousEvaluatedCount = automation.getStatus().eventsEvaluatedCount;
    database.setStrategyStatus("RUNNING");

    await candidates.refresh();
    await waitFor(
      () =>
        automation.getStatus().eventsEvaluatedCount > previousEvaluatedCount,
    );
    const inProgressEvaluatedCount =
      automation.getStatus().eventsEvaluatedCount - previousEvaluatedCount;
    expect(inProgressEvaluatedCount).toBeGreaterThan(0);
    expect(inProgressEvaluatedCount).toBeLessThan(eventCount);

    const pauseStartedAt = performance.now();
    const pauseResponse = await fetch(`${address}/api/test/pause`, {
      method: "POST",
    });
    const pauseResponseDelayMs = performance.now() - pauseStartedAt;
    expect(pauseResponse.status).toBe(200);
    expect(await pauseResponse.json()).toMatchObject({
      strategy: { mode: "TEST", status: "PAUSED" },
    });
    expect(pauseResponseDelayMs).toBeLessThan(100);
    await waitFor(() => automation.getStatus().lastRunAt !== previousRunAt);
    const cachedEvaluations = automation.getEventEvaluations();
    expect(cachedEvaluations).toHaveLength(eventCount);
    expect(cachedEvaluations[0]).not.toHaveProperty("opportunities");
    expect(cachedEvaluations[0]?.opportunityTokenIds).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(cachedEvaluations))).toBeLessThan(
      4_000_000,
    );
    expect(database.getStrategyState().status).toBe("PAUSED");
    expect(database.listPaperOrders()).toHaveLength(0);
  });

  it("waits for a complete market snapshot before placing a buy", async () => {
    const candidates = new CandidateService(
      { scan: async () => [makeCurrentCandidate()] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const marketStream = new FakeMarketRuntime();
    marketStream.isTokenReady = () => false;
    const automation = new PaperAutomationService(
      candidates,
      database,
      marketStream,
      { ...testConfig, paperSchedulerIntervalMs: 10 },
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(() => automation.getStatus().lastRunAt !== null);

    expect(database.listPaperOrders()).toHaveLength(0);
  });

  it("does not reuse the same order-book depth after a partial TEST FAK buy", async () => {
    const candidate = makeCurrentCandidate();
    const candidates = new CandidateService(
      { scan: async () => [candidate] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const marketStream = new FakeMarketRuntime();
    marketStream.askSizeMicros = 10_000_000;
    const automation = new PaperAutomationService(
      candidates,
      database,
      marketStream,
      { ...testConfig, paperSchedulerIntervalMs: 10 },
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(() => database.listPaperOrders().length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(
      database.listPaperOrders().filter((order) => order.side === "BUY"),
    ).toHaveLength(1);
    expect(database.listPaperPositions()[0]?.cycleSpendMicros).toBe(300_000);

    marketStream.bookRevision += 1;
    automation.requestRun();
    await waitFor(
      () =>
        database.listPaperOrders().filter((order) => order.side === "BUY")
          .length === 2,
    );
    expect(database.listPaperPositions()[0]?.cycleSpendMicros).toBe(600_000);
  });

  it("re-evaluates the same book revision when the saved buy-price cap changes", async () => {
    const candidate = makeCurrentCandidate({
      bestAskMicros: 20_000,
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
    });
    const candidates = new CandidateService(
      { scan: async () => [candidate] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const preferences = new PaperTradingPreferencesService(database, testConfig);
    preferences.updateMarketFilters({
      marketTypes: ["BINARY", "TERNARY"],
      maxBuyPriceMicros: 20_000,
      maxMarketDurationDays: 30,
      orderBudgetMicros: 1_000_000,
    });
    const marketStream = new FakeMarketRuntime();
    marketStream.asks = [
      { priceMicros: 20_000, sizeMicros: 5_000_000 },
      { priceMicros: 30_000, sizeMicros: 30_000_000 },
    ];
    marketStream.consumeLiquidity = true;
    const automation = new PaperAutomationService(
      candidates,
      database,
      marketStream,
      { ...testConfig, paperSchedulerIntervalMs: 10 },
      preferences,
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(
      () => database.listPaperOrders().filter((order) => order.side === "BUY").length === 1,
    );
    expect(database.listPaperPositions()[0]?.cycleSpendMicros).toBe(100_000);

    preferences.updateMarketFilters({
      marketTypes: ["BINARY", "TERNARY"],
      maxBuyPriceMicros: 30_000,
      maxMarketDurationDays: 30,
      orderBudgetMicros: 1_000_000,
    });
    automation.requestRun();

    await waitFor(
      () => database.listPaperOrders().filter((order) => order.side === "BUY").length === 2,
    );
    expect(database.listPaperPositions()[0]?.cycleSpendMicros).toBe(1_000_000);
  });

  it("retries the same book after another position releases enough cash", async () => {
    const database = new PaperDatabase(":memory:", 2_000_000);
    database.setStrategyStatus("RUNNING");
    const buyDirectly = (
      candidate: TradeCandidate,
      bookVersion: string,
      askSizeMicros: number,
    ) =>
      database.executeTestFakBuy({
        candidate,
        book: {
          tokenId: candidate.tokenId,
          conditionId: candidate.conditionId,
          bookVersion,
          bids: [{ priceMicros: 20_000, sizeMicros: 100_000_000 }],
          asks: [{ priceMicros: 20_000, sizeMicros: askSizeMicros }],
          minOrderSizeMicros: candidate.minOrderSizeMicros,
          tickSizeMicros: candidate.tickSizeMicros,
          isNegativeRisk: candidate.isNegativeRisk,
        },
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        feeRateMicros: 0,
        feeExponent: 1,
        eligibility: testEligibilitySettings(),
      });
    const committed = makeCurrentCandidate({
      candidateId: "committed-token",
      tokenId: "committed-token",
      eventId: "committed-event",
      conditionId: "committed-condition",
      marketId: "committed-market",
      bestAskMicros: 20_000,
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
    });
    const releasable = makeCurrentCandidate({
      candidateId: "releasable-token",
      tokenId: "releasable-token",
      eventId: "releasable-event",
      conditionId: "releasable-condition",
      marketId: "releasable-market",
      bestAskMicros: 20_000,
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
    });
    expect(buyDirectly(committed, "COMMITTED", 50_000_000).spentMicros).toBe(
      1_000_000,
    );
    expect(buyDirectly(releasable, "RELEASABLE", 10_000_000).spentMicros).toBe(
      200_000,
    );
    expect(database.getStrategyState().availableCashMicros).toBe(800_000);

    const candidate = makeCurrentCandidate({
      candidateId: "waiting-token",
      tokenId: "waiting-token",
      eventId: "waiting-event",
      conditionId: "waiting-condition",
      marketId: "waiting-market",
      bestAskMicros: 20_000,
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
    });
    const candidates = new CandidateService(
      { scan: async () => [candidate] },
      15_000,
    );
    await candidates.refresh();
    const marketStream = new FakeMarketRuntime();
    const automation = new PaperAutomationService(
      candidates,
      database,
      marketStream,
      { ...testConfig, paperSchedulerIntervalMs: 60_000 },
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(() => automation.getStatus().lastRunAt !== null);
    expect(
      database
        .listPaperPositions()
        .find((position) => position.tokenId === candidate.tokenId),
    ).toBeUndefined();

    database.executeTestFakSells({
      tokenId: releasable.tokenId,
      bookVersion: "RELEASABLE-SELL",
      bids: [{ priceMicros: 30_000, sizeMicros: 10_000_000 }],
      minOrderSizeMicros: releasable.minOrderSizeMicros,
      feeRateMicros: 0,
      feeExponent: 1,
    });
    expect(database.getStrategyState().availableCashMicros).toBe(1_100_000);
    automation.requestRun();

    await waitFor(() =>
      database
        .listPaperPositions()
        .some((position) => position.tokenId === candidate.tokenId),
    );
  });

  it("does not place automatic buys for a token excluded in the TEST UI", async () => {
    const candidates = new CandidateService(
      { scan: async () => [makeCurrentCandidate()] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const automation = new PaperAutomationService(
      candidates,
      database,
      new FakeMarketRuntime(),
      { ...testConfig, paperSchedulerIntervalMs: 10 },
      { isCandidateEnabled: () => false },
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(() => automation.getStatus().lastRunAt !== null);

    expect(database.listPaperOrders()).toHaveLength(0);
  });

  it("does not buy after the saved lifecycle progress limit", async () => {
    const now = Date.now();
    const candidate = makeCandidate({
      openedAt: new Date(now - 9.9 * 86_400_000).toISOString(),
      endsAt: new Date(now + 0.1 * 86_400_000).toISOString(),
      durationDays: 10,
      progressPercent: 99,
    });
    const candidates = new CandidateService(
      { scan: async () => [candidate] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const preferences = new PaperTradingPreferencesService(database, testConfig);
    const automation = new PaperAutomationService(
      candidates,
      database,
      new FakeMarketRuntime(),
      {
        ...testConfig,
        paperSchedulerIntervalMs: 10,
      },
      preferences,
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(() => automation.getStatus().lastRunAt !== null);

    expect(database.listPaperPositions()).toEqual([]);
  });

  it("cancels an existing buy whose total duration is less than one day", async () => {
    const now = Date.now();
    const shortCandidate = makeCandidate({
      openedAt: new Date(now - 5 * 60 * 60_000).toISOString(),
      endsAt: new Date(now + 5 * 60 * 60_000).toISOString(),
      durationDays: 10 / 24,
      progressPercent: 50,
    });
    const candidates = new CandidateService(
      { scan: async () => [] },
      15_000,
    );
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const buy = database.placePaperBuy(shortCandidate, 100_000_000);
    const preferences = new PaperTradingPreferencesService(database, testConfig);
    const automation = new PaperAutomationService(
      candidates,
      database,
      new FakeMarketRuntime(),
      { ...testConfig, paperSchedulerIntervalMs: 10 },
      preferences,
    );
    resources.push(database, automation);

    automation.start();
    await waitFor(() => automation.getStatus().lastRunAt !== null);

    expect(database.listPaperOrders()).toContainEqual(
      expect.objectContaining({ id: buy.id, status: "CANCELLED" }),
    );
  });
});

function makeCurrentCandidate(
  overrides: Parameters<typeof makeCandidate>[0] = {},
) {
  const now = Date.now();
  return makeCandidate({
    openedAt: new Date(now - 86_400_000).toISOString(),
    endsAt: new Date(now + 9 * 86_400_000).toISOString(),
    durationDays: 10,
    progressPercent: 10,
    ...overrides,
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
