import type { BookLevel, MarketToken, TokenOrderBook, TradeCandidate } from "./types.js";

export const DECIMAL_SCALE = 1_000_000;
export const MIN_BUY_PRICE_MICROS = 1_000;
export const MAX_BUY_PRICE_MICROS = 990_000;
export const DEFAULT_TARGET_SELL_PRICE_INCREASE_MICROS = 10_000;
export const DEFAULT_TARGET_SELL_PRICE_MULTIPLIER_MICROS = 1_500_000;
export const MAX_TARGET_SELL_PRICE_MICROS = 990_000;

export type TargetSellPriceSettings = {
  increaseMicros: number;
  multiplierMicros: number;
};

export const DEFAULT_TARGET_SELL_PRICE_SETTINGS: TargetSellPriceSettings = {
  increaseMicros: DEFAULT_TARGET_SELL_PRICE_INCREASE_MICROS,
  multiplierMicros: DEFAULT_TARGET_SELL_PRICE_MULTIPLIER_MICROS,
};

export function decimalStringToMicros(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid decimal value: ${value}`);
  }
  const micros = Math.round(parsed * DECIMAL_SCALE);
  if (!Number.isSafeInteger(micros)) {
    throw new Error(`Decimal value exceeds the supported range: ${value}`);
  }
  return micros;
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
  settings: TargetSellPriceSettings = DEFAULT_TARGET_SELL_PRICE_SETTINGS,
): number {
  if (
    !Number.isSafeInteger(buyPriceMicros) ||
    buyPriceMicros <= 0 ||
    !Number.isSafeInteger(settings.increaseMicros) ||
    settings.increaseMicros < 0 ||
    !Number.isSafeInteger(settings.multiplierMicros) ||
    settings.multiplierMicros < 0
  ) {
    throw new Error("Target sell-price settings must be non-negative safe integers");
  }
  const additiveTarget = BigInt(buyPriceMicros) + BigInt(settings.increaseMicros);
  const multipliedNumerator =
    BigInt(buyPriceMicros) * BigInt(settings.multiplierMicros);
  const multipliedTarget =
    (multipliedNumerator + BigInt(DECIMAL_SCALE - 1)) /
    BigInt(DECIMAL_SCALE);
  const rawTarget =
    additiveTarget >= multipliedTarget ? additiveTarget : multipliedTarget;
  if (rawTarget >= BigInt(MAX_TARGET_SELL_PRICE_MICROS)) {
    return MAX_TARGET_SELL_PRICE_MICROS;
  }
  return Math.min(
    roundUpToTick(Number(rawTarget), tickMicros),
    MAX_TARGET_SELL_PRICE_MICROS,
  );
}

export function bestBidLevel(bids: readonly BookLevel[]): BookLevel | null {
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

export function bestAskLevel(asks: readonly BookLevel[]): BookLevel | null {
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
  book: TokenOrderBook | null,
  orderBudgetMicros: number,
  targetSellPriceSettings: TargetSellPriceSettings =
    DEFAULT_TARGET_SELL_PRICE_SETTINGS,
): TradeCandidate {
  const minOrderSizeMicros =
    book?.minOrderSizeMicros ?? token.minOrderSizeMicros;
  const tickSizeMicros = book?.tickSizeMicros ?? token.tickSizeMicros;
  const bookReady =
    book !== null && minOrderSizeMicros > 0 && tickSizeMicros > 0;
  const bid = bookReady ? bestBidLevel(book.bids) : null;
  const ask = bookReady ? bestAskLevel(book.asks) : null;
  const executableBuyPriceMicros = ask?.priceMicros ?? 0;
  const orderSizeMicros =
    executableBuyPriceMicros === 0
      ? 0
      : calculateOrderSizeMicros(orderBudgetMicros, executableBuyPriceMicros);

  return {
    ...token,
    candidateId: token.tokenId,
    bookReady,
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
            tickSizeMicros,
            targetSellPriceSettings,
          ),
    orderSizeMicros,
    queueAheadSizeMicros: 0,
    minOrderSizeMicros,
    tickSizeMicros,
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
    !candidate.bookReady ||
    candidate.bestAskMicros === null ||
    candidate.bestAskMicros < minBuyPriceMicros ||
    candidate.bestAskMicros > maxBuyPriceMicros ||
    candidate.orderSizeMicros < candidate.minOrderSizeMicros
  ) {
    return null;
  }
  return candidate;
}
