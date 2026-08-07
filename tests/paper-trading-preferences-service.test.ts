import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { PaperTradingPreferencesService } from "../src/services/paper-trading-preferences-service.js";
import { makeCandidate, testConfig } from "./helpers.js";

describe("PaperTradingPreferencesService", () => {
  const databases: PaperDatabase[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
  });

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    vi.useRealTimers();
  });

  it("persists market filters", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    const preferences = new PaperTradingPreferencesService(database, testConfig);

    expect(preferences.getSnapshot()).toMatchObject({
      resultCounts: [2, 3],
      maxBuyPriceMicros: 30_000,
      maxMarketDurationDays: 30,
      minBidAskRatioPercent: 50,
      maxMarketProgressPercent: 20,
      candidatesSelectedByDefault: true,
    });

    preferences.updateMarketFilters({
      resultCounts: [3],
      maxBuyPriceMicros: 30_000,
      maxMarketDurationDays: 60,
      minBidAskRatioPercent: 60,
      maxMarketProgressPercent: 80,
    });
    const restored = new PaperTradingPreferencesService(database, testConfig);
    expect(restored.getSnapshot()).toMatchObject({
      resultCounts: [3],
      maxBuyPriceMicros: 30_000,
      maxMarketDurationDays: 60,
      minBidAskRatioPercent: 60,
      maxMarketProgressPercent: 80,
      candidatesSelectedByDefault: true,
    });
  });

  it("rejects a market whose total duration is less than one day", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    const preferences = new PaperTradingPreferencesService(database, {
      ...testConfig,
      maxMarketDurationDays: 1,
    });
    const now = new Date("2026-01-02T00:00:00.000Z");
    const candidate = makeCandidate({
      openedAt: "2026-01-01T18:00:00.000Z",
      endsAt: "2026-01-02T06:00:00.000Z",
      durationDays: 0.5,
      progressPercent: 50,
    });

    expect(preferences.isCandidateEnabled(candidate, now)).toBe(false);
  });

  it("persists category, order amount, and canonical progress ordering", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    const preferences = new PaperTradingPreferencesService(database, testConfig);

    preferences.updateMarketFilters({
      resultCounts: [2, 3],
      maxBuyPriceMicros: 30_000,
      maxMarketDurationDays: 30,
      allCategories: false,
      selectedCategories: ["tag-tech"],
      candidateSortDirection: "DESC",
      orderBudgetMicros: 2_000_000,
    });

    const restored = new PaperTradingPreferencesService(database, testConfig);
    expect(restored.getSnapshot()).toMatchObject({
      allCategories: false,
      selectedCategories: ["tag-tech"],
      candidateSortDirection: "DESC",
      orderBudgetMicros: 2_000_000,
    });
    expect(
      restored.isCandidateEnabled(
        makeCandidate({
          category: "Sports",
          categoryIds: ["tag-sports"],
          categoryLabels: ["Sports"],
        }),
      ),
    ).toBe(false);
    expect(
      restored
        .getOrderedCandidates([
          makeCandidate({ tokenId: "early", progressPercent: 10 }),
          makeCandidate({
            tokenId: "late",
            openedAt: "2026-01-01T00:00:00.000Z",
            endsAt: "2026-01-06T00:00:00.000Z",
            durationDays: 5,
            progressPercent: 20,
          }),
        ])
        .map((candidate) => candidate.tokenId),
    ).toEqual(["late", "early"]);
  });

  it("uses lifecycle progress as an inclusive configurable eligibility cut-off", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    const preferences = new PaperTradingPreferencesService(database, testConfig);
    const progressedCandidate = makeCandidate({ progressPercent: 35 });

    expect(preferences.isCandidateEnabled(progressedCandidate)).toBe(false);
    preferences.updateMarketFilters({
      resultCounts: [2, 3],
      maxBuyPriceMicros: 30_000,
      maxMarketDurationDays: 30,
      maxMarketProgressPercent: 40,
    });

    const restored = new PaperTradingPreferencesService(database, testConfig);
    expect(restored.getSnapshot()).toMatchObject({
      maxMarketProgressPercent: 40,
      candidatesSelectedByDefault: true,
    });
    expect(restored.isCandidateEnabled(progressedCandidate)).toBe(true);
  });

  it("applies changed market filters before a replacement scan finishes", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    const preferences = new PaperTradingPreferencesService(database, testConfig);
    const binary = makeCandidate();
    const ternary = makeCandidate({
      tokenId: "ternary-token",
      resultCount: 3,
      makerBuyPriceMicros: 30_000,
      durationDays: 60,
    });

    expect(preferences.isCandidateEnabled(binary)).toBe(true);
    preferences.updateMarketFilters({
      resultCounts: [3],
      maxBuyPriceMicros: 30_000,
      maxMarketDurationDays: 60,
    });

    expect(preferences.isCandidateEnabled(binary)).toBe(false);
    expect(preferences.isCandidateEnabled(ternary)).toBe(true);
  });

  it("cancels active PAPER buys above a newly saved price limit", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    const preferences = new PaperTradingPreferencesService(database, testConfig);
    database.setStrategyStatus("RUNNING");
    const retained = database.placePaperBuy(
      makeCandidate({ tokenId: "retained-token" }),
      100_000_000,
    );
    const excluded = database.placePaperBuy(
      makeCandidate({
        candidateId: "excluded-price-token:30000",
        tokenId: "excluded-price-token",
        conditionId: "excluded-price-condition",
        marketId: "excluded-price-market",
        makerBuyPriceMicros: 30_000,
      }),
      100_000_000,
    );

    const update = preferences.updateMarketFilters({
      resultCounts: [2, 3],
      maxBuyPriceMicros: 20_000,
      maxMarketDurationDays: 30,
    });

    expect(update.cancelledBuyCount).toBe(1);
    expect(database.listPaperOrders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: retained.id, status: "OPEN" }),
        expect.objectContaining({ id: excluded.id, status: "CANCELLED" }),
      ]),
    );
    expect(database.getStrategyState()).toMatchObject({
      availableCashMicros: 99_000_000,
      reservedCashMicros: 1_000_000,
    });
  });

  it("cancels active PAPER buys excluded by result count or total duration", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    const preferences = new PaperTradingPreferencesService(database, testConfig);
    database.setStrategyStatus("RUNNING");
    const retained = database.placePaperBuy(
      makeCandidate({ tokenId: "retained-token" }),
      100_000_000,
    );
    const excludedResultCount = database.placePaperBuy(
      makeCandidate({
        candidateId: "ternary-token:20000",
        tokenId: "ternary-token",
        conditionId: "ternary-condition",
        marketId: "ternary-market",
        resultCount: 3,
      }),
      100_000_000,
    );
    const excludedDuration = database.placePaperBuy(
      makeCandidate({
        candidateId: "long-token:20000",
        tokenId: "long-token",
        conditionId: "long-condition",
        marketId: "long-market",
        durationDays: 60,
      }),
      100_000_000,
    );
    const excludedLateProgress = database.placePaperBuy(
      makeCandidate({
        candidateId: "progressed-token:20000",
        tokenId: "progressed-token",
        conditionId: "progressed-condition",
        marketId: "progressed-market",
        openedAt: "2026-01-01T00:00:00.000Z",
        endsAt: "2026-01-02T01:00:00.000Z",
        durationDays: 25 / 24,
        progressPercent: 96,
      }),
      100_000_000,
    );

    const update = preferences.updateMarketFilters({
      resultCounts: [2],
      maxBuyPriceMicros: 30_000,
      maxMarketDurationDays: 30,
    });

    expect(update.cancelledBuyCount).toBe(3);
    expect(database.listPaperOrders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: retained.id, status: "OPEN" }),
        expect.objectContaining({
          id: excludedResultCount.id,
          status: "CANCELLED",
        }),
        expect.objectContaining({
          id: excludedDuration.id,
          status: "CANCELLED",
        }),
        expect.objectContaining({
          id: excludedLateProgress.id,
          status: "CANCELLED",
        }),
      ]),
    );
  });

  it("rolls back saved filters when an excluded buy cannot be cancelled", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    const preferences = new PaperTradingPreferencesService(database, testConfig);
    database.setStrategyStatus("RUNNING");
    const buy = database.placePaperBuy(
      makeCandidate({ makerBuyPriceMicros: 30_000 }),
      100_000_000,
    );
    database.pausePaperStrategyForValidationFailure(["Injected validation fault"]);

    expect(() =>
      preferences.updateMarketFilters({
        resultCounts: [2, 3],
        maxBuyPriceMicros: 20_000,
        maxMarketDurationDays: 30,
      }),
    ).toThrow(/blocked by failed validation/);
    expect(preferences.getSnapshot()).toMatchObject({
      resultCounts: [2, 3],
      maxBuyPriceMicros: 30_000,
      maxMarketDurationDays: 30,
    });
    expect(database.listPaperOrders()).toContainEqual(
      expect.objectContaining({ id: buy.id, status: "OPEN" }),
    );
  });

  it("rejects legacy configuration values that cannot be represented by the UI", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);

    expect(
      () =>
        new PaperTradingPreferencesService(database, {
          ...testConfig,
          maxMarketDurationDays: 45,
        }),
    ).toThrow(/supported slider value/);

    const anotherDatabase = new PaperDatabase(":memory:", 100_000_000);
    databases.push(anotherDatabase);
    expect(
      () =>
        new PaperTradingPreferencesService(anotherDatabase, {
          ...testConfig,
          maxBuyPriceMicros: 25_000,
        }),
    ).toThrow(/whole cent between 1 and 3 cents/);
  });
});
