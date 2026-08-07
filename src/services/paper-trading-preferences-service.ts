import type { AppConfig } from "../config.js";
import {
  currentMarketProgressPercent,
  isMarketEligible,
  type MarketEligibilityCandidate,
  type MarketEligibilitySettings,
} from "../domain/market-eligibility.js";
import type { MarketScanPreferences } from "../domain/market-scanner.js";
import {
  sortTradeCandidates,
  type CandidateSortDirection,
} from "../domain/trading-strategy.js";
import type { TradeCandidate } from "../domain/types.js";
import type { PaperDatabase } from "../infrastructure/db/database.js";

export const MARKET_DURATION_DAY_OPTIONS = [
  1, 7, 14, 30, 60, 90, 120, 180, 360, 365,
] as const;

export type PaperMarketResultCount = 2 | 3;

export type PaperTradingPreferencesSnapshot = {
  resultCounts: PaperMarketResultCount[];
  allCategories: boolean;
  selectedCategories: string[];
  candidateSortDirection: CandidateSortDirection;
  orderBudgetMicros: number;
  maxBuyPriceMicros: number;
  minBidAskRatioPercent: number;
  maxMarketDurationDays: number;
  maxMarketProgressPercent: number;
  candidatesSelectedByDefault: boolean;
  updatedAt: string;
};

type MarketFilterUpdate = Pick<
  PaperTradingPreferencesSnapshot,
  "resultCounts" | "maxBuyPriceMicros" | "maxMarketDurationDays"
> & {
  allCategories?: boolean;
  selectedCategories?: readonly string[];
  candidateSortDirection?: CandidateSortDirection;
  orderBudgetMicros?: number;
  minBidAskRatioPercent?: number;
  maxMarketProgressPercent?: number;
};

type NormalizedMarketFilters = Pick<
  PaperTradingPreferencesSnapshot,
  | "resultCounts"
  | "maxBuyPriceMicros"
  | "minBidAskRatioPercent"
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
  private readonly defaultInitialCapitalMicros: number;
  private readonly minBuyPriceMicros: number;

  public constructor(
    private readonly database: PaperDatabase,
    config: AppConfig,
  ) {
    this.defaultInitialCapitalMicros = config.initialCapitalMicros;
    this.minBuyPriceMicros = config.minBuyPriceMicros;
    this.defaults = {
      resultCounts: [2, 3],
      allCategories: true,
      selectedCategories: [],
      candidateSortDirection: "ASC",
      orderBudgetMicros: config.orderBudgetMicros,
      maxBuyPriceMicros: config.maxBuyPriceMicros,
      minBidAskRatioPercent: config.minBidAskRatioPercent,
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
      resultCounts: [...this.snapshot.resultCounts],
      selectedCategories: [...this.snapshot.selectedCategories],
    };
  }

  public resetTestState(): void {
    const result = this.database.resetTestState(
      this.defaultInitialCapitalMicros,
      this.defaults,
    );
    this.snapshot = result.preferences;
  }

  public reload(): void {
    this.snapshot = this.database.getPaperTradingPreferences();
  }

  public getMarketScanPreferences(): MarketScanPreferences {
    return {
      resultCounts: [...this.snapshot.resultCounts],
      maxBuyPriceMicros: this.snapshot.maxBuyPriceMicros,
      minBuyPriceMicros: this.minBuyPriceMicros,
      minBidAskRatioPercent: this.snapshot.minBidAskRatioPercent,
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

  public getOrderBudgetMicros(): number {
    return this.snapshot.orderBudgetMicros;
  }

  public getEligibilitySettings(): MarketEligibilitySettings {
    return toEligibilitySettings(this.snapshot, this.minBuyPriceMicros);
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
    const resultCounts = normalizeResultCounts(update.resultCounts);

    const normalizedUpdate: NormalizedMarketFilters = {
      resultCounts,
      maxBuyPriceMicros: update.maxBuyPriceMicros,
      minBidAskRatioPercent:
        update.minBidAskRatioPercent ?? this.snapshot.minBidAskRatioPercent,
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
      throw new Error("Per-order TEST amount cannot exceed total TEST capital");
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
    return marketMatchesFilters(
      candidate,
      this.snapshot,
      this.minBuyPriceMicros,
      now,
    );
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
          !marketMatchesFilters(
            market,
            filters,
            this.minBuyPriceMicros,
            now,
          ),
      )
      .map((market) => market.tokenId);
  }
}

function marketMatchesFilters(
  market: MarketEligibilityCandidate,
  filters: NormalizedMarketFilters,
  minBuyPriceMicros: number,
  now?: Date,
): boolean {
  return isMarketEligible(
    market,
    toEligibilitySettings(filters, minBuyPriceMicros),
    now,
  );
}

function toEligibilitySettings(
  filters: NormalizedMarketFilters,
  minBuyPriceMicros: number,
): MarketEligibilitySettings {
  return {
    resultCounts: filters.resultCounts,
    allCategories: filters.allCategories,
    selectedCategoryIds: filters.selectedCategories,
    minBuyPriceMicros,
    maxBuyPriceMicros: filters.maxBuyPriceMicros,
    minBidAskRatioPercent: filters.minBidAskRatioPercent,
    maxMarketDurationDays: filters.maxMarketDurationDays,
    maxMarketProgressPercent: filters.maxMarketProgressPercent,
    orderBudgetMicros: filters.orderBudgetMicros,
  };
}

function validateMarketFilterValues(
  values: Pick<
    PaperTradingPreferencesSnapshot,
    | "maxBuyPriceMicros"
    | "minBidAskRatioPercent"
    | "maxMarketDurationDays"
    | "maxMarketProgressPercent"
    | "orderBudgetMicros"
  >,
): void {
  if (
    !Number.isInteger(values.maxBuyPriceMicros) ||
    values.maxBuyPriceMicros % 10_000 !== 0 ||
    values.maxBuyPriceMicros < 10_000 ||
    values.maxBuyPriceMicros > 30_000
  ) {
    throw new Error("Maximum TEST buy price must be a whole cent between 1 and 3 cents");
  }
  if (!MARKET_DURATION_DAY_OPTIONS.includes(values.maxMarketDurationDays as never)) {
    throw new Error("Market duration must use a supported slider value");
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
    throw new Error("Per-order TEST amount must be positive");
  }
}

function normalizeResultCounts(
  resultCounts: readonly PaperMarketResultCount[],
): PaperMarketResultCount[] {
  const normalized = Array.from(new Set(resultCounts)).sort();
  if (normalized.length === 0) {
    throw new Error("Select at least one TEST market type");
  }
  if (normalized.some((resultCount) => resultCount !== 2 && resultCount !== 3)) {
    throw new Error("TEST market types may only contain binary or ternary events");
  }
  return normalized;
}

function normalizeCategories(categories: readonly string[]): string[] {
  return Array.from(
    new Set(categories.map((category) => category.trim()).filter(Boolean)),
  ).sort((left, right) => left.localeCompare(right));
}
