import { calculateOrderSizeMicros } from "./price.js";
import { isMarketTypeEnabled, type MarketType } from "./market-type.js";

export type MarketEligibilitySettings = {
  marketTypes: readonly MarketType[];
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
  resultCount: number | null;
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

export const MARKET_ELIGIBILITY_REJECTION_REASONS = [
  "RESULT_COUNT",
  "CATEGORY",
  "GAME_START",
  "DURATION_MISSING",
  "DURATION_BELOW_MIN",
  "DURATION_ABOVE_MAX",
  "PROGRESS_MISSING",
  "PROGRESS_BELOW_ZERO",
  "PROGRESS_ABOVE_MAX",
  "BOOK_NOT_READY",
  "ASK_MISSING",
  "ASK_BELOW_MIN",
  "ASK_ABOVE_MAX",
  "BID_MISSING",
  "BID_ASK_RATIO",
  "MIN_ORDER_SIZE",
  "TICK_SIZE",
  "ORDER_BUDGET",
] as const;

export type MarketEligibilityRejectionReason =
  (typeof MARKET_ELIGIBILITY_REJECTION_REASONS)[number];

export type MarketEligibilityRejectionCounts = Record<
  MarketEligibilityRejectionReason,
  number
>;

type StaticMarketEligibilityCandidate = Pick<
  MarketEligibilityCandidate,
  | "resultCount"
  | "category"
  | "categoryIds"
  | "durationDays"
  | "progressPercent"
  | "gameStartsAt"
  | "openedAt"
  | "endsAt"
>;

export function emptyMarketEligibilityRejectionCounts(): MarketEligibilityRejectionCounts {
  return Object.fromEntries(
    MARKET_ELIGIBILITY_REJECTION_REASONS.map((reason) => [reason, 0]),
  ) as MarketEligibilityRejectionCounts;
}

export function staticMarketEligibilityRejectionReason(
  market: StaticMarketEligibilityCandidate,
  settings: MarketEligibilitySettings,
  now?: Date,
): MarketEligibilityRejectionReason | null {
  if (
    market.resultCount === null ||
    !isMarketTypeEnabled(market.resultCount, settings.marketTypes)
  ) {
    return "RESULT_COUNT";
  }

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
  if (!categoryMatches) {
    return "CATEGORY";
  }

  if (market.gameStartsAt !== null && market.gameStartsAt !== undefined) {
    const gameStartsAtMs = Date.parse(market.gameStartsAt);
    if (
      !Number.isFinite(gameStartsAtMs) ||
      (now?.getTime() ?? Date.now()) >= gameStartsAtMs
    ) {
      return "GAME_START";
    }
  }

  if (market.durationDays === null) {
    return "DURATION_MISSING";
  }
  if (market.durationDays < settings.minMarketDurationDays) {
    return "DURATION_BELOW_MIN";
  }
  if (market.durationDays > settings.maxMarketDurationDays) {
    return "DURATION_ABOVE_MAX";
  }

  const progressPercent = currentMarketProgressPercent(market, now);
  if (progressPercent === null) {
    return "PROGRESS_MISSING";
  }
  if (progressPercent < 0) {
    return "PROGRESS_BELOW_ZERO";
  }
  if (progressPercent > settings.maxMarketProgressPercent) {
    return "PROGRESS_ABOVE_MAX";
  }

  return null;
}

export function marketEligibilityRejectionReason(
  market: MarketEligibilityCandidate,
  settings: MarketEligibilitySettings,
  now?: Date,
): MarketEligibilityRejectionReason | null {
  const staticReason = staticMarketEligibilityRejectionReason(
    market,
    settings,
    now,
  );
  if (staticReason !== null) {
    return staticReason;
  }
  if (!(market.bookReady ?? true)) {
    return "BOOK_NOT_READY";
  }

  const bestAskMicros = market.bestAskMicros;
  if (bestAskMicros === null) {
    return "ASK_MISSING";
  }
  if (bestAskMicros < settings.minBuyPriceMicros) {
    return "ASK_BELOW_MIN";
  }
  if (bestAskMicros > settings.maxBuyPriceMicros) {
    return "ASK_ABOVE_MAX";
  }

  const bestBidMicros = market.bestBidMicros;
  if (bestBidMicros === null || bestBidMicros <= 0) {
    return "BID_MISSING";
  }
  if (
    !meetsBidAskRatio(
      bestBidMicros,
      bestAskMicros,
      settings.minBidAskRatioPercent,
    )
  ) {
    return "BID_ASK_RATIO";
  }

  const minOrderSizeMicros = market.minOrderSizeMicros;
  if (
    minOrderSizeMicros === null ||
    minOrderSizeMicros === undefined ||
    minOrderSizeMicros <= 0
  ) {
    return "MIN_ORDER_SIZE";
  }
  const tickSizeMicros = market.tickSizeMicros;
  if (
    tickSizeMicros === null ||
    tickSizeMicros === undefined ||
    tickSizeMicros <= 0
  ) {
    return "TICK_SIZE";
  }
  if (
    calculateOrderSizeMicros(settings.orderBudgetMicros, bestAskMicros) <
    minOrderSizeMicros
  ) {
    return "ORDER_BUDGET";
  }
  return null;
}

export function isMarketEligible(
  market: MarketEligibilityCandidate,
  settings: MarketEligibilitySettings,
  now?: Date,
): boolean {
  return marketEligibilityRejectionReason(market, settings, now) === null;
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
