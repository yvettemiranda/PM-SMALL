import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { makeCandidate } from "./helpers.js";

describe("PaperDatabase", () => {
  let database: PaperDatabase;

  beforeEach(() => {
    database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
  });

  afterEach(() => database.close());

  it("reserves cash when placing a paper buy", () => {
    const order = database.placePaperBuy(makeCandidate(), 100_000_000);
    const state = database.getStrategyState();
    expect(order.status).toBe("OPEN");
    expect(state.availableCashMicros).toBe(99_000_000);
    expect(state.reservedCashMicros).toBe(1_000_000);
  });

  it("applies queue-aware partial fills and deduplicates trades", () => {
    const order = database.placePaperBuy(makeCandidate(), 100_000_000);

    const first = database.applyPaperTrade({
      orderId: order.id,
      sourceTradeId: "trade-1",
      tradePriceMicros: 20_000,
      tradeSizeMicros: 5_000_000,
      dataComplete: true,
    });
    expect(first.incrementalFillSizeMicros).toBe(0);

    const second = database.applyPaperTrade({
      orderId: order.id,
      sourceTradeId: "trade-2",
      tradePriceMicros: 20_000,
      tradeSizeMicros: 7_000_000,
      dataComplete: true,
    });
    expect(second.incrementalFillSizeMicros).toBe(2_000_000);
    expect(second.order.status).toBe("PARTIALLY_FILLED");

    const duplicate = database.applyPaperTrade({
      orderId: order.id,
      sourceTradeId: "trade-2",
      tradePriceMicros: 20_000,
      tradeSizeMicros: 7_000_000,
      dataComplete: true,
    });
    expect(duplicate.duplicate).toBe(true);
    expect(database.getStrategyState().positionCostMicros).toBe(40_000);
  });
});
