import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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

  it("keeps market display metadata with an open PAPER position", () => {
    const candidate = {
      ...makeCandidate({ queueAheadSizeMicros: 0 }),
      eventSlug: "will-this-test-pass",
    };
    const buy = database.placePaperBuy(candidate, 100_000_000);
    database.applyPaperTrade({
      orderId: buy.id,
      sourceTradeId: "position-display-fill",
      tradePriceMicros: 20_000,
      tradeSizeMicros: 2_000_000,
      dataComplete: true,
    });

    expect(database.listActivePaperBuyMarkets()).toEqual([
      {
        tokenId: "yes-token",
        makerBuyPriceMicros: 20_000,
        bestAskMicros: 20_000,
        bestBidMicros: 20_000,
        bookReady: true,
        category: "Tech",
        categoryIds: ["tag-tech"],
        resultCount: 2,
        durationDays: 10,
        minOrderSizeMicros: 1,
        tickSizeMicros: 1,
        openedAt: "2026-01-01T00:00:00.000Z",
        endsAt: "2026-01-11T00:00:00.000Z",
      },
    ]);
    expect(database.listPaperPositionViews()).toEqual([
      expect.objectContaining({
        tokenId: "yes-token",
        eventId: "event-1",
        eventSlug: "will-this-test-pass",
        eventTitle: "Test event",
        marketQuestion: "Will this test pass?",
        marketId: "market-1",
        direction: "YES",
        openedAt: "2026-01-01T00:00:00.000Z",
        endsAt: "2026-01-11T00:00:00.000Z",
        quantityMicros: 2_000_000,
        costMicros: 40_000,
      }),
    ]);
  });

  it("returns every current PAPER position without a history limit", () => {
    for (let index = 0; index < 101; index += 1) {
      const candidate = makeCandidate({
        candidateId: `token-${index}:20000`,
        tokenId: `token-${index}`,
        conditionId: `condition-${index}`,
        marketId: `market-${index}`,
        orderSizeMicros: 1_000_000,
        queueAheadSizeMicros: 0,
      });
      const buy = database.placePaperBuy(candidate, 100_000_000);
      database.applyPaperTrade({
        orderId: buy.id,
        sourceTradeId: `position-fill-${index}`,
        tradePriceMicros: 20_000,
        tradeSizeMicros: 1_000_000,
        dataComplete: true,
      });
    }

    expect(database.listPaperPositionViews()).toHaveLength(100);
    expect(database.listCurrentPaperPositionViews()).toHaveLength(101);
  });

  it("backfills display-safe metadata when upgrading a database with positions", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-metadata-upgrade-"));
    const databasePath = join(directory, "paper.db");
    const legacyDatabase = new PaperDatabase(databasePath, 100_000_000);
    try {
      legacyDatabase.setStrategyStatus("RUNNING");
      const buy = legacyDatabase.placePaperBuy(
        makeCandidate({ queueAheadSizeMicros: 0 }),
        100_000_000,
      );
      legacyDatabase.applyPaperTrade({
        orderId: buy.id,
        sourceTradeId: "legacy-position-fill",
        tradePriceMicros: 20_000,
        tradeSizeMicros: 1_000_000,
        dataComplete: true,
      });
    } finally {
      legacyDatabase.close();
    }

    const rawDatabase = new Database(databasePath);
    try {
      rawDatabase.exec(
        "DROP TABLE paper_market_metadata; DELETE FROM schema_migrations WHERE version IN (6, 7);",
      );
    } finally {
      rawDatabase.close();
    }

    const upgradedDatabase = new PaperDatabase(databasePath, 100_000_000);
    try {
      expect(upgradedDatabase.listCurrentPaperPositionViews()).toEqual([
        expect.objectContaining({
          tokenId: "yes-token",
          eventId: "event-1",
          marketId: "market-1",
          openedAt: "2026-01-01T00:00:00.000Z",
          endsAt: "2026-01-11T00:00:00.000Z",
          eventTitle: null,
          marketQuestion: null,
          direction: null,
        }),
      ]);
    } finally {
      upgradedDatabase.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("adds the final eligibility defaults when upgrading a version 7 database", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-progress-upgrade-"));
    const databasePath = join(directory, "paper.db");
    const currentDatabase = new PaperDatabase(databasePath, 100_000_000);
    currentDatabase.ensurePaperTradingPreferences({
      resultCounts: [2, 3],
      maxBuyPriceMicros: 30_000,
      maxMarketDurationDays: 30,
      maxMarketProgressPercent: 20,
      minBidAskRatioPercent: 50,
      candidatesSelectedByDefault: true,
      allCategories: true,
      selectedCategories: [],
      candidateSortDirection: "ASC",
      orderBudgetMicros: 1_000_000,
    });
    currentDatabase.setStrategyStatus("RUNNING");
    currentDatabase.close();

    const rawDatabase = new Database(databasePath);
    try {
      rawDatabase.exec(
        `ALTER TABLE paper_trading_preferences DROP COLUMN max_market_progress_percent;
        ALTER TABLE paper_trading_preferences DROP COLUMN min_bid_ask_ratio_percent;
        ALTER TABLE paper_market_metadata DROP COLUMN category_ids_json;
        ALTER TABLE paper_market_metadata DROP COLUMN category_labels_json;
        DROP TABLE test_order_book_consumption;
        DELETE FROM schema_migrations WHERE version IN (8, 12);`,
      );
    } finally {
      rawDatabase.close();
    }

    const upgradedDatabase = new PaperDatabase(databasePath, 100_000_000);
    try {
      expect(upgradedDatabase.getPaperTradingPreferences()).toMatchObject({
        maxMarketProgressPercent: 20,
        minBidAskRatioPercent: 50,
      });
      expect(upgradedDatabase.getStrategyState().status).toBe("PAUSED");
      const schemaVersion = new Database(databasePath, { readonly: true });
      try {
        expect(
          schemaVersion
            .prepare("SELECT MAX(version) AS version FROM schema_migrations")
            .get(),
        ).toEqual({ version: 12 });
      } finally {
        schemaVersion.close();
      }
    } finally {
      upgradedDatabase.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back a multi-statement migration when a later statement fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-migration-atomic-"));
    const databasePath = join(directory, "paper.db");
    const currentDatabase = new PaperDatabase(databasePath, 100_000_000);
    currentDatabase.close();

    const rawDatabase = new Database(databasePath);
    try {
      rawDatabase.exec(
        `ALTER TABLE paper_trading_preferences DROP COLUMN min_bid_ask_ratio_percent;
        ALTER TABLE paper_market_metadata DROP COLUMN category_ids_json;
        DROP TABLE test_order_book_consumption;
        DELETE FROM schema_migrations WHERE version = 12;`,
      );
    } finally {
      rawDatabase.close();
    }

    expect(() => new PaperDatabase(databasePath, 100_000_000)).toThrow(
      /duplicate column name: category_labels_json/,
    );

    const inspectedDatabase = new Database(databasePath);
    try {
      const preferenceColumns = inspectedDatabase
        .prepare("PRAGMA table_info(paper_trading_preferences)")
        .all() as Array<{ name: string }>;
      const metadataColumns = inspectedDatabase
        .prepare("PRAGMA table_info(paper_market_metadata)")
        .all() as Array<{ name: string }>;
      expect(preferenceColumns.map((column) => column.name)).not.toContain(
        "min_bid_ask_ratio_percent",
      );
      expect(metadataColumns.map((column) => column.name)).not.toContain(
        "category_ids_json",
      );
      expect(
        inspectedDatabase
          .prepare("SELECT 1 FROM schema_migrations WHERE version = 12")
          .get(),
      ).toBeUndefined();
    } finally {
      inspectedDatabase.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cancels and refunds legacy maker buys when upgrading to TEST FAK execution", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-fak-upgrade-"));
    const databasePath = join(directory, "paper.db");
    const legacyDatabase = new PaperDatabase(databasePath, 100_000_000);
    legacyDatabase.setStrategyStatus("RUNNING");
    const legacyBuy = legacyDatabase.placePaperBuy(
      makeCandidate({ queueAheadSizeMicros: 0 }),
      100_000_000,
    );
    legacyDatabase.applyPaperTrade({
      orderId: legacyBuy.id,
      sourceTradeId: "legacy-upgrade-fill",
      tradePriceMicros: 20_000,
      tradeSizeMicros: 5_000_000,
      dataComplete: true,
    });
    expect(legacyDatabase.getStrategyState()).toMatchObject({
      availableCashMicros: 99_000_000,
      reservedCashMicros: 900_000,
      positionCostMicros: 100_000,
    });
    legacyDatabase.close();

    const rawDatabase = new Database(databasePath);
    try {
      rawDatabase.exec(`
        DROP INDEX IF EXISTS idx_paper_orders_execution_active;
        ALTER TABLE paper_orders DROP COLUMN execution_kind;
        ALTER TABLE paper_orders DROP COLUMN cash_limit_micros;
        ALTER TABLE paper_orders DROP COLUMN fee_micros;
        ALTER TABLE paper_fills DROP COLUMN net_size_micros;
        ALTER TABLE paper_fills DROP COLUMN fee_micros;
        ALTER TABLE paper_positions DROP COLUMN cycle_spend_micros;
        ALTER TABLE paper_positions DROP COLUMN gross_buy_size_micros;
        ALTER TABLE paper_positions DROP COLUMN gross_buy_notional_micros;
        ALTER TABLE paper_market_metadata DROP COLUMN category;
        ALTER TABLE paper_market_metadata DROP COLUMN fees_enabled;
        ALTER TABLE paper_market_metadata DROP COLUMN fee_rate_micros;
        ALTER TABLE paper_market_metadata DROP COLUMN fee_exponent;
        ALTER TABLE paper_market_metadata DROP COLUMN min_order_size_micros;
        ALTER TABLE paper_market_metadata DROP COLUMN tick_size_micros;
        ALTER TABLE paper_trading_preferences DROP COLUMN all_categories_enabled;
        ALTER TABLE paper_trading_preferences DROP COLUMN selected_categories_json;
        ALTER TABLE paper_trading_preferences DROP COLUMN candidate_sort_direction;
        ALTER TABLE paper_trading_preferences DROP COLUMN order_budget_micros;
        DELETE FROM schema_migrations WHERE version IN (9, 10, 11);
      `);
    } finally {
      rawDatabase.close();
    }

    const upgradedDatabase = new PaperDatabase(databasePath, 100_000_000);
    try {
      expect(upgradedDatabase.getStrategyState()).toMatchObject({
        status: "PAUSED",
        availableCashMicros: 99_900_000,
        reservedCashMicros: 0,
        positionCostMicros: 100_000,
      });
      expect(upgradedDatabase.listPaperOrders()).toContainEqual(
        expect.objectContaining({
          id: legacyBuy.id,
          executionKind: "LEGACY_MAKER",
          status: "CANCELLED",
        }),
      );
      expect(
        upgradedDatabase
          .listActivePaperOrders()
          .filter((order) => order.side === "BUY"),
      ).toEqual([]);
      expect(upgradedDatabase.listActivePaperOrders()).toContainEqual(
        expect.objectContaining({
          side: "SELL",
          executionKind: "TARGET",
          status: "OPEN",
        }),
      );
      const metadata =
        upgradedDatabase.getTestMarketExecutionMetadata("yes-token");
      expect(metadata).toMatchObject({ minOrderSizeMicros: 1 });
      expect(
        upgradedDatabase.executeTestFakSells({
          tokenId: "yes-token",
          bookVersion: "DATABASE-UPGRADE-BID-1",
          bids: [{ priceMicros: 30_000, sizeMicros: 5_000_000 }],
          minOrderSizeMicros: metadata?.minOrderSizeMicros ?? 0,
          feeRateMicros: metadata?.feeRateMicros ?? 0,
          feeExponent: metadata?.feeExponent ?? 1,
        }),
      ).toMatchObject({ filledSizeMicros: 5_000_000 });
      expect(upgradedDatabase.listCurrentPaperPositionViews()).toEqual([]);
    } finally {
      upgradedDatabase.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks buys after a sports game starts", () => {
    expect(() =>
      database.placePaperBuy(
        makeCandidate({ gameStartsAt: "2020-01-01T00:00:00.000Z" }),
        100_000_000,
      ),
    ).toThrow(/game has started/);
    expect(database.listPaperOrders()).toHaveLength(0);
    expect(database.getStrategyState()).toMatchObject({
      availableCashMicros: 100_000_000,
      reservedCashMicros: 0,
    });
  });

  it("cancels in-flight buys when a sports game starts", () => {
    const gameStartsAt = "2099-01-01T00:00:00.000Z";
    const buy = database.placePaperBuy(
      makeCandidate({ gameStartsAt }),
      100_000_000,
    );

    expect(database.cancelStartedGameBuys(new Date(gameStartsAt))).toBe(1);
    expect(database.listPaperOrders()).toContainEqual(
      expect.objectContaining({ id: buy.id, status: "CANCELLED" }),
    );
    expect(database.getStrategyState()).toMatchObject({
      availableCashMicros: 100_000_000,
      reservedCashMicros: 0,
    });
  });

  it("cancels in-flight buys at the configured market progress limit", () => {
    const buy = database.placePaperBuy(
      makeCandidate({
        openedAt: "2099-01-01T00:00:00.000Z",
        endsAt: "2099-01-11T00:00:00.000Z",
      }),
      100_000_000,
    );

    expect(
      database.cancelProgressedMarketBuys(
        90,
        new Date("2099-01-10T00:00:00.000Z"),
      ),
    ).toBe(1);
    expect(database.listPaperOrders()).toContainEqual(
      expect.objectContaining({ id: buy.id, status: "CANCELLED" }),
    );
    expect(database.getStrategyState()).toMatchObject({
      availableCashMicros: 100_000_000,
      reservedCashMicros: 0,
    });
  });

  it("cancels only the unfilled part of buys when paused", () => {
    const buy = database.placePaperBuy(makeCandidate(), 100_000_000);
    database.applyPaperTrade({
      orderId: buy.id,
      sourceTradeId: "partial-before-pause",
      tradePriceMicros: 20_000,
      tradeSizeMicros: 12_000_000,
      dataComplete: true,
    });

    database.setStrategyStatus("PAUSED");

    expect(database.listPaperOrders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: buy.id,
          status: "CANCELLED",
          filledSizeMicros: 2_000_000,
        }),
        expect.objectContaining({ side: "SELL", status: "OPEN" }),
      ]),
    );
    expect(database.getStrategyState()).toMatchObject({
      status: "PAUSED",
      availableCashMicros: 99_960_000,
      reservedCashMicros: 0,
      positionCostMicros: 40_000,
    });
  });

  it("allows sells to reduce exposure and cancels frozen buys before resume", () => {
    const buy = database.placePaperBuy(makeCandidate(), 100_000_000);
    const buyFill = database.applyPaperTrade({
      orderId: buy.id,
      sourceTradeId: "buy-before-validation-pause",
      tradePriceMicros: 20_000,
      tradeSizeMicros: 12_000_000,
      dataComplete: true,
    });
    const sell = buyFill.createdSellOrder;
    if (sell === null) throw new Error("Expected an automatic paper sell");

    database.pausePaperStrategyForValidationFailure(["Injected validation fault"]);
    database.rebaseActivePaperOrderQueues("yes-token", [], []);
    const sellFill = database.applyPaperTrade({
      orderId: sell.id,
      sourceTradeId: "sell-during-validation-pause",
      tradePriceMicros: 30_000,
      tradeSizeMicros: 2_000_000,
      dataComplete: true,
    });

    expect(sellFill.order.status).toBe("FILLED");
    expect(database.listPaperOrders()).toContainEqual(
      expect.objectContaining({
        id: buy.id,
        status: "PARTIALLY_FILLED",
        filledSizeMicros: 2_000_000,
      }),
    );
    expect(database.getStrategyState().status).toBe("PAUSED");

    database.setStrategyStatus("RUNNING");
    const staleFill = database.applyPaperTrade({
      orderId: buy.id,
      sourceTradeId: "stale-buy-after-resume",
      tradePriceMicros: 20_000,
      tradeSizeMicros: 12_000_000,
      dataComplete: true,
    });

    expect(staleFill.incrementalFillSizeMicros).toBe(0);
    expect(staleFill.order.status).toBe("CANCELLED");
    expect(() =>
      database.placePaperBuy(makeCandidate(), 100_000_000),
    ).toThrow(/first sell/);
  });

  it("checks paper balances and active orders during recovery", () => {
    database.placePaperBuy(makeCandidate(), 100_000_000);

    expect(database.recoverPaperState()).toMatchObject({
      passed: true,
      errors: [],
      activeOrderCount: 1,
      cancelledBuyCount: 0,
    });
    expect(database.getStrategyState().status).toBe("RUNNING");
  });

  it("validates a healthy paper ledger without mutating it", () => {
    database.placePaperBuy(makeCandidate(), 100_000_000);
    const stateBeforeValidation = database.getStrategyState();

    const result = database.validatePaperState();

    expect(result).toMatchObject({
      passed: true,
      errors: [],
      sqliteIntegrity: "ok",
      activeOrderCount: 1,
      openPositionCount: 0,
      pendingSettlementCount: 0,
    });
    expect(database.getStrategyState()).toEqual(stateBeforeValidation);
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
    expect(
      database.listPaperOrders().filter((paperOrder) => paperOrder.side === "SELL"),
    ).toHaveLength(1);
  });

  it("creates a sell for each buy fill and closes buys after the first sell", () => {
    const buy = database.placePaperBuy(makeCandidate(), 100_000_000);
    const buyFill = database.applyPaperTrade({
      orderId: buy.id,
      sourceTradeId: "buy-trade",
      tradePriceMicros: 20_000,
      tradeSizeMicros: 12_000_000,
      dataComplete: true,
      sellRealQueueAheadSizeMicros: 4_000_000,
    });

    expect(buyFill.incrementalFillSizeMicros).toBe(2_000_000);
    expect(buyFill.createdSellOrder).toMatchObject({
      side: "SELL",
      priceMicros: 30_000,
      originalSizeMicros: 2_000_000,
      queueAheadSizeMicros: 4_000_000,
      linkedBuyOrderId: buy.id,
    });

    const sell = buyFill.createdSellOrder;
    if (sell === null) throw new Error("Expected an automatic paper sell");
    database.rebaseActivePaperOrderQueues("yes-token", [], []);
    const sellFill = database.applyPaperTrade({
      orderId: sell.id,
      sourceTradeId: "sell-trade",
      tradePriceMicros: 30_000,
      tradeSizeMicros: 2_000_000,
      dataComplete: true,
    });

    expect(sellFill.order.status).toBe("FILLED");
    expect(database.listActivePaperOrders("yes-token")).toHaveLength(0);
    expect(database.getStrategyState()).toMatchObject({
      availableCashMicros: 100_020_000,
      reservedCashMicros: 0,
      realizedPnlMicros: 20_000,
      positionCostMicros: 0,
    });
    expect(() =>
      database.placePaperBuy(makeCandidate(), 100_000_000),
    ).toThrow(/first sell/);
  });

  it("continues a partial fill conservatively after queue rebasing", () => {
    const buy = database.placePaperBuy(makeCandidate(), 100_000_000);
    database.applyPaperTrade({
      orderId: buy.id,
      sourceTradeId: "before-gap",
      tradePriceMicros: 20_000,
      tradeSizeMicros: 12_000_000,
      dataComplete: true,
    });
    database.rebaseActivePaperOrderQueues(
      "yes-token",
      [{ priceMicros: 20_000, sizeMicros: 5_000_000 }],
      [],
    );
    const afterGap = database.applyPaperTrade({
      orderId: buy.id,
      sourceTradeId: "after-gap",
      tradePriceMicros: 20_000,
      tradeSizeMicros: 7_000_000,
      dataComplete: true,
    });

    expect(afterGap.incrementalFillSizeMicros).toBe(2_000_000);
    expect(afterGap.order.filledSizeMicros).toBe(4_000_000);
  });
});
