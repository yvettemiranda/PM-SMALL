import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads the safe paper defaults", () => {
    const config = loadConfig({});
    expect(config.initialCapitalMicros).toBe(100_000_000);
    expect(config.orderBudgetMicros).toBe(1_000_000);
    expect(config.minBuyPriceMicros).toBe(10_000);
    expect(config.maxBuyPriceMicros).toBe(30_000);
    expect(config.minBidAskRatioPercent).toBe(50);
    expect(config.minMarketDurationDays).toBe(1);
    expect(config.maxMarketDurationDays).toBe(30);
    expect(config.maxMarketProgressPercent).toBe(20);
    expect(config.paperValidationIntervalMs).toBe(60_000);
    expect(config.scanEventPageSize).toBe(100);
  });

  it("keeps the minimum buy price fixed at one cent", () => {
    expect(loadConfig({ MIN_BUY_PRICE: "0.001" }).minBuyPriceMicros).toBe(
      10_000,
    );
  });

  it("rejects a per-token budget above the total budget", () => {
    expect(() =>
      loadConfig({ ORDER_BUDGET_USD: "101", TOTAL_BUDGET_USD: "100" }),
    ).toThrow("ORDER_BUDGET_USD cannot exceed TOTAL_BUDGET_USD");
  });

  it("accepts an arbitrary whole-day market duration range", () => {
    expect(
      loadConfig({
        MIN_MARKET_DURATION_DAYS: "8",
        MAX_MARKET_DURATION_DAYS: "45",
      }),
    ).toMatchObject({
      minMarketDurationDays: 8,
      maxMarketDurationDays: 45,
    });
  });

  it("rejects a market-duration range whose minimum exceeds its maximum", () => {
    expect(() =>
      loadConfig({
        MIN_MARKET_DURATION_DAYS: "31",
        MAX_MARKET_DURATION_DAYS: "30",
      }),
    ).toThrow("MIN_MARKET_DURATION_DAYS cannot exceed MAX_MARKET_DURATION_DAYS");
  });
});
