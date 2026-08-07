import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenOrderBook } from "../src/domain/types.js";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { makeCandidate, testEligibilitySettings } from "./helpers.js";

describe("TEST FAK accounting", () => {
  const databases: PaperDatabase[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const database of databases.splice(0)) database.close();
  });

  it("blocks every buy path when the current book violates a final eligibility rule", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({ bestAskMicros: 20_000 });
    const execute = (
      book: TokenOrderBook,
      overrides: Partial<ReturnType<typeof testEligibilitySettings>> = {},
      candidateOverride = candidate,
    ) =>
      database.executeTestFakBuy({
        candidate: candidateOverride,
        book,
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        eligibility: testEligibilitySettings(overrides),
        feeRateMicros: 0,
        feeExponent: 1,
      }).outcome;

    expect(
      execute(
        makeBook({
          bids: [{ priceMicros: 9_000, sizeMicros: 100_000_000 }],
          asks: [{ priceMicros: 9_000, sizeMicros: 100_000_000 }],
        }),
      ),
    ).toBe("BLOCKED");
    expect(execute(makeBook({ bids: [] }))).toBe("BLOCKED");
    expect(
      execute(
        makeBook({
          bids: [{ priceMicros: 10_000, sizeMicros: 100_000_000 }],
          asks: [{ priceMicros: 30_000, sizeMicros: 100_000_000 }],
        }),
      ),
    ).toBe("BLOCKED");
    expect(
      execute(
        makeBook(),
        {},
        makeCandidate({
          openedAt: "2026-01-01T00:00:00.000Z",
          endsAt: "2026-01-05T00:00:00.000Z",
          durationDays: 4,
          progressPercent: 25,
        }),
      ),
    ).toBe("BLOCKED");
    expect(database.listPaperPositions()).toEqual([]);
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
      eligibility: testEligibilitySettings(),
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

  it("keeps a fully spent multi-level FAK buy within the closed-order fill invariant", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
      bestAskMicros: 20_000,
    });

    const result = database.executeTestFakBuy({
      candidate,
      book: makeBook({
        asks: [
          { priceMicros: 20_000, sizeMicros: 10_000_000 },
          { priceMicros: 25_000, sizeMicros: 32_000_000 },
        ],
      }),
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      eligibility: testEligibilitySettings(),
      feeRateMicros: 0,
      feeExponent: 1,
    });

    expect(result).toMatchObject({ outcome: "FILLED", spentMicros: 1_000_000 });
    expect(result.order).toMatchObject({
      status: "FILLED",
      originalSizeMicros: 42_000_000,
      filledSizeMicros: 42_000_000,
    });
    expect(database.validatePaperState()).toMatchObject({ passed: true });
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
        book: { ...book, bookVersion: "CYCLE-BOOK-1" },
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        eligibility: testEligibilitySettings(),
        feeRateMicros: 0,
        feeExponent: 1,
      }).spentMicros,
    ).toBe(600_000);
    expect(
      database.executeTestFakBuy({
        candidate,
        book: { ...book, bookVersion: "CYCLE-BOOK-2" },
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        eligibility: testEligibilitySettings(),
        feeRateMicros: 0,
        feeExponent: 1,
      }).spentMicros,
    ).toBe(400_000);
    expect(
      database.executeTestFakBuy({
        candidate,
        book: { ...book, bookVersion: "CYCLE-BOOK-3" },
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        eligibility: testEligibilitySettings(),
        feeRateMicros: 0,
        feeExponent: 1,
      }).outcome,
    ).toBe("NO_FILL");
    expect(database.listPaperPositions()[0]).toMatchObject({
      cycleSpendMicros: 1_000_000,
      costMicros: 1_000_000,
    });
  });

  it("does not reuse a consumed external book version after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-book-restart-"));
    const databasePath = join(directory, "paper.db");
    const candidate = makeCandidate({
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
      bestAskMicros: 20_000,
    });
    const book = makeBook({
      bookVersion: "EXTERNAL-SNAPSHOT-1",
      asks: [{ priceMicros: 20_000, sizeMicros: 10_000_000 }],
    });
    const input = {
      candidate,
      book,
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      eligibility: testEligibilitySettings(),
      feeRateMicros: 0,
      feeExponent: 1,
    };

    const first = new PaperDatabase(databasePath, 100_000_000);
    first.setStrategyStatus("RUNNING");
    expect(first.executeTestFakBuy(input).spentMicros).toBe(200_000);
    first.close();

    const restarted = new PaperDatabase(databasePath, 100_000_000);
    try {
      expect(restarted.executeTestFakBuy(input)).toMatchObject({
        spentMicros: 0,
        order: null,
      });
      expect(
        restarted.executeTestFakBuy({
          ...input,
          book: { ...book, bookVersion: "EXTERNAL-SNAPSHOT-2" },
        }).spentMicros,
      ).toBe(200_000);
    } finally {
      restarted.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("opens fifty fully funded tokens with 100U capital and a 2U cycle cap", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");

    for (let index = 0; index < 50; index += 1) {
      const tokenId = `full-token-${index}`;
      const candidate = makeCandidate({
        candidateId: `${tokenId}:20000`,
        tokenId,
        conditionId: `condition-${index}`,
        marketId: `market-${index}`,
      });
      const result = database.executeTestFakBuy({
        candidate,
        book: {
          ...makeBook(),
          tokenId,
          conditionId: candidate.conditionId,
          bookVersion: `FULL-BOOK-${index}`,
          asks: [{ priceMicros: 20_000, sizeMicros: 100_000_000 }],
        },
        maxPriceMicros: 30_000,
        orderBudgetMicros: 2_000_000,
        eligibility: testEligibilitySettings({ orderBudgetMicros: 2_000_000 }),
        feeRateMicros: 0,
        feeExponent: 1,
      });
      expect(result.spentMicros).toBe(2_000_000);
    }

    expect(database.listCurrentPaperPositionViews()).toHaveLength(50);
    expect(database.getStrategyState()).toMatchObject({
      availableCashMicros: 0,
      positionCostMicros: 100_000_000,
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
      eligibility: testEligibilitySettings(),
      feeRateMicros: 0,
      feeExponent: 1,
    });

    const sell = database.executeTestFakSells({
      tokenId: candidate.tokenId,
      bookVersion: "TEST-BID-1",
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
        eligibility: testEligibilitySettings(),
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

    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    database.executeTestFakBuy({
      candidate,
      book: makeBook({
        asks: [{ priceMicros: 30_000, sizeMicros: 5_000_000 }],
      }),
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      eligibility: testEligibilitySettings(),
      feeRateMicros: 0,
      feeExponent: 1,
    });
    vi.setSystemTime(new Date("2026-01-02T00:00:01.000Z"));
    database.executeTestFakBuy({
      candidate,
      book: makeBook({
        asks: [{ priceMicros: 20_000, sizeMicros: 5_000_000 }],
      }),
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      eligibility: testEligibilitySettings(),
      feeRateMicros: 0,
      feeExponent: 1,
    });

    database.executeTestFakSells({
      tokenId: candidate.tokenId,
      bookVersion: "TEST-BID-2",
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
      eligibility: testEligibilitySettings(),
      feeRateMicros: 0,
      feeExponent: 1,
    };

    expect(database.executeTestFakBuy(buyInput).spentMicros).toBe(200_000);
    expect(
      database.executeTestFakSells({
        tokenId: candidate.tokenId,
        bookVersion: "TEST-BID-3",
        bids: [{ priceMicros: 30_000, sizeMicros: 10_000_000 }],
        minOrderSizeMicros: 5_000_000,
        feeRateMicros: 0,
        feeExponent: 1,
      }).filledSizeMicros,
    ).toBe(10_000_000);

    const nextCycle = database.executeTestFakBuy({
      ...buyInput,
      book: { ...buyInput.book, bookVersion: "NEXT-CYCLE-BOOK" },
    });

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

  it("keeps a closed cycle closed until enough cash exists to fund the configured amount", () => {
    const database = new PaperDatabase(":memory:", 1_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const firstCandidate = makeCandidate({
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
      bestAskMicros: 20_000,
    });
    const executeBuy = (
      candidate: ReturnType<typeof makeCandidate>,
      bookVersion: string,
      askSizeMicros: number,
    ) =>
      database.executeTestFakBuy({
        candidate,
        book: makeBook({
          tokenId: candidate.tokenId,
          conditionId: candidate.conditionId,
          bookVersion,
          asks: [{ priceMicros: 20_000, sizeMicros: askSizeMicros }],
        }),
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        eligibility: testEligibilitySettings(),
        feeRateMicros: 0,
        feeExponent: 1,
      });

    expect(executeBuy(firstCandidate, "FIRST-CYCLE", 10_000_000).spentMicros).toBe(
      200_000,
    );
    expect(
      database.executeTestFakSells({
        tokenId: firstCandidate.tokenId,
        bookVersion: "FIRST-CYCLE-SELL",
        bids: [{ priceMicros: 30_000, sizeMicros: 10_000_000 }],
        minOrderSizeMicros: 5_000_000,
        feeRateMicros: 1_000_000,
        feeExponent: 1,
      }).filledSizeMicros,
    ).toBe(10_000_000);
    expect(database.getStrategyState().availableCashMicros).toBeLessThan(
      1_000_000,
    );
    const closedCycle = database
      .listPaperPositions()
      .find((position) => position.tokenId === firstCandidate.tokenId);
    expect(closedCycle).toMatchObject({
      quantityMicros: 0,
      cycleSpendMicros: 200_000,
      firstSellAt: expect.any(String),
      cycleClosedAt: expect.any(String),
    });

    expect(executeBuy(firstCandidate, "BLOCKED-NEXT-CYCLE", 10_000_000).outcome).toBe(
      "BLOCKED",
    );
    expect(
      database
        .listPaperPositions()
        .find((position) => position.tokenId === firstCandidate.tokenId),
    ).toMatchObject({
      cycleSpendMicros: 200_000,
      firstSellAt: closedCycle?.firstSellAt,
      cycleClosedAt: closedCycle?.cycleClosedAt,
    });
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
      eligibility: testEligibilitySettings(),
      feeRateMicros: 0,
      feeExponent: 1,
    });
    expect(() => database.updateTestInitialCapital(120_000_000)).toThrow(
      /Pause TEST/,
    );
    database.setStrategyStatus("PAUSED");
    expect(() => database.updateTestInitialCapital(120_000_000)).toThrow(
      /Reset TEST/,
    );

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
        minBidAskRatioPercent: 50,
        maxMarketProgressPercent: 20,
        orderBudgetMicros: 1_000_000,
      },
    });
    expect(database.listPaperOrders()).toEqual([]);
    expect(database.listPaperPositions()).toEqual([]);
    expect(database.listPaperSettlements()).toEqual([]);
    expect(database.updateTestInitialCapital(120_000_000)).toMatchObject({
      initialCapitalMicros: 120_000_000,
      availableCashMicros: 120_000_000,
    });
  });
});

function makeBook(overrides: Partial<TokenOrderBook> = {}): TokenOrderBook {
  return {
    tokenId: "yes-token",
    conditionId: "0xcondition",
    bookVersion: "TEST-BOOK-1",
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
    minBidAskRatioPercent: 50,
    maxMarketDurationDays: 30,
    maxMarketProgressPercent: 20,
    candidatesSelectedByDefault: true,
  };
}
