import { describe, expect, it } from "vitest";
import {
  buildMonitoredCandidate,
  buildTradeCandidate,
  calculateFixedSellPriceMicros,
  calculateOrderSizeMicros,
} from "../src/domain/price.js";
import type { MarketToken, TokenOrderBook } from "../src/domain/types.js";

const token: MarketToken = {
  eventId: "event-1",
  eventSlug: "event",
  eventTitle: "Event",
  category: "Tech",
  resultCount: 2,
  isNegativeRisk: false,
  marketId: "market-1",
  conditionId: "condition-1",
  marketQuestion: "Question",
  direction: "YES",
  tokenId: "token-1",
  openedAt: "2026-01-01T00:00:00.000Z",
  endsAt: "2026-01-10T00:00:00.000Z",
  durationDays: 9,
  progressPercent: 10,
  gameStartsAt: null,
  feesEnabled: false,
  feeRateMicros: 0,
  feeExponent: 1,
};

describe("price rules", () => {
  it("rounds the order size down to two decimals", () => {
    expect(calculateOrderSizeMicros(1_000_000, 15_000)).toBe(66_660_000);
  });

  it("calculates and rounds up the fixed sell price", () => {
    expect(calculateFixedSellPriceMicros(15_000, 5_000)).toBe(25_000);
    expect(calculateFixedSellPriceMicros(25_000, 2_500)).toBe(37_500);
  });

  it("uses the executable best ask instead of posting a maker bid", () => {
    const book: TokenOrderBook = {
      tokenId: "token-1",
      conditionId: "condition-1",
      bids: [{ priceMicros: 15_000, sizeMicros: 30_000_000 }],
      asks: [{ priceMicros: 20_000, sizeMicros: 10_000_000 }],
      minOrderSizeMicros: 5_000_000,
      tickSizeMicros: 5_000,
      isNegativeRisk: false,
    };
    const candidate = buildTradeCandidate(
      token,
      book,
      1_000_000,
      10_000,
      30_000,
    );
    expect(candidate?.executableBuyPriceMicros).toBe(20_000);
    expect(candidate?.bestAskMicros).toBe(20_000);
    expect(candidate?.queueAheadSizeMicros).toBe(0);
  });

  it("rejects a market whose executable ask is above the configured cap", () => {
    const book: TokenOrderBook = {
      tokenId: "token-1",
      conditionId: "condition-1",
      bids: [{ priceMicros: 10_000, sizeMicros: 30_000_000 }],
      asks: [{ priceMicros: 40_000, sizeMicros: 10_000_000 }],
      minOrderSizeMicros: 5_000_000,
      tickSizeMicros: 10_000,
      isNegativeRisk: false,
    };
    const candidate = buildTradeCandidate(
      token,
      book,
      1_000_000,
      10_000,
      30_000,
    );
    expect(candidate).toBeNull();
  });

  it("keeps an above-cap order book available for realtime monitoring", () => {
    const book: TokenOrderBook = {
      tokenId: "token-1",
      conditionId: "condition-1",
      bids: [{ priceMicros: 30_000, sizeMicros: 30_000_000 }],
      asks: [{ priceMicros: 40_000, sizeMicros: 10_000_000 }],
      minOrderSizeMicros: 5_000_000,
      tickSizeMicros: 10_000,
      isNegativeRisk: false,
    };

    expect(buildMonitoredCandidate(token, book, 1_000_000)).toMatchObject({
      tokenId: "token-1",
      bestAskMicros: 40_000,
      executableBuyPriceMicros: 40_000,
    });
  });

  it("keeps an empty order book monitored until an executable ask appears", () => {
    const book: TokenOrderBook = {
      tokenId: "token-1",
      conditionId: "condition-1",
      bids: [],
      asks: [],
      minOrderSizeMicros: 5_000_000,
      tickSizeMicros: 10_000,
      isNegativeRisk: false,
    };

    expect(buildMonitoredCandidate(token, book, 1_000_000)).toMatchObject({
      tokenId: "token-1",
      bestBidMicros: null,
      bestAskMicros: null,
      executableBuyPriceMicros: 0,
      orderSizeMicros: 0,
    });
  });

  it("rejects a market without an executable ask even when it has a low bid", () => {
    const book: TokenOrderBook = {
      tokenId: "token-1",
      conditionId: "condition-1",
      bids: [{ priceMicros: 10_000, sizeMicros: 30_000_000 }],
      asks: [],
      minOrderSizeMicros: 5_000_000,
      tickSizeMicros: 10_000,
      isNegativeRisk: false,
    };

    expect(
      buildTradeCandidate(token, book, 1_000_000, 10_000, 30_000),
    ).toBeNull();
  });
});
