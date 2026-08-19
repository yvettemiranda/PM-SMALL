import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenOrderBook } from "../src/domain/types.js";
import {
  PaperDatabase,
  type PaperTradingPreferences,
} from "../src/infrastructure/db/database.js";
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

  it("previews with persisted book consumption and never mutates accounting", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const input = {
      candidate: makeCandidate({ bestAskMicros: 20_000 }),
      book: makeBook({
        bookVersion: "PREVIEW-BOOK",
        asks: [{ priceMicros: 20_000, sizeMicros: 10_000_000 }],
      }),
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      eligibility: testEligibilitySettings(),
      feeRateMicros: 0,
      feeExponent: 1,
    };

    expect(database.previewTestFakBuy(input)).toMatchObject({
      outcome: "READY",
      preview: { plan: { spentMicros: 200_000 } },
    });
    expect(database.listPaperOrders()).toEqual([]);
    expect(database.listPaperPositions()).toEqual([]);
    expect(database.listPaperEventLocks()).toEqual([]);

    expect(database.executeTestFakBuy(input).spentMicros).toBe(200_000);
    expect(database.previewTestFakBuy(input)).toMatchObject({
      outcome: "BLOCKED",
      preview: null,
    });
    expect(database.listPaperOrders().filter((order) => order.side === "BUY")).toHaveLength(1);
  });

  it("uses the configured target formula for Preview and persisted sell targets", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const input = {
      candidate: makeCandidate({
        bestAskMicros: 24_000,
        tickSizeMicros: 1_000,
      }),
      book: makeBook({
        bookVersion: "CONFIGURED-TARGET",
        asks: [{ priceMicros: 24_000, sizeMicros: 10_000_000 }],
        tickSizeMicros: 1_000,
      }),
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      eligibility: testEligibilitySettings(),
      feeRateMicros: 0,
      feeExponent: 1,
      targetSellPriceSettings: {
        increaseMicros: 5_000,
        multiplierMicros: 1_800_000,
      },
    };

    expect(database.previewTestFakBuy(input).preview?.fills).toEqual([
      expect.objectContaining({ targetPriceMicros: 44_000 }),
    ]);
    database.executeTestFakBuy(input);
    expect(
      database.listPaperOrders().find((order) => order.side === "SELL"),
    ).toMatchObject({ priceMicros: 44_000 });
  });

  it("confirms a fresh weighted-entry stop for 30 seconds, exits in FAK slices, and blocks Event re-entry", () => {
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
        bookVersion: "STOP-BUY",
        bids: [{ priceMicros: 10_000, sizeMicros: 100_000_000 }],
        asks: [{ priceMicros: 20_000, sizeMicros: 50_000_000 }],
      }),
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      eligibility: testEligibilitySettings(),
      feeRateMicros: 0,
      feeExponent: 1,
      stopLossSettings: { enabled: true, multiplierMicros: 400_000 },
    };
    expect(database.executeTestFakBuy(buyInput).spentMicros).toBe(1_000_000);
    expect(database.listPaperStopLosses()).toEqual([
      expect.objectContaining({
        tokenId: candidate.tokenId,
        eventId: candidate.eventId,
        state: "WATCHING",
        entryPriceMicros: 20_000,
        thresholdPriceMicros: 8_000,
        multiplierMicros: 400_000,
      }),
    ]);

    const stopIntent = {
      tokenId: candidate.tokenId,
      bookVersion: "STOP-BID-1",
      bids: [{ priceMicros: 7_000, sizeMicros: 20_000_000 }],
      minOrderSizeMicros: 5_000_000,
      feeRateMicros: 0,
      feeExponent: 1,
      observedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    expect(database.executeTestStopLoss(stopIntent)).toMatchObject({
      state: "ARMED",
      triggered: false,
      filledSizeMicros: 0,
    });

    expect(
      database.executeTestStopLoss({
        ...stopIntent,
        observedAt: new Date("2026-01-02T00:00:31.000Z"),
      }),
    ).toMatchObject({ state: "ARMED", triggered: false, filledSizeMicros: 0 });

    expect(
      database.executeTestStopLoss({
        ...stopIntent,
        bookVersion: "STOP-BID-2",
        observedAt: new Date("2026-01-02T00:00:31.000Z"),
      }),
    ).toMatchObject({
      state: "EXITING",
      triggered: true,
      cancelledTargetCount: 1,
      filledSizeMicros: 20_000_000,
    });
    expect(database.listCurrentPaperPositionViews()[0]).toMatchObject({
      quantityMicros: 30_000_000,
      firstSellAt: expect.any(String),
    });
    expect(
      database
        .listPaperOrders()
        .filter((order) => order.executionKind === "TARGET"),
    ).toEqual([expect.objectContaining({ status: "CANCELLED" })]);

    expect(
      database.executeTestStopLoss({
        ...stopIntent,
        bookVersion: "STOP-BID-3",
        bids: [{ priceMicros: 6_000, sizeMicros: 30_000_000 }],
        observedAt: new Date("2026-01-02T00:00:32.000Z"),
      }),
    ).toMatchObject({ state: "STOPPED", filledSizeMicros: 30_000_000 });
    expect(database.listCurrentPaperPositionViews()).toEqual([]);
    expect(database.validatePaperState()).toMatchObject({ passed: true, errors: [] });
    expect(
      database.executeTestFakBuy({
        ...buyInput,
        book: { ...buyInput.book, bookVersion: "STOP-REENTRY" },
      }).outcome,
    ).toBe("BLOCKED");
  });

  it("resets stop confirmation after an executable bid recovers to the threshold", () => {
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
        bookVersion: "RECOVERY-BUY",
        asks: [{ priceMicros: 20_000, sizeMicros: 50_000_000 }],
      }),
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      eligibility: testEligibilitySettings(),
      feeRateMicros: 0,
      feeExponent: 1,
      stopLossSettings: { enabled: true, multiplierMicros: 400_000 },
    });
    const observe = (bookVersion: string, bid: number, seconds: number) =>
      database.executeTestStopLoss({
        tokenId: candidate.tokenId,
        bookVersion,
        bids: [{ priceMicros: bid, sizeMicros: 50_000_000 }],
        minOrderSizeMicros: 5_000_000,
        feeRateMicros: 0,
        feeExponent: 1,
        observedAt: new Date(`2026-01-02T00:00:${String(seconds).padStart(2, "0")}.000Z`),
      });

    expect(observe("RECOVERY-LOW-1", 7_000, 0).state).toBe("ARMED");
    expect(observe("RECOVERY-HIGH", 8_000, 20).state).toBe("WATCHING");
    expect(observe("RECOVERY-LOW-2", 7_000, 31)).toMatchObject({
      state: "ARMED",
      triggered: false,
    });
    expect(observe("RECOVERY-LOW-3", 7_000, 32)).toMatchObject({
      state: "ARMED",
      triggered: false,
    });
  });

  it("persists the recovery time and ignores a clock rollback before re-arming", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-stop-recovery-"));
    const databasePath = join(directory, "paper.db");
    const candidate = makeCandidate({
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
      bestAskMicros: 20_000,
    });
    const first = new PaperDatabase(databasePath, 100_000_000);
    try {
      first.setStrategyStatus("RUNNING");
      first.executeTestFakBuy({
        candidate,
        book: makeBook({
          bookVersion: "ROLLBACK-BUY",
          asks: [{ priceMicros: 20_000, sizeMicros: 50_000_000 }],
        }),
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        eligibility: testEligibilitySettings(),
        feeRateMicros: 0,
        feeExponent: 1,
        stopLossSettings: { enabled: true, multiplierMicros: 400_000 },
      });
      const observe = (bookVersion: string, bid: number, observedAt: string) =>
        first.executeTestStopLoss({
          tokenId: candidate.tokenId,
          bookVersion,
          bids: [{ priceMicros: bid, sizeMicros: 50_000_000 }],
          minOrderSizeMicros: 5_000_000,
          feeRateMicros: 0,
          feeExponent: 1,
          observedAt: new Date(observedAt),
        });
      expect(observe("ROLLBACK-LOW-1", 7_000, "2026-01-02T00:00:00.000Z").state)
        .toBe("ARMED");
      expect(observe("ROLLBACK-HIGH", 8_000, "2026-01-02T00:00:20.000Z").state)
        .toBe("WATCHING");
    } finally {
      first.close();
    }

    const restarted = new PaperDatabase(databasePath, 100_000_000);
    try {
      const observe = (bookVersion: string, observedAt: string) =>
        restarted.executeTestStopLoss({
          tokenId: candidate.tokenId,
          bookVersion,
          bids: [{ priceMicros: 7_000, sizeMicros: 50_000_000 }],
          minOrderSizeMicros: 5_000_000,
          feeRateMicros: 0,
          feeExponent: 1,
          observedAt: new Date(observedAt),
        });
      expect(observe("ROLLBACK-STALE-LOW", "2026-01-02T00:00:10.000Z"))
        .toMatchObject({ state: "WATCHING", triggered: false });
      expect(observe("ROLLBACK-LOW-2", "2026-01-02T00:00:21.000Z").state)
        .toBe("ARMED");
      expect(observe("ROLLBACK-LOW-3", "2026-01-02T00:00:51.000Z"))
        .toMatchObject({
          state: "STOPPED",
          triggered: true,
          filledSizeMicros: 50_000_000,
        });
      expect(restarted.validatePaperState()).toMatchObject({
        passed: true,
        errors: [],
      });
    } finally {
      restarted.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the remaining position protected after a normal partial target sell", () => {
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
        bookVersion: "PARTIAL-TARGET-BUY",
        asks: [{ priceMicros: 20_000, sizeMicros: 50_000_000 }],
      }),
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      eligibility: testEligibilitySettings(),
      feeRateMicros: 0,
      feeExponent: 1,
      stopLossSettings: { enabled: true, multiplierMicros: 400_000 },
    });

    expect(
      database.executeTestFakSells({
        tokenId: candidate.tokenId,
        bookVersion: "PARTIAL-TARGET-SELL",
        bids: [{ priceMicros: 30_000, sizeMicros: 20_000_000 }],
        minOrderSizeMicros: 5_000_000,
        feeRateMicros: 0,
        feeExponent: 1,
      }).filledSizeMicros,
    ).toBe(20_000_000);
    expect(database.getPaperStopLoss(candidate.tokenId)).toMatchObject({
      state: "WATCHING",
      thresholdPriceMicros: 8_000,
    });

    const observeLow = (bookVersion: string, observedAt: string) =>
      database.executeTestStopLoss({
        tokenId: candidate.tokenId,
        bookVersion,
        bids: [{ priceMicros: 7_000, sizeMicros: 30_000_000 }],
        minOrderSizeMicros: 5_000_000,
        feeRateMicros: 0,
        feeExponent: 1,
        observedAt: new Date(observedAt),
      });
    expect(observeLow("PARTIAL-TARGET-LOW-1", "2026-01-02T00:00:00.000Z").state)
      .toBe("ARMED");
    expect(
      observeLow("PARTIAL-TARGET-LOW-2", "2026-01-02T00:00:31.000Z"),
    ).toMatchObject({
      state: "STOPPED",
      triggered: true,
      filledSizeMicros: 30_000_000,
    });
  });

  it("persists an armed stop and completes confirmation after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-stop-restart-"));
    const databasePath = join(directory, "paper.db");
    const candidate = makeCandidate({
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
      bestAskMicros: 20_000,
    });
    const first = new PaperDatabase(databasePath, 100_000_000);
    try {
      first.setStrategyStatus("RUNNING");
      first.executeTestFakBuy({
        candidate,
        book: makeBook({
          bookVersion: "PERSIST-BUY",
          asks: [{ priceMicros: 20_000, sizeMicros: 50_000_000 }],
        }),
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        eligibility: testEligibilitySettings(),
        feeRateMicros: 0,
        feeExponent: 1,
        stopLossSettings: { enabled: true, multiplierMicros: 400_000 },
      });
      expect(
        first.executeTestStopLoss({
          tokenId: candidate.tokenId,
          bookVersion: "PERSIST-LOW-1",
          bids: [{ priceMicros: 7_000, sizeMicros: 50_000_000 }],
          minOrderSizeMicros: 5_000_000,
          feeRateMicros: 0,
          feeExponent: 1,
          observedAt: new Date("2026-01-02T00:00:00.000Z"),
        }).state,
      ).toBe("ARMED");
    } finally {
      first.close();
    }

    const restarted = new PaperDatabase(databasePath, 100_000_000);
    try {
      expect(restarted.getPaperStopLoss(candidate.tokenId)).toMatchObject({
        state: "ARMED",
        belowObservationCount: 1,
      });
      expect(
        restarted.executeTestStopLoss({
          tokenId: candidate.tokenId,
          bookVersion: "PERSIST-LOW-2",
          bids: [{ priceMicros: 7_000, sizeMicros: 50_000_000 }],
          minOrderSizeMicros: 5_000_000,
          feeRateMicros: 0,
          feeExponent: 1,
          observedAt: new Date("2026-01-02T00:00:31.000Z"),
        }),
      ).toMatchObject({
        state: "STOPPED",
        triggered: true,
        filledSizeMicros: 50_000_000,
      });
      expect(restarted.validatePaperState()).toMatchObject({
        passed: true,
        errors: [],
      });
    } finally {
      restarted.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("matches Preview coverage to real FAK sells when targets share all Bid depth", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      bestAskMicros: 10_000,
      bestBidMicros: 30_000,
    });
    const book = makeBook({
      bookVersion: "FULLY-SHARED-BIDS",
      bids: [{ priceMicros: 30_000, sizeMicros: 30_000_000 }],
      asks: [
        { priceMicros: 10_000, sizeMicros: 40_000_000 },
        { priceMicros: 20_000, sizeMicros: 30_000_000 },
      ],
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

    const previewCoverage = database.previewTestFakBuy(input).preview
      ?.exitBidCoverageSizeMicros;
    expect(previewCoverage).toBe(30_000_000);
    expect(database.executeTestFakBuy(input).spentMicros).toBe(1_000_000);

    const sell = database.executeTestFakSells({
      tokenId: candidate.tokenId,
      bookVersion: book.bookVersion,
      bids: book.bids,
      minOrderSizeMicros: book.minOrderSizeMicros,
      feeRateMicros: 0,
      feeExponent: 1,
    });

    expect(sell.filledSizeMicros).toBe(30_000_000);
    expect(previewCoverage).toBe(sell.filledSizeMicros);
  });

  it("keeps Preview and real FAK sell coverage equal across three shared targets", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      bestAskMicros: 10_000,
      bestBidMicros: 50_000,
    });
    const book = makeBook({
      bookVersion: "THREE-SHARED-TARGETS",
      bids: [
        { priceMicros: 50_000, sizeMicros: 10_000_000 },
        { priceMicros: 40_000, sizeMicros: 15_000_000 },
        { priceMicros: 30_000, sizeMicros: 25_000_000 },
        { priceMicros: 20_000, sizeMicros: 30_000_000 },
      ],
      asks: [
        { priceMicros: 10_000, sizeMicros: 20_000_000 },
        { priceMicros: 20_000, sizeMicros: 20_000_000 },
        { priceMicros: 30_000, sizeMicros: 20_000_000 },
      ],
    });
    const input = {
      candidate,
      book,
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_200_000,
      eligibility: testEligibilitySettings({ orderBudgetMicros: 1_200_000 }),
      feeRateMicros: 0,
      feeExponent: 1,
    };

    const previewCoverage = database.previewTestFakBuy(input).preview
      ?.exitBidCoverageSizeMicros;
    expect(previewCoverage).toBe(40_000_000);
    expect(database.executeTestFakBuy(input).spentMicros).toBe(1_200_000);

    const sell = database.executeTestFakSells({
      tokenId: candidate.tokenId,
      bookVersion: book.bookVersion,
      bids: book.bids,
      minOrderSizeMicros: book.minOrderSizeMicros,
      feeRateMicros: 0,
      feeExponent: 1,
    });

    expect(sell.filledSizeMicros).toBe(40_000_000);
    expect(previewCoverage).toBe(sell.filledSizeMicros);
  });

  it("keeps Preview and real FAK sells aligned when sub-minimum targets form one legal batch", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      bestAskMicros: 20_000,
      bestBidMicros: 40_000,
    });
    const book = makeBook({
      bookVersion: "SUB-MINIMUM-TARGET-BATCH",
      bids: [{ priceMicros: 40_000, sizeMicros: 6_000_000 }],
      asks: [
        { priceMicros: 20_000, sizeMicros: 3_000_000 },
        { priceMicros: 21_000, sizeMicros: 3_000_000 },
      ],
    });
    const orderBudgetMicros = 123_000;
    const input = {
      candidate,
      book,
      maxPriceMicros: 30_000,
      orderBudgetMicros,
      eligibility: testEligibilitySettings({ orderBudgetMicros }),
      feeRateMicros: 0,
      feeExponent: 1,
    };

    const preview = database.previewTestFakBuy(input);
    expect(preview).toMatchObject({
      outcome: "READY",
      preview: {
        exitBidCoverageSizeMicros: 6_000_000,
        exitBidCoveragePositionSizeMicros: 6_000_000,
      },
    });
    expect(database.executeTestFakBuy(input).spentMicros).toBe(orderBudgetMicros);

    const sell = database.executeTestFakSells({
      tokenId: candidate.tokenId,
      bookVersion: book.bookVersion,
      bids: book.bids,
      minOrderSizeMicros: book.minOrderSizeMicros,
      feeRateMicros: 0,
      feeExponent: 1,
    });

    expect(sell.filledSizeMicros).toBe(6_000_000);
    expect(sell.filledSizeMicros).toBe(
      preview.preview?.exitBidCoverageSizeMicros,
    );
  });

  it("creates the Event lock only on a real fill and freezes its cycle budget", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const winner = makeCandidate({
      eventId: "shared-event",
      tokenId: "winner-token",
      candidateId: "winner-token",
      marketId: "winner-market",
      conditionId: "winner-condition",
      bestAskMicros: 20_000,
    });
    const sibling = makeCandidate({
      eventId: "shared-event",
      tokenId: "sibling-token",
      candidateId: "sibling-token",
      marketId: "sibling-market",
      conditionId: "sibling-condition",
      bestAskMicros: 20_000,
    });
    const execute = (
      candidate: typeof winner,
      bookVersion: string,
      orderBudgetMicros: number,
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
        orderBudgetMicros,
        eligibility: testEligibilitySettings({ orderBudgetMicros }),
        feeRateMicros: 0,
        feeExponent: 1,
      });

    expect(execute(winner, "FIRST-FILL", 1_000_000, 10_000_000).spentMicros).toBe(
      200_000,
    );
    expect(database.getPaperEventLock("shared-event")).toMatchObject({
      state: "ACTIVE",
      activeTokenId: "winner-token",
      marketId: "winner-market",
      conditionId: "winner-condition",
      cycleBudgetMicros: 1_000_000,
    });
    expect(execute(sibling, "SIBLING", 1_000_000, 100_000_000).outcome).toBe(
      "BLOCKED",
    );
    expect(execute(winner, "FROZEN", 2_000_000, 100_000_000).spentMicros).toBe(
      800_000,
    );
    expect(database.getPaperEventLock("shared-event")?.cycleBudgetMicros).toBe(
      1_000_000,
    );
    expect(database.listPaperPositions()[0]?.cycleSpendMicros).toBe(1_000_000);
  });

  it("releases a fully exited Event in the sell transaction so a sibling can win next", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const first = makeCandidate({
      eventId: "reusable-event",
      tokenId: "first-token",
      candidateId: "first-token",
      marketId: "first-market",
      conditionId: "first-condition",
      bestAskMicros: 20_000,
    });
    const second = makeCandidate({
      eventId: "reusable-event",
      tokenId: "second-token",
      candidateId: "second-token",
      marketId: "second-market",
      conditionId: "second-condition",
      bestAskMicros: 20_000,
    });
    const buy = (
      candidate: typeof first,
      version: string,
      orderBudgetMicros = 1_000_000,
      askSizeMicros = 10_000_000,
    ) =>
      database.executeTestFakBuy({
        candidate,
        book: makeBook({
          tokenId: candidate.tokenId,
          conditionId: candidate.conditionId,
          bookVersion: version,
          asks: [{ priceMicros: 20_000, sizeMicros: askSizeMicros }],
        }),
        maxPriceMicros: 30_000,
        orderBudgetMicros,
        eligibility: testEligibilitySettings({ orderBudgetMicros }),
        feeRateMicros: 0,
        feeExponent: 1,
      });

    expect(buy(first, "FIRST-BUY").spentMicros).toBe(200_000);
    expect(
      database.executeTestFakSells({
        tokenId: first.tokenId,
        bookVersion: "FIRST-SELL",
        bids: [{ priceMicros: 30_000, sizeMicros: 10_000_000 }],
        minOrderSizeMicros: 1,
        feeRateMicros: 0,
        feeExponent: 1,
      }).filledSizeMicros,
    ).toBe(10_000_000);
    expect(database.getPaperEventLock("reusable-event")).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(buy(second, "SECOND-BUY", 2_000_000, 100_000_000).spentMicros).toBe(
      2_000_000,
    );
    expect(database.getPaperEventLock("reusable-event")).toMatchObject({
      activeTokenId: "second-token",
      cycleBudgetMicros: 2_000_000,
    });
    expect(database.validatePaperState()).toMatchObject({
      passed: true,
      errors: [],
    });
  });

  it("rolls back an Event lock when the fill transaction fails", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      eventId: "rollback-event",
      marketId: " ",
      tokenId: "rollback-token",
      conditionId: "rollback-condition",
      bestAskMicros: 20_000,
    });

    expect(() =>
      database.executeTestFakBuy({
        candidate,
        book: makeBook({
          tokenId: candidate.tokenId,
          conditionId: candidate.conditionId,
          bookVersion: "ROLLBACK-BOOK",
        }),
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        eligibility: testEligibilitySettings(),
        feeRateMicros: 0,
        feeExponent: 1,
      }),
    ).toThrow();
    expect(database.listPaperEventLocks()).toEqual([]);
    expect(database.listPaperOrders()).toEqual([]);
    expect(database.listPaperPositions()).toEqual([]);
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

  it("enforces the per-Event cycle cash cap across repeated partial FAK buys", () => {
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
        eventId: `event-${index}`,
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

  it("aggregates ordered target fragments to meet the minimum sell size without crossing a target price", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
      bestAskMicros: 20_000,
    });
    const executeBuy = (
      bookVersion: string,
      priceMicros: number,
    ) =>
      database.executeTestFakBuy({
        candidate,
        book: makeBook({
          bookVersion,
          asks: [{ priceMicros, sizeMicros: 3_000_000 }],
        }),
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        eligibility: testEligibilitySettings(),
        feeRateMicros: 0,
        feeExponent: 1,
      });

    expect(executeBuy("FRAGMENT-BUY-1", 20_000).spentMicros).toBe(60_000);
    expect(
      database.executeTestFakSells({
        tokenId: candidate.tokenId,
        bookVersion: "FRAGMENT-BID-1",
        bids: [{ priceMicros: 40_000, sizeMicros: 6_000_000 }],
        minOrderSizeMicros: 5_000_000,
        feeRateMicros: 50_000,
        feeExponent: 1,
      }).filledSizeMicros,
    ).toBe(0);

    expect(executeBuy("FRAGMENT-BUY-2", 21_000).spentMicros).toBe(63_000);
    expect(
      database.executeTestFakSells({
        tokenId: candidate.tokenId,
        bookVersion: "FRAGMENT-BID-2",
        bids: [{ priceMicros: 31_000, sizeMicros: 6_000_000 }],
        minOrderSizeMicros: 5_000_000,
        feeRateMicros: 50_000,
        feeExponent: 1,
      }).filledSizeMicros,
    ).toBe(0);

    const sell = database.executeTestFakSells({
      tokenId: candidate.tokenId,
      bookVersion: "FRAGMENT-BID-3",
      bids: [{ priceMicros: 40_000, sizeMicros: 6_000_000 }],
      minOrderSizeMicros: 5_000_000,
      feeRateMicros: 50_000,
      feeExponent: 1,
    });

    expect(sell).toMatchObject({
      filledSizeMicros: 6_000_000,
      grossProceedsMicros: 240_000,
      feeMicros: 11_520,
      netProceedsMicros: 228_480,
      filledOrderCount: 2,
    });
    expect(
      database
        .listPaperOrders()
        .filter((order) => order.side === "SELL")
        .map((order) => ({
          priceMicros: order.priceMicros,
          status: order.status,
          filledSizeMicros: order.filledSizeMicros,
          feeMicros: order.feeMicros,
        })),
    ).toEqual([
      {
        priceMicros: 30_000,
        status: "FILLED",
        filledSizeMicros: 3_000_000,
        feeMicros: 5_760,
      },
      {
        priceMicros: 40_000,
        status: "FILLED",
        filledSizeMicros: 3_000_000,
        feeMicros: 5_760,
      },
    ]);
    expect(database.listPaperPositions()[0]).toMatchObject({
      quantityMicros: 0,
      costMicros: 0,
      cycleClosedAt: expect.any(String),
    });
    expect(database.listPaperEventLocks()).toEqual([]);
    expect(database.validatePaperState()).toMatchObject({
      passed: true,
      errors: [],
      sqliteIntegrity: "ok",
    });
  });

  it("keeps aggregated target proceeds reconstructable from persisted fill price and size", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    databases.push(database);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      executableBuyPriceMicros: 20_000,
      makerBuyPriceMicros: 20_000,
      bestAskMicros: 20_000,
    });
    const executeBuy = (bookVersion: string, sizeMicros: number) =>
      database.executeTestFakBuy({
        candidate,
        book: makeBook({
          bookVersion,
          asks: [{ priceMicros: 20_000, sizeMicros }],
        }),
        maxPriceMicros: 30_000,
        orderBudgetMicros: 1_000_000,
        eligibility: testEligibilitySettings(),
        feeRateMicros: 0,
        feeExponent: 1,
      });

    expect(executeBuy("ROUNDING-BUY-1", 3_333_333).spentMicros).toBe(66_666);
    expect(executeBuy("ROUNDING-BUY-2", 1_666_668).spentMicros).toBe(33_333);

    const sell = database.executeTestFakSells({
      tokenId: candidate.tokenId,
      bookVersion: "ROUNDING-BID",
      bids: [{ priceMicros: 30_000, sizeMicros: 5_000_001 }],
      minOrderSizeMicros: 5_000_000,
      feeRateMicros: 0,
      feeExponent: 1,
    });

    expect(sell).toMatchObject({
      filledSizeMicros: 5_000_001,
      grossProceedsMicros: 149_999,
      feeMicros: 0,
      netProceedsMicros: 149_999,
      filledOrderCount: 2,
    });
    expect(database.getStrategyState()).toMatchObject({
      availableCashMicros: 100_050_000,
      positionCostMicros: 0,
      realizedPnlMicros: 50_000,
    });
    expect(database.validatePaperState()).toMatchObject({
      passed: true,
      errors: [],
      sqliteIntegrity: "ok",
    });
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
        marketTypes: ["BINARY", "TERNARY"],
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

function defaultPreferences(): Omit<PaperTradingPreferences, "updatedAt"> {
  return {
    marketTypes: ["BINARY", "TERNARY"],
    allCategories: true,
    selectedCategories: [],
    candidateSortDirection: "ASC" as const,
    orderBudgetMicros: 1_000_000,
    minBuyPriceMicros: 10_000,
    maxBuyPriceMicros: 30_000,
    targetSellPriceIncreaseMicros: 10_000,
    targetSellPriceMultiplierMicros: 1_500_000,
    stopLossEnabled: true,
    stopLossMultiplierMicros: 400_000,
    minBidAskRatioPercent: 50,
    minMarketDurationDays: 1,
    maxMarketDurationDays: 30,
    maxMarketProgressPercent: 20,
    candidatesSelectedByDefault: true,
  };
}
