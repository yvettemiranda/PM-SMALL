import type { BookLevel, MarketToken, TokenOrderBook, TradeCandidate } from "./types.js";

export const DECIMAL_SCALE = 1_000_000;

export function decimalStringToMicros(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid decimal value: ${value}`);
  }
  return Math.round(parsed * DECIMAL_SCALE);
}

export function microsToDecimalString(value: number): string {
  return (value / DECIMAL_SCALE).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function calculateOrderSizeMicros(
  budgetMicros: number,
  priceMicros: number,
): number {
  if (budgetMicros <= 0 || priceMicros <= 0) {
    return 0;
  }

  const sizeHundredths =
    (BigInt(budgetMicros) * 100n) / BigInt(priceMicros);
  return Number(sizeHundredths * 10_000n);
}

export function calculateOrderCostMicros(
  priceMicros: number,
  sizeMicros: number,
): number {
  return Number(
    (BigInt(priceMicros) * BigInt(sizeMicros)) / BigInt(DECIMAL_SCALE),
  );
}

export function roundUpToTick(valueMicros: number, tickMicros: number): number {
  if (tickMicros <= 0) {
    throw new Error("Tick size must be positive");
  }
  return Math.ceil(valueMicros / tickMicros) * tickMicros;
}

export function calculateFixedSellPriceMicros(
  buyPriceMicros: number,
  tickMicros: number,
): number {
  const plusOneCent = buyPriceMicros + 10_000;
  const fiftyPercentProfit = Math.ceil(buyPriceMicros * 1.5);
  return roundUpToTick(Math.max(plusOneCent, fiftyPercentProfit), tickMicros);
}

function bestBid(bids: BookLevel[]): BookLevel | null {
  return bids.reduce<BookLevel | null>(
    (best, level) => (best === null || level.priceMicros > best.priceMicros ? level : best),
    null,
  );
}

function bestAsk(asks: BookLevel[]): BookLevel | null {
  return asks.reduce<BookLevel | null>(
    (best, level) => (best === null || level.priceMicros < best.priceMicros ? level : best),
    null,
  );
}

export function buildTradeCandidate(
  token: MarketToken,
  book: TokenOrderBook,
  orderBudgetMicros: number,
  minBuyPriceMicros: number,
  maxBuyPriceMicros: number,
): TradeCandidate | null {
  const bid = bestBid(book.bids);
  const ask = bestAsk(book.asks);

  if (bid === null || bid.priceMicros > maxBuyPriceMicros) {
    return null;
  }

  const improvedPrice = bid.priceMicros + book.tickSizeMicros;
  const makerPrice =
    improvedPrice <= maxBuyPriceMicros &&
    (ask === null || improvedPrice < ask.priceMicros)
      ? improvedPrice
      : bid.priceMicros;

  if (makerPrice < minBuyPriceMicros || makerPrice > maxBuyPriceMicros) {
    return null;
  }

  const orderSizeMicros = calculateOrderSizeMicros(orderBudgetMicros, makerPrice);
  if (orderSizeMicros < book.minOrderSizeMicros) {
    return null;
  }

  const queueAheadSizeMicros = book.bids
    .filter((level) => level.priceMicros === makerPrice)
    .reduce((sum, level) => sum + level.sizeMicros, 0);

  return {
    ...token,
    candidateId: `${token.tokenId}:${makerPrice}`,
    bestBidMicros: bid.priceMicros,
    bestAskMicros: ask?.priceMicros ?? null,
    makerBuyPriceMicros: makerPrice,
    fixedSellPriceMicros: calculateFixedSellPriceMicros(
      makerPrice,
      book.tickSizeMicros,
    ),
    orderSizeMicros,
    queueAheadSizeMicros,
    minOrderSizeMicros: book.minOrderSizeMicros,
    tickSizeMicros: book.tickSizeMicros,
  };
}
