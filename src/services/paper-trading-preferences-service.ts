import type { AppConfig } from "../config.js";
import {
  normalizeMarketTypes,
  type MarketType,
} from "../domain/market-type.js";
import {
  currentMarketProgressPercent,
  isMarketEligible,
  staticMarketEligibilityRejectionReason,
  type MarketEligibilityCandidate,
  type MarketEligibilitySettings,
} from "../domain/market-eligibility.js";
import type { MarketScanPreferences } from "../domain/market-scanner.js";
import {
  sortTradeCandidates,
  type CandidateSortDirection,
} from "../domain/trading-strategy.js";
import {
  DEFAULT_TARGET_SELL_PRICE_INCREASE_MICROS,
  DEFAULT_TARGET_SELL_PRICE_MULTIPLIER_MICROS,
  MAX_BUY_PRICE_MICROS,
  MAX_TARGET_SELL_PRICE_MICROS,
  MIN_BUY_PRICE_MICROS,
  type TargetSellPriceSettings,
} from "../domain/price.js";
import type { TradeCandidate } from "../domain/types.js";
import type { PaperDatabase } from "../infrastructure/db/database.js";

const MIN_MARKET_DURATION_DAYS = 1;
const MAX_MARKET_DURATION_DAYS = 365;

export type PaperTradingPreferencesSnapshot = {
  marketTypes: MarketType[];
  allCategories: boolean;
  selectedCategories: string[];
  candidateSortDirection: CandidateSortDirection;
  orderBudgetMicros: number;
  minBuyPriceMicros: number;
  maxBuyPriceMicros: number;
  targetSellPriceIncreaseMicros: number;
  targetSellPriceMultiplierMicros: number;
  minBidAskRatioPercent: number;
  minMarketDurationDays: number;
  maxMarketDurationDays: number;
  maxMarketProgressPercent: number;
  candidatesSelectedByDefault: boolean;
  updatedAt: string;
};

const RESET_TEST_INITIAL_CAPITAL_MICROS = 100_000_000;
const RESET_TEST_PREFERENCES: Omit<
  PaperTradingPreferencesSnapshot,
  "updatedAt"
> = {
  marketTypes: ["BINARY", "TERNARY"],
  allCategories: true,
  selectedCategories: [],
  candidateSortDirection: "ASC",
  orderBudgetMicros: 1_000_000,
  minBuyPriceMicros: MIN_BUY_PRICE_MICROS,
  maxBuyPriceMicros: MAX_BUY_PRICE_MICROS,
  targetSellPriceIncreaseMicros:
    DEFAULT_TARGET_SELL_PRICE_INCREASE_MICROS,
  targetSellPriceMultiplierMicros:
    DEFAULT_TARGET_SELL_PRICE_MULTIPLIER_MICROS,
  minBidAskRatioPercent: 50,
  minMarketDurationDays: 1,
  maxMarketDurationDays: 30,
  maxMarketProgressPercent: 20,
  candidatesSelectedByDefault: true,
};

type MarketFilterUpdate = Pick<
  PaperTradingPreferencesSnapshot,
  "marketTypes" | "maxBuyPriceMicros" | "maxMarketDurationDays"
> & {
  minBuyPriceMicros?: number;
  targetSellPriceIncreaseMicros?: number;
  targetSellPriceMultiplierMicros?: number;
  minMarketDurationDays?: number;
  allCategories?: boolean;
  selectedCategories?: readonly string[];
  candidateSortDirection?: CandidateSortDirection;
  orderBudgetMicros?: number;
  minBidAskRatioPercent?: number;
  maxMarketProgressPercent?: number;
};

type NormalizedMarketFilters = Pick<
  PaperTradingPreferencesSnapshot,
  | "marketTypes"
  | "minBuyPriceMicros"
  | "maxBuyPriceMicros"
  | "targetSellPriceIncreaseMicros"
  | "targetSellPriceMultiplierMicros"
  | "minBidAskRatioPercent"
  | "minMarketDurationDays"
  | "maxMarketDurationDays"
  | "maxMarketProgressPercent"
  | "allCategories"
  | "selectedCategories"
  | "candidateSortDirection"
  | "orderBudgetMicros"
>;

export type PaperMarketFilterUpdateResult = {
  preferences: PaperTradingPreferencesSnapshot;
  cancelledBuyCount: number;
};

export class PaperTradingPreferencesService {
  private snapshot: PaperTradingPreferencesSnapshot;
  private readonly defaults: Omit<PaperTradingPreferencesSnapshot, "updatedAt">;

  public constructor(
    private readonly database: PaperDatabase,
    config: AppConfig,
  ) {
    this.defaults = {
      marketTypes: ["BINARY", "TERNARY"],
      allCategories: true,
      selectedCategories: [],
      candidateSortDirection: "ASC",
      orderBudgetMicros: config.orderBudgetMicros,
      minBuyPriceMicros: config.minBuyPriceMicros,
      maxBuyPriceMicros: config.maxBuyPriceMicros,
      targetSellPriceIncreaseMicros: config.targetSellPriceIncreaseMicros,
      targetSellPriceMultiplierMicros: config.targetSellPriceMultiplierMicros,
      minBidAskRatioPercent: config.minBidAskRatioPercent,
      minMarketDurationDays: config.minMarketDurationDays,
      maxMarketDurationDays: config.maxMarketDurationDays,
      maxMarketProgressPercent: config.maxMarketProgressPercent,
      candidatesSelectedByDefault: true,
    } satisfies Omit<PaperTradingPreferencesSnapshot, "updatedAt">;
    validateMarketFilterValues(this.defaults);
    this.snapshot = database.ensurePaperTradingPreferences(this.defaults);
    validateMarketFilterValues(this.snapshot);
  }

  public getSnapshot(): PaperTradingPreferencesSnapshot {
    return {
      ...this.snapshot,
      marketTypes: [...this.snapshot.marketTypes],
      selectedCategories: [...this.snapshot.selectedCategories],
    };
  }

  public resetTestState(): void {
    const result = this.database.resetTestState(
      RESET_TEST_INITIAL_CAPITAL_MICROS,
      RESET_TEST_PREFERENCES,
    );
    this.snapshot = result.preferences;
  }

  public reload(): void {
    this.snapshot = this.database.getPaperTradingPreferences();
  }

  public getMarketScanPreferences(): MarketScanPreferences {
    return {
      marketTypes: [...this.snapshot.marketTypes],
      minBuyPriceMicros: this.snapshot.minBuyPriceMicros,
      maxBuyPriceMicros: this.snapshot.maxBuyPriceMicros,
      targetSellPriceIncreaseMicros:
        this.snapshot.targetSellPriceIncreaseMicros,
      targetSellPriceMultiplierMicros:
        this.snapshot.targetSellPriceMultiplierMicros,
      minBidAskRatioPercent: this.snapshot.minBidAskRatioPercent,
      minMarketDurationDays: this.snapshot.minMarketDurationDays,
      maxMarketDurationDays: this.snapshot.maxMarketDurationDays,
      maxMarketProgressPercent: this.snapshot.maxMarketProgressPercent,
      allCategories: this.snapshot.allCategories,
      selectedCategories: [...this.snapshot.selectedCategories],
      candidateSortDirection: this.snapshot.candidateSortDirection,
      orderBudgetMicros: this.snapshot.orderBudgetMicros,
    };
  }

  public getMaxBuyPriceMicros(): number {
    return this.snapshot.maxBuyPriceMicros;
  }

  public getTargetSellPriceSettings(): TargetSellPriceSettings {
    return {
      increaseMicros: this.snapshot.targetSellPriceIncreaseMicros,
      multiplierMicros: this.snapshot.targetSellPriceMultiplierMicros,
    };
  }

  public getOrderBudgetMicros(): number {
    return this.snapshot.orderBudgetMicros;
  }

  public getEligibilitySettings(): MarketEligibilitySettings {
    return toEligibilitySettings(this.snapshot);
  }

  public getCandidateSortDirection(): CandidateSortDirection {
    return this.snapshot.candidateSortDirection;
  }

  public getStateVersion(): string {
    return JSON.stringify(this.snapshot);
  }

  public candidateMatchesStaticFilters(
    candidate: TradeCandidate,
    now?: Date,
  ): boolean {
    return (
      staticMarketEligibilityRejectionReason(
        candidate,
        this.getEligibilitySettings(),
        now,
      ) === null
    );
  }

  public getOrderedCandidates(
    candidates: readonly TradeCandidate[],
    now: Date = new Date(),
  ): TradeCandidate[] {
    const currentCandidates = candidates
      .map((candidate) => ({
        ...candidate,
        progressPercent:
          currentMarketProgressPercent(candidate, now) ?? candidate.progressPercent,
      }))
      .filter((candidate) => this.candidateMatchesMarketFilters(candidate, now));
    return sortTradeCandidates(
      currentCandidates,
      this.snapshot.candidateSortDirection,
    );
  }

  public updateMarketFilters(
    update: MarketFilterUpdate,
  ): PaperMarketFilterUpdateResult {
    const marketTypes = normalizeSelectedMarketTypes(update.marketTypes);

    const normalizedUpdate: NormalizedMarketFilters = {
      marketTypes,
      minBuyPriceMicros:
        update.minBuyPriceMicros ?? this.snapshot.minBuyPriceMicros,
      maxBuyPriceMicros: update.maxBuyPriceMicros,
      targetSellPriceIncreaseMicros:
        update.targetSellPriceIncreaseMicros ??
        this.snapshot.targetSellPriceIncreaseMicros,
      targetSellPriceMultiplierMicros:
        update.targetSellPriceMultiplierMicros ??
        this.snapshot.targetSellPriceMultiplierMicros,
      minBidAskRatioPercent:
        update.minBidAskRatioPercent ?? this.snapshot.minBidAskRatioPercent,
      minMarketDurationDays:
        update.minMarketDurationDays ?? this.snapshot.minMarketDurationDays,
      maxMarketDurationDays: update.maxMarketDurationDays,
      maxMarketProgressPercent:
        update.maxMarketProgressPercent ?? this.snapshot.maxMarketProgressPercent,
      allCategories: update.allCategories ?? this.snapshot.allCategories,
      selectedCategories: normalizeCategories(
        update.selectedCategories ?? this.snapshot.selectedCategories,
      ),
      candidateSortDirection:
        update.candidateSortDirection ?? this.snapshot.candidateSortDirection,
      orderBudgetMicros:
        update.orderBudgetMicros ?? this.snapshot.orderBudgetMicros,
    };
    validateMarketFilterValues(normalizedUpdate);
    if (
      normalizedUpdate.orderBudgetMicros >
      this.database.getStrategyState().initialCapitalMicros
    ) {
      throw new Error("Per-Event cycle TEST amount cannot exceed total TEST capital");
    }
    const result = this.database.updatePaperTradingPreferences(
      {
        ...this.snapshot,
        ...normalizedUpdate,
      },
      this.ineligibleActiveBuyTokenIds(normalizedUpdate, new Date()),
    );
    this.snapshot = result.preferences;
    return {
      preferences: this.getSnapshot(),
      cancelledBuyCount: result.cancelledBuyCount,
    };
  }

  public candidateMatchesMarketFilters(
    candidate: MarketEligibilityCandidate,
    now?: Date,
  ): boolean {
    return marketMatchesFilters(candidate, this.snapshot, now);
  }

  public isCandidateEnabled(candidate: TradeCandidate, now?: Date): boolean {
    return this.candidateMatchesMarketFilters(candidate, now);
  }

  public reconcileActiveBuys(now: Date = new Date()): number {
    const tokenIds = this.ineligibleActiveBuyTokenIds(this.snapshot, now);
    if (tokenIds.length === 0) {
      return 0;
    }
    const result = this.database.updatePaperTradingPreferences(
      this.snapshot,
      tokenIds,
    );
    this.snapshot = result.preferences;
    return result.cancelledBuyCount;
  }

  private ineligibleActiveBuyTokenIds(
    filters: NormalizedMarketFilters,
    now: Date,
  ): string[] {
    return this.database
      .listActivePaperBuyMarkets()
      .filter(
        (market) =>
          !marketMatchesFilters(market, filters, now),
      )
      .map((market) => market.tokenId);
  }
}

function marketMatchesFilters(
  market: MarketEligibilityCandidate,
  filters: NormalizedMarketFilters,
  now?: Date,
): boolean {
  return isMarketEligible(market, toEligibilitySettings(filters), now);
}

function toEligibilitySettings(
  filters: NormalizedMarketFilters,
): MarketEligibilitySettings {
  return {
    marketTypes: filters.marketTypes,
    allCategories: filters.allCategories,
    selectedCategoryIds: filters.selectedCategories,
    minBuyPriceMicros: filters.minBuyPriceMicros,
    maxBuyPriceMicros: filters.maxBuyPriceMicros,
    minBidAskRatioPercent: filters.minBidAskRatioPercent,
    minMarketDurationDays: filters.minMarketDurationDays,
    maxMarketDurationDays: filters.maxMarketDurationDays,
    maxMarketProgressPercent: filters.maxMarketProgressPercent,
    orderBudgetMicros: filters.orderBudgetMicros,
  };
}

function validateMarketFilterValues(
  values: Pick<
    PaperTradingPreferencesSnapshot,
    | "minBuyPriceMicros"
    | "maxBuyPriceMicros"
    | "targetSellPriceIncreaseMicros"
    | "targetSellPriceMultiplierMicros"
    | "minBidAskRatioPercent"
    | "minMarketDurationDays"
    | "maxMarketDurationDays"
    | "maxMarketProgressPercent"
    | "orderBudgetMicros"
  >,
): void {
  if (
    !isTenthCentValue(values.minBuyPriceMicros) ||
    values.minBuyPriceMicros < MIN_BUY_PRICE_MICROS ||
    values.minBuyPriceMicros > MAX_BUY_PRICE_MICROS
  ) {
    throw new Error("Minimum TEST buy price must be from 0.1 to 99 cents");
  }
  if (
    !isTenthCentValue(values.maxBuyPriceMicros) ||
    values.maxBuyPriceMicros < MIN_BUY_PRICE_MICROS ||
    values.maxBuyPriceMicros > MAX_BUY_PRICE_MICROS
  ) {
    throw new Error("Maximum TEST buy price must be from 0.1 to 99 cents");
  }
  if (values.minBuyPriceMicros > values.maxBuyPriceMicros) {
    throw new Error("Minimum TEST buy price cannot exceed maximum TEST buy price");
  }
  if (
    !Number.isSafeInteger(values.targetSellPriceIncreaseMicros) ||
    values.targetSellPriceIncreaseMicros < 0 ||
    values.targetSellPriceIncreaseMicros > MAX_TARGET_SELL_PRICE_MICROS
  ) {
    throw new Error("Target sell-price increase must be from 0 to 99 cents");
  }
  if (
    !Number.isSafeInteger(values.targetSellPriceMultiplierMicros) ||
    values.targetSellPriceMultiplierMicros < 0
  ) {
    throw new Error("Target sell-price multiplier must be non-negative");
  }
  if (
    !Number.isInteger(values.minMarketDurationDays) ||
    values.minMarketDurationDays < MIN_MARKET_DURATION_DAYS ||
    values.minMarketDurationDays > MAX_MARKET_DURATION_DAYS
  ) {
    throw new Error("Minimum market duration must be a whole day from 1 to 365");
  }
  if (
    !Number.isInteger(values.maxMarketDurationDays) ||
    values.maxMarketDurationDays < MIN_MARKET_DURATION_DAYS ||
    values.maxMarketDurationDays > MAX_MARKET_DURATION_DAYS
  ) {
    throw new Error("Maximum market duration must be a whole day from 1 to 365");
  }
  if (values.minMarketDurationDays > values.maxMarketDurationDays) {
    throw new Error("Minimum market duration cannot exceed maximum market duration");
  }
  if (
    !Number.isInteger(values.minBidAskRatioPercent) ||
    values.minBidAskRatioPercent < 1 ||
    values.minBidAskRatioPercent > 100
  ) {
    throw new Error("Minimum bid/ask ratio must be an integer from 1 to 100 percent");
  }
  if (
    !Number.isInteger(values.maxMarketProgressPercent) ||
    values.maxMarketProgressPercent < 1 ||
    values.maxMarketProgressPercent > 100
  ) {
    throw new Error("Maximum market progress must be an integer from 1 to 100 percent");
  }
  if (!Number.isSafeInteger(values.orderBudgetMicros) || values.orderBudgetMicros <= 0) {
    throw new Error("Per-Event cycle TEST amount must be positive");
  }
}

function isTenthCentValue(value: number): boolean {
  return Number.isSafeInteger(value) && value % 1_000 === 0;
}

function normalizeSelectedMarketTypes(
  marketTypes: readonly MarketType[],
): MarketType[] {
  const normalized = normalizeMarketTypes(marketTypes);
  if (normalized.length === 0) {
    throw new Error("Select at least one TEST market type");
  }
  if (normalized.length !== new Set(marketTypes).size) {
    throw new Error("TEST market types contain an unsupported value");
  }
  return normalized;
}

function normalizeCategories(categories: readonly string[]): string[] {
  return Array.from(
    new Set(categories.map((category) => category.trim()).filter(Boolean)),
  ).sort((left, right) => left.localeCompare(right));
}
