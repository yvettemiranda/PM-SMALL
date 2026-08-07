import { calculateOrderSizeMicros } from "./price.js";

export type MarketEligibilitySettings = {
  resultCounts: readonly (2 | 3)[];
  allCategories: boolean;
  selectedCategoryIds: readonly string[];
  minBuyPriceMicros: number;
  maxBuyPriceMicros: number;
  minBidAskRatioPercent: number;
  minMarketDurationDays: number;
  maxMarketDurationDays: number;
  maxMarketProgressPercent: number;
  orderBudgetMicros: number;
};

export type MarketEligibilityCandidate = {
  resultCount: 2 | 3 | null;
  category?: string | null;
  categoryIds?: readonly string[] | null;
  bestBidMicros: number | null;
  bestAskMicros: number | null;
  bookReady?: boolean;
  durationDays: number | null;
  progressPercent?: number | null;
  minOrderSizeMicros?: number | null;
  tickSizeMicros?: number | null;
  gameStartsAt?: string | null;
  openedAt?: string | null;
  endsAt?: string | null;
};

export function isMarketEligible(
  market: MarketEligibilityCandidate,
  settings: MarketEligibilitySettings,
  now?: Date,
): boolean {
  const progressPercent = currentMarketProgressPercent(market, now);
  const categoryIds =
    market.categoryIds?.filter((categoryId) => categoryId.length > 0) ?? [];
  const legacyCategory = market.category?.trim();
  const categoryMatches =
    settings.allCategories ||
    categoryIds.some((categoryId) =>
      settings.selectedCategoryIds.includes(categoryId),
    ) ||
    (categoryIds.length === 0 &&
      legacyCategory !== undefined &&
      legacyCategory.length > 0 &&
      settings.selectedCategoryIds.includes(legacyCategory));
  const bestBidMicros = market.bestBidMicros;
  const bestAskMicros = market.bestAskMicros;
  const minOrderSizeMicros = market.minOrderSizeMicros;
  const tickSizeMicros = market.tickSizeMicros;
  const gameStartsAtMs =
    market.gameStartsAt === null || market.gameStartsAt === undefined
      ? null
      : Date.parse(market.gameStartsAt);
  const beforeGameStart =
    gameStartsAtMs === null ||
    (Number.isFinite(gameStartsAtMs) &&
      (now?.getTime() ?? Date.now()) < gameStartsAtMs);

  return (
    (market.bookReady ?? true) &&
    market.resultCount !== null &&
    settings.resultCounts.includes(market.resultCount) &&
    categoryMatches &&
    beforeGameStart &&
    bestAskMicros !== null &&
    bestAskMicros >= settings.minBuyPriceMicros &&
    bestAskMicros <= settings.maxBuyPriceMicros &&
    bestBidMicros !== null &&
    bestBidMicros > 0 &&
    meetsBidAskRatio(
      bestBidMicros,
      bestAskMicros,
      settings.minBidAskRatioPercent,
    ) &&
    minOrderSizeMicros !== null &&
    minOrderSizeMicros !== undefined &&
    minOrderSizeMicros > 0 &&
    tickSizeMicros !== null &&
    tickSizeMicros !== undefined &&
    tickSizeMicros > 0 &&
    calculateOrderSizeMicros(settings.orderBudgetMicros, bestAskMicros) >=
      minOrderSizeMicros &&
    market.durationDays !== null &&
    market.durationDays >= settings.minMarketDurationDays &&
    market.durationDays <= settings.maxMarketDurationDays &&
    progressPercent !== null &&
    progressPercent >= 0 &&
    progressPercent <= settings.maxMarketProgressPercent
  );
}

export function currentMarketProgressPercent(
  market: Pick<
    MarketEligibilityCandidate,
    "progressPercent" | "openedAt" | "endsAt"
  >,
  now?: Date,
): number | null {
  if (now === undefined && Number.isFinite(market.progressPercent)) {
    return market.progressPercent as number;
  }
  const openedAt = Date.parse(market.openedAt ?? "");
  const endsAt = Date.parse(market.endsAt ?? "");
  if (
    now === undefined ||
    !Number.isFinite(openedAt) ||
    !Number.isFinite(endsAt) ||
    endsAt <= openedAt
  ) {
    return Number.isFinite(market.progressPercent)
      ? (market.progressPercent as number)
      : null;
  }
  return ((now.getTime() - openedAt) / (endsAt - openedAt)) * 100;
}

function meetsBidAskRatio(
  bestBidMicros: number,
  bestAskMicros: number,
  minimumPercent: number,
): boolean {
  if (bestAskMicros <= 0) {
    return false;
  }
  return (
    BigInt(bestBidMicros) * 100n >=
    BigInt(bestAskMicros) * BigInt(minimumPercent)
  );
}
