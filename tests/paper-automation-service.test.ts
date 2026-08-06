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

class FakeMarketRuntime implements PaperMarketRuntime {
  public refreshCount = 0;

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

  it("places an eligible paper buy automatically while running", async () => {
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
    await waitFor(() => database.listActivePaperOrders().length === 1);

    expect(database.listActivePaperOrders()[0]).toMatchObject({
      tokenId: candidate.tokenId,
      side: "BUY",
      status: "OPEN",
    });
    expect(automation.getStatus()).toMatchObject({
      running: true,
      lastError: null,
      placedBuyCount: 1,
      recovery: { passed: true },
    });
    expect(marketStream.refreshCount).toBeGreaterThan(0);
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

  it("uses the saved TEST progress filter instead of the startup default when placing buys", async () => {
    const now = Date.now();
    const candidate = makeCandidate({
      openedAt: new Date(now - 3 * 86_400_000).toISOString(),
      endsAt: new Date(now + 7 * 86_400_000).toISOString(),
      durationDays: 10,
      progressPercent: 30,
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
      maxBuyPriceMicros: 30_000,
      maxMarketDurationDays: 30,
      maxMarketProgressPercent: 35,
    });
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

    expect(database.listActivePaperOrders()).toEqual([
      expect.objectContaining({ tokenId: candidate.tokenId, side: "BUY" }),
    ]);
  });

  it("cancels an existing buy once it falls outside the saved duration or progress filters", async () => {
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

function makeCurrentCandidate() {
  const now = Date.now();
  return makeCandidate({
    openedAt: new Date(now - 86_400_000).toISOString(),
    endsAt: new Date(now + 9 * 86_400_000).toISOString(),
    durationDays: 10,
    progressPercent: 10,
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
