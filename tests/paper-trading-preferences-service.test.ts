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
      maxBuyPriceMicros: 50_000,
      maxMarketDurationDays: 60,
    });
    preferences.setAllCandidatesSelected(false);
    preferences.setCandidateSelected("selected-token", true);

    const restored = new PaperTradingPreferencesService(database, testConfig);
    expect(restored.getSnapshot()).toMatchObject({
      resultCounts: [3],
      maxBuyPriceMicros: 50_000,
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
});
