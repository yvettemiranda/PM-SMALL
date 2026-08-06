import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenOrderBook } from "../src/domain/types.js";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { makeCandidate } from "./helpers.js";

describe("TEST FAK accounting", () => {
  const databases: PaperDatabase[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const database of databases.splice(0)) database.close();
  });

  it("records an immediate partial buy, cancels its remainder, and creates an exit target", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
      bestAskMicros: 20_000,
      fixedSellPriceMicros: 30_000,
    });
    const book = makeBook({
      asks: [{ priceMicros: 20_000, sizeMicros: 10_000_000 }],
    });

    const result = database.executeTestFakBuy({
      candidate,
      book,
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      feeRateMicros: 0,
      feeExponent: 1,
    });

    expect(result).toMatchObject({
      outcome: "PARTIAL",
      spentMicros: 200_000,
      feeMicros: 0,
    });
    expect(result.order).toMatchObject({
      side: "BUY",
      executionKind: "FAK",
      status: "CANCELLED",
      filledSizeMicros: 10_000_000,
    });
    expect(result.createdSellOrders).toEqual([
      expect.objectContaining({
        side: "SELL",
        executionKind: "TARGET",
        priceMicros: 30_000,
        originalSizeMicros: 10_000_000,
        status: "OPEN",
      }),
    ]);
    expect(database.listActivePaperOrders().filter((order) => order.side === "BUY")).toEqual([]);
    expect(database.listPaperPositions()).toEqual([
      expect.objectContaining({
        quantityMicros: 10_000_000,
        costMicros: 200_000,
        cycleSpendMicros: 200_000,
      }),
    ]);
    expect(database.getStrategyState()).toMatchObject({
      availableCashMicros: 99_800_000,
      reservedCashMicros: 0,
      positionCostMicros: 200_000,
    });
  });

  it("enforces the per-token cycle cash cap across repeated partial FAK buys", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
      bestAskMicros: 20_000,
    });
    const book = makeBook({
      asks: [{ priceMicros: 20_000, sizeMicros: 30_000_000 }],
    });

    expect(
      database.executeTestFakBuy({
        candidate,
        book,
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        feeRateMicros: 0,
        feeExponent: 1,
      }).spentMicros,
    ).toBe(600_000);
    expect(
      database.executeTestFakBuy({
        candidate,
        book,
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        feeRateMicros: 0,
        feeExponent: 1,
      }).spentMicros,
    ).toBe(400_000);
    expect(
      database.executeTestFakBuy({
        candidate,
        book,
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        feeRateMicros: 0,
        feeExponent: 1,
      }).outcome,
    ).toBe("NO_FILL");
    expect(database.listPaperPositions()[0]).toMatchObject({
      cycleSpendMicros: 1_000_000,
      costMicros: 1_000_000,
    });
  });

  it("sells immediately at executable bids, keeps a partial remainder, and locks further buys", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
      bestAskMicros: 20_000,
      fixedSellPriceMicros: 30_000,
    });
    database.executeTestFakBuy({
      candidate,
      book: makeBook({
        asks: [{ priceMicros: 20_000, sizeMicros: 20_000_000 }],
      }),
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      feeRateMicros: 0,
      feeExponent: 1,
    });

    const sell = database.executeTestFakSells({
      tokenId: candidate.tokenId,
      bids: [{ priceMicros: 35_000, sizeMicros: 5_000_000 }],
      minOrderSizeMicros: 5_000_000,
      feeRateMicros: 0,
      feeExponent: 1,
    });

    expect(sell).toMatchObject({
      filledSizeMicros: 5_000_000,
      grossProceedsMicros: 175_000,
      netProceedsMicros: 175_000,
      feeMicros: 0,
    });
    expect(database.listPaperPositions()[0]).toMatchObject({
      quantityMicros: 15_000_000,
      costMicros: 300_000,
      firstSellAt: expect.any(String),
    });
    expect(
      database.executeTestFakBuy({
        candidate,
        book: makeBook(),
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        feeRateMicros: 0,
        feeExponent: 1,
      }).outcome,
    ).toBe("BLOCKED");
  });

  it("gives the more aggressive lower sell target first access to limited bids", () => {
    vi.useFakeTimers();
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      executableBuyPriceMicros: 30_000,
      makerBuyPriceMicros: 30_000,
      bestAskMicros: 30_000,
    });

    vi.setSystemTime(new Date("2026-08-06T00:00:00.000Z"));
    database.executeTestFakBuy({
      candidate,
      book: makeBook({
        asks: [{ priceMicros: 30_000, sizeMicros: 5_000_000 }],
      }),
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      feeRateMicros: 0,
      feeExponent: 1,
    });
    vi.setSystemTime(new Date("2026-08-06T00:00:01.000Z"));
    database.executeTestFakBuy({
      candidate,
      book: makeBook({
        asks: [{ priceMicros: 20_000, sizeMicros: 5_000_000 }],
      }),
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      feeRateMicros: 0,
      feeExponent: 1,
    });

    database.executeTestFakSells({
      tokenId: candidate.tokenId,
      bids: [{ priceMicros: 50_000, sizeMicros: 5_000_000 }],
      minOrderSizeMicros: 5_000_000,
      feeRateMicros: 0,
      feeExponent: 1,
    });

    const targetOrders = database
      .listPaperOrders()
      .filter((order) => order.side === "SELL");
    expect(targetOrders.find((order) => order.priceMicros === 30_000)).toMatchObject({
      status: "FILLED",
      filledSizeMicros: 5_000_000,
    });
    expect(targetOrders.find((order) => order.priceMicros === 50_000)).toMatchObject({
      status: "OPEN",
      filledSizeMicros: 0,
    });
  });

  it("automatically starts the next token cycle after the prior position is fully sold", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
      bestAskMicros: 20_000,
    });
    const buyInput = {
      candidate,
      book: makeBook({
        asks: [{ priceMicros: 20_000, sizeMicros: 10_000_000 }],
      }),
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      feeRateMicros: 0,
      feeExponent: 1,
    };

    expect(database.executeTestFakBuy(buyInput).spentMicros).toBe(200_000);
    expect(
      database.executeTestFakSells({
        tokenId: candidate.tokenId,
        bids: [{ priceMicros: 30_000, sizeMicros: 10_000_000 }],
        minOrderSizeMicros: 5_000_000,
        feeRateMicros: 0,
        feeExponent: 1,
      }).filledSizeMicros,
    ).toBe(10_000_000);

    const nextCycle = database.executeTestFakBuy(buyInput);

    expect(nextCycle.spentMicros).toBe(200_000);
    expect(database.listPaperPositions()[0]).toMatchObject({
      quantityMicros: 10_000_000,
      costMicros: 200_000,
      cycleSpendMicros: 200_000,
      grossBuySizeMicros: 10_000_000,
      grossBuyNotionalMicros: 200_000,
      firstSellAt: null,
      cycleClosedAt: null,
    });
    expect(
      database.listPaperOrders().filter((order) => order.side === "BUY"),
    ).toHaveLength(2);
  });

  it("changes paused TEST capital safely and performs a complete paused-only reset", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
      bestAskMicros: 20_000,
    });
    database.executeTestFakBuy({
      candidate,
      book: makeBook({
        asks: [{ priceMicros: 20_000, sizeMicros: 10_000_000 }],
      }),
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      feeRateMicros: 0,
      feeExponent: 1,
    });
    expect(() => database.updateTestInitialCapital(120_000_000)).toThrow(
      /Pause TEST/,
    );
    database.setStrategyStatus("PAUSED");
    expect(database.updateTestInitialCapital(120_000_000)).toMatchObject({
      initialCapitalMicros: 120_000_000,
      availableCashMicros: 119_800_000,
    });

    database.setStrategyStatus("RUNNING");
    expect(() => database.resetTestState(100_000_000, defaultPreferences())).toThrow(
      /Pause TEST/,
    );
    database.setStrategyStatus("PAUSED");
    expect(database.resetTestState(100_000_000, defaultPreferences())).toMatchObject({
      strategy: {
        status: "PAUSED",
        initialCapitalMicros: 100_000_000,
        availableCashMicros: 100_000_000,
        reservedCashMicros: 0,
        realizedPnlMicros: 0,
        positionCostMicros: 0,
      },
      preferences: {
        resultCounts: [2, 3],
        maxBuyPriceMicros: 30_000,
        maxMarketDurationDays: 30,
        maxMarketProgressPercent: 100,
        orderBudgetMicros: 1_000_000,
      },
    });
    expect(database.listPaperOrders()).toEqual([]);
    expect(database.listPaperPositions()).toEqual([]);
    expect(database.listPaperSettlements()).toEqual([]);
  });
});

function makeBook(overrides: Partial<TokenOrderBook> = {}): TokenOrderBook {
  return {
    tokenId: "yes-token",
    conditionId: "0xcondition",
    bids: [{ priceMicros: 35_000, sizeMicros: 100_000_000 }],
    asks: [{ priceMicros: 20_000, sizeMicros: 100_000_000 }],
    minOrderSizeMicros: 5_000_000,
    tickSizeMicros: 10_000,
    isNegativeRisk: false,
    ...overrides,
  };
}

function defaultPreferences() {
  return {
    resultCounts: [2, 3] as Array<2 | 3>,
    allCategories: true,
    selectedCategories: [],
    candidateSortDirection: "ASC" as const,
    orderBudgetMicros: 1_000_000,
    maxBuyPriceMicros: 30_000,
    maxMarketDurationDays: 30,
    maxMarketProgressPercent: 100,
    candidatesSelectedByDefault: true,
  };
}
