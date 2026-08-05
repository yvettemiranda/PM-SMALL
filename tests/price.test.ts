import { describe, expect, it } from "vitest";
import {
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
};

describe("price rules", () => {
  it("rounds the order size down to two decimals", () => {
    expect(calculateOrderSizeMicros(1_000_000, 15_000)).toBe(66_660_000);
  });

  it("calculates and rounds up the fixed sell price", () => {
    expect(calculateFixedSellPriceMicros(15_000, 5_000)).toBe(25_000);
    expect(calculateFixedSellPriceMicros(25_000, 2_500)).toBe(37_500);
  });

  it("keeps the current bid when one tick would touch the ask", () => {
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
    expect(candidate?.makerBuyPriceMicros).toBe(15_000);
    expect(candidate?.queueAheadSizeMicros).toBe(30_000_000);
  });

  it("improves the bid by one tick without crossing", () => {
    const book: TokenOrderBook = {
      tokenId: "token-1",
      conditionId: "condition-1",
      bids: [{ priceMicros: 10_000, sizeMicros: 30_000_000 }],
      asks: [{ priceMicros: 30_000, sizeMicros: 10_000_000 }],
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
    expect(candidate?.makerBuyPriceMicros).toBe(20_000);
    expect(candidate?.queueAheadSizeMicros).toBe(0);
  });
});
