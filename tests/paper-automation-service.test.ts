import { afterEach, describe, expect, it } from "vitest";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { CandidateService } from "../src/services/candidate-service.js";
import type {
  MarketStreamStatus,
  PaperMarketRuntime,
} from "../src/services/market-stream-service.js";
import { PaperAutomationService } from "../src/services/paper-automation-service.js";
import { PaperTradingPreferencesService } from "../src/services/paper-trading-preferences-service.js";
import { makeCandidate, testConfig } from "./helpers.js";
import type { BookLevel, TokenOrderBook, TradeCandidate } from "../src/domain/types.js";

class FakeMarketRuntime implements PaperMarketRuntime {
  public refreshCount = 0;
  public bookRevision = 1;
  public askSizeMicros = 100_000_000;
  public asks: BookLevel[] | null = null;
  public consumeLiquidity = false;
  public bids: BookLevel[] = [
    { priceMicros: 10_000, sizeMicros: 100_000_000 },
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

  public isTokenReady(): boolean {
    return true;
  }

  public getOrderBook(candidate: TradeCandidate): TokenOrderBook {
    return {
      tokenId: candidate.tokenId,
      conditionId: candidate.conditionId,
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
      resultCounts: [2, 3],
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
      resultCounts: [2, 3],
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

  it("does not use lifecycle progress as a hidden buy eligibility cut-off", async () => {
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

    expect(database.listPaperPositions()).toEqual([
      expect.objectContaining({ tokenId: candidate.tokenId, quantityMicros: expect.any(Number) }),
    ]);
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
