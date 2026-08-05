import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { PaperMarketProcessor } from "../src/services/paper-market-processor.js";
import { makeCandidate } from "./helpers.js";

describe("PaperMarketProcessor", () => {
  let database: PaperDatabase;
  let processor: PaperMarketProcessor;

  beforeEach(() => {
    database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    processor = new PaperMarketProcessor(database);
  });

  afterEach(() => database.close());

  it("rebases from a book and creates one sell from a deduplicated buy fill", () => {
    const buy = database.placePaperBuy(makeCandidate(), 100_000_000);
    processor.handle({
      type: "book",
      tokenId: "yes-token",
      bids: [{ priceMicros: 20_000, sizeMicros: 10_000_000 }],
      asks: [{ priceMicros: 30_000, sizeMicros: 4_000_000 }],
      timestampMs: 100,
    });
    processor.handle({
      type: "price_change",
      tokenId: "yes-token",
      side: "SELL",
      priceMicros: 30_000,
      sizeMicros: 6_000_000,
      timestampMs: 100,
    });
    const trade = {
      type: "trade" as const,
      sourceTradeId: "trade-1",
      tokenId: "yes-token",
      takerSide: "SELL" as const,
      priceMicros: 20_000,
      sizeMicros: 12_000_000,
      timestampMs: 101,
    };

    processor.handle(trade);
    processor.handle(trade);

    const orders = database.listPaperOrders();
    expect(orders.find((order) => order.id === buy.id)).toMatchObject({
      filledSizeMicros: 2_000_000,
      status: "PARTIALLY_FILLED",
    });
    expect(orders.filter((order) => order.side === "SELL")).toEqual([
      expect.objectContaining({
        originalSizeMicros: 2_000_000,
        queueAheadSizeMicros: 6_000_000,
      }),
    ]);
    expect(processor.getStatus()).toMatchObject({
      paperBuyFillCount: 1,
      paperSellFillCount: 0,
      createdPaperSellCount: 1,
    });
  });

  it("records a complete buy-to-sell PAPER cycle from market events", () => {
    const buy = database.placePaperBuy(makeCandidate(), 100_000_000);
    processor.handle({
      type: "book",
      tokenId: "yes-token",
      bids: [],
      asks: [],
      timestampMs: 100,
    });
    processor.handle({
      type: "trade",
      sourceTradeId: "cycle-buy",
      tokenId: "yes-token",
      takerSide: "SELL",
      priceMicros: 20_000,
      sizeMicros: 2_000_000,
      timestampMs: 101,
    });
    processor.handle({
      type: "trade",
      sourceTradeId: "cycle-sell",
      tokenId: "yes-token",
      takerSide: "BUY",
      priceMicros: 30_000,
      sizeMicros: 2_000_000,
      timestampMs: 102,
    });

    expect(database.listPaperOrders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: buy.id, status: "CANCELLED" }),
        expect.objectContaining({ side: "SELL", status: "FILLED" }),
      ]),
    );
    expect(database.validatePaperState()).toMatchObject({ passed: true });
    expect(processor.getStatus()).toMatchObject({
      processedTradeEvents: 2,
      paperBuyFillCount: 1,
      paperSellFillCount: 1,
      createdPaperSellCount: 1,
    });
  });

  it("does not fill during a gap and waits for a fresh snapshot", () => {
    const buy = database.placePaperBuy(makeCandidate(), 100_000_000);
    processor.handle({
      type: "book",
      tokenId: "yes-token",
      bids: [{ priceMicros: 20_000, sizeMicros: 5_000_000 }],
      asks: [],
      timestampMs: 100,
    });
    expect(processor.getBestBidMicros("yes-token")).toBe(20_000);
    processor.markDisconnected(["yes-token"]);
    expect(processor.getBestBidMicros("yes-token")).toBeNull();
    processor.handle({
      type: "trade",
      sourceTradeId: "gap-trade",
      tokenId: "yes-token",
      takerSide: "SELL",
      priceMicros: 20_000,
      sizeMicros: 20_000_000,
      timestampMs: 150,
    });

    expect(
      database.listPaperOrders().find((order) => order.id === buy.id)?.filledSizeMicros,
    ).toBe(0);

    processor.handle({
      type: "book",
      tokenId: "yes-token",
      bids: [{ priceMicros: 20_000, sizeMicros: 5_000_000 }],
      asks: [],
      timestampMs: 200,
    });
    processor.handle({
      type: "trade",
      sourceTradeId: "snapshot-trade",
      tokenId: "yes-token",
      takerSide: "SELL",
      priceMicros: 20_000,
      sizeMicros: 20_000_000,
      timestampMs: 200,
    });
    processor.handle({
      type: "trade",
      sourceTradeId: "new-trade",
      tokenId: "yes-token",
      takerSide: "SELL",
      priceMicros: 20_000,
      sizeMicros: 7_000_000,
      timestampMs: 201,
    });

    expect(
      database.listPaperOrders().find((order) => order.id === buy.id)?.filledSizeMicros,
    ).toBe(2_000_000);
  });

  it("does not fill an existing buy after validation pauses the strategy", () => {
    const buy = database.placePaperBuy(makeCandidate(), 100_000_000);
    database.pausePaperStrategyForValidationFailure(["Injected validation fault"]);
    processor.handle({
      type: "book",
      tokenId: "yes-token",
      bids: [{ priceMicros: 20_000, sizeMicros: 0 }],
      asks: [],
      timestampMs: 100,
    });
    processor.handle({
      type: "trade",
      sourceTradeId: "paused-buy-trade",
      tokenId: "yes-token",
      takerSide: "SELL",
      priceMicros: 20_000,
      sizeMicros: 10_000_000,
      timestampMs: 101,
    });

    expect(
      database.listPaperOrders().find((order) => order.id === buy.id)?.filledSizeMicros,
    ).toBe(0);
  });

  it("only counts trades from the opposing taker side", () => {
    const buy = database.placePaperBuy(makeCandidate(), 100_000_000);
    processor.handle({
      type: "book",
      tokenId: "yes-token",
      bids: [{ priceMicros: 20_000, sizeMicros: 0 }],
      asks: [],
      timestampMs: 100,
    });
    processor.handle({
      type: "trade",
      sourceTradeId: "same-side",
      tokenId: "yes-token",
      takerSide: "BUY",
      priceMicros: 20_000,
      sizeMicros: 10_000_000,
      timestampMs: 101,
    });

    expect(
      database.listPaperOrders().find((order) => order.id === buy.id)?.filledSizeMicros,
    ).toBe(0);
  });

  it("does not reset queue progress on routine book updates", () => {
    const buy = database.placePaperBuy(makeCandidate(), 100_000_000);
    processor.handle({
      type: "book",
      tokenId: "yes-token",
      bids: [{ priceMicros: 20_000, sizeMicros: 10_000_000 }],
      asks: [],
      timestampMs: 100,
    });
    processor.handle({
      type: "trade",
      sourceTradeId: "trade-1",
      tokenId: "yes-token",
      takerSide: "SELL",
      priceMicros: 20_000,
      sizeMicros: 5_000_000,
      timestampMs: 101,
    });
    processor.handle({
      type: "book",
      tokenId: "yes-token",
      bids: [{ priceMicros: 20_000, sizeMicros: 5_000_000 }],
      asks: [],
      timestampMs: 102,
    });
    processor.handle({
      type: "trade",
      sourceTradeId: "trade-2",
      tokenId: "yes-token",
      takerSide: "SELL",
      priceMicros: 20_000,
      sizeMicros: 7_000_000,
      timestampMs: 103,
    });

    expect(
      database.listPaperOrders().find((order) => order.id === buy.id)?.filledSizeMicros,
    ).toBe(2_000_000);
  });
});
