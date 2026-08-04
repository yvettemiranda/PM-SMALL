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
});
