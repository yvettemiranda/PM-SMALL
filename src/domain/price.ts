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
    (best, level) =>
      level.sizeMicros > 0 &&
      level.priceMicros > 0 &&
      level.priceMicros < DECIMAL_SCALE &&
      (best === null || level.priceMicros > best.priceMicros)
        ? level
        : best,
    null,
  );
}

function bestAsk(asks: BookLevel[]): BookLevel | null {
  return asks.reduce<BookLevel | null>(
    (best, level) =>
      level.sizeMicros > 0 &&
      level.priceMicros > 0 &&
      level.priceMicros < DECIMAL_SCALE &&
      (best === null || level.priceMicros < best.priceMicros)
        ? level
        : best,
    null,
  );
}

export function buildMonitoredCandidate(
  token: MarketToken,
  book: TokenOrderBook,
  orderBudgetMicros: number,
): TradeCandidate | null {
  if (book.minOrderSizeMicros <= 0 || book.tickSizeMicros <= 0) {
    return null;
  }
  const bid = bestBid(book.bids);
  const ask = bestAsk(book.asks);
  const executableBuyPriceMicros = ask?.priceMicros ?? 0;
  const orderSizeMicros =
    executableBuyPriceMicros === 0
      ? 0
      : calculateOrderSizeMicros(orderBudgetMicros, executableBuyPriceMicros);

  return {
    ...token,
    candidateId: token.tokenId,
    bestBidMicros: bid?.priceMicros ?? null,
    bestAskMicros: ask?.priceMicros ?? null,
    executableBuyPriceMicros,
    // Retain the old property during the schema/API transition, but give it
    // the executable taker price so no caller can accidentally post a maker bid.
    makerBuyPriceMicros: executableBuyPriceMicros,
    fixedSellPriceMicros:
      executableBuyPriceMicros === 0
        ? 0
        : calculateFixedSellPriceMicros(
            executableBuyPriceMicros,
            book.tickSizeMicros,
          ),
    orderSizeMicros,
    queueAheadSizeMicros: 0,
    minOrderSizeMicros: book.minOrderSizeMicros,
    tickSizeMicros: book.tickSizeMicros,
  };
}

export function buildTradeCandidate(
  token: MarketToken,
  book: TokenOrderBook,
  orderBudgetMicros: number,
  minBuyPriceMicros: number,
  maxBuyPriceMicros: number,
): TradeCandidate | null {
  const candidate = buildMonitoredCandidate(token, book, orderBudgetMicros);

  if (
    candidate === null ||
    candidate.bestAskMicros === null ||
    candidate.bestAskMicros < minBuyPriceMicros ||
    candidate.bestAskMicros > maxBuyPriceMicros ||
    candidate.orderSizeMicros < candidate.minOrderSizeMicros
  ) {
    return null;
  }
  return candidate;
}
