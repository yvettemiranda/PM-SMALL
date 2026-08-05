import { afterEach, describe, expect, it } from "vitest";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { PaperTradingPreferencesService } from "../src/services/paper-trading-preferences-service.js";
import { makeCandidate, testConfig } from "./helpers.js";

describe("PaperTradingPreferencesService", () => {
  const databases: PaperDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it("persists market filters and candidate selection overrides", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    const preferences = new PaperTradingPreferencesService(database, testConfig);

    expect(preferences.getSnapshot()).toMatchObject({
      resultCounts: [2, 3],
      maxBuyPriceMicros: 30_000,
      maxMarketDurationDays: 30,
      candidatesSelectedByDefault: true,
    });

    preferences.updateMarketFilters({
      resultCounts: [3],
      maxBuyPriceMicros: 30_000,
      maxMarketDurationDays: 60,
    });
    preferences.setAllCandidatesSelected(false);
    preferences.setCandidateSelected("selected-token", true);

    const restored = new PaperTradingPreferencesService(database, testConfig);
    expect(restored.getSnapshot()).toMatchObject({
      resultCounts: [3],
      maxBuyPriceMicros: 30_000,
      maxMarketDurationDays: 60,
      candidatesSelectedByDefault: false,
    });
    expect(restored.isTokenSelected("selected-token")).toBe(true);
    expect(restored.isTokenSelected("another-token")).toBe(false);
  });

  it("cancels an unfilled PAPER buy when its token is excluded", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    const preferences = new PaperTradingPreferencesService(database, testConfig);
    database.setStrategyStatus("RUNNING");
    const buy = database.placePaperBuy(makeCandidate(), 100_000_000);

    preferences.setCandidateSelected("yes-token", false);

    expect(database.listPaperOrders()).toContainEqual(
      expect.objectContaining({ id: buy.id, status: "CANCELLED" }),
    );
    expect(database.getStrategyState()).toMatchObject({
      availableCashMicros: 100_000_000,
      reservedCashMicros: 0,
    });
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
    preferences.setCandidateSelected("ternary-token", false);
    expect(preferences.isCandidateEnabled(ternary)).toBe(false);
  });

  it("fails closed instead of persisting an exclusion whose buy cannot be cancelled", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    const preferences = new PaperTradingPreferencesService(database, testConfig);
    database.setStrategyStatus("RUNNING");
    const buy = database.placePaperBuy(makeCandidate(), 100_000_000);
    database.pausePaperStrategyForValidationFailure(["Injected validation fault"]);

    expect(() => preferences.setCandidateSelected("yes-token", false)).toThrow(
      /blocked by failed validation/,
    );
    expect(preferences.isTokenSelected("yes-token")).toBe(true);
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
