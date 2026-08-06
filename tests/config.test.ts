import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads the safe paper defaults", () => {
    const config = loadConfig({});
    expect(config.initialCapitalMicros).toBe(100_000_000);
    expect(config.orderBudgetMicros).toBe(1_000_000);
    expect(config.minBuyPriceMicros).toBe(10_000);
    expect(config.maxBuyPriceMicros).toBe(30_000);
    expect(config.paperValidationIntervalMs).toBe(60_000);
    expect(config.scanEventPageSize).toBe(100);
  });

  it("rejects a per-token budget above the total budget", () => {
    expect(() =>
      loadConfig({ ORDER_BUDGET_USD: "101", TOTAL_BUDGET_USD: "100" }),
    ).toThrow("ORDER_BUDGET_USD cannot exceed TOTAL_BUDGET_USD");
  });

  it("rejects a startup progress default outside the 1-100 percent UI range", () => {
    expect(() => loadConfig({ MAX_MARKET_PROGRESS_PERCENT: "0" })).toThrow();
  });

  it("allows the saved filter and final buy cutoff to meet at 100 percent", () => {
    const config = loadConfig({
      MAX_MARKET_PROGRESS_PERCENT: "100",
      STOP_BUY_PROGRESS_PERCENT: "100",
    });
    expect(config.maxMarketProgressPercent).toBe(100);
    expect(config.stopBuyProgressPercent).toBe(100);
  });
});
