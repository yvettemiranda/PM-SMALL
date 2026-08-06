import type { AppConfig } from "../config.js";
import type { MarketScanPreferences } from "../domain/market-scanner.js";
import type { TradeCandidate } from "../domain/types.js";
import type { PaperDatabase } from "../infrastructure/db/database.js";

export const MARKET_DURATION_DAY_OPTIONS = [
  1, 7, 14, 30, 60, 90, 120, 180, 360, 365,
] as const;

export type PaperMarketResultCount = 2 | 3;

export type PaperTradingPreferencesSnapshot = {
  resultCounts: PaperMarketResultCount[];
  maxBuyPriceMicros: number;
  maxMarketDurationDays: number;
  maxMarketProgressPercent: number;
  candidatesSelectedByDefault: boolean;
  updatedAt: string;
};

type MarketFilterUpdate = Pick<
  PaperTradingPreferencesSnapshot,
  "resultCounts" | "maxBuyPriceMicros" | "maxMarketDurationDays"
> & { maxMarketProgressPercent?: number };

type NormalizedMarketFilters = Pick<
  PaperTradingPreferencesSnapshot,
  | "resultCounts"
  | "maxBuyPriceMicros"
  | "maxMarketDurationDays"
  | "maxMarketProgressPercent"
>;

export type PaperMarketFilterUpdateResult = {
  preferences: PaperTradingPreferencesSnapshot;
  cancelledBuyCount: number;
};

export class PaperTradingPreferencesService {
  private snapshot: PaperTradingPreferencesSnapshot;
  private selectionOverrides: Map<string, boolean>;

  public constructor(
    private readonly database: PaperDatabase,
    config: AppConfig,
  ) {
    const defaults = {
      resultCounts: [2, 3],
      maxBuyPriceMicros: config.maxBuyPriceMicros,
      maxMarketDurationDays: config.maxMarketDurationDays,
      maxMarketProgressPercent: config.maxMarketProgressPercent,
      candidatesSelectedByDefault: true,
    } satisfies Omit<PaperTradingPreferencesSnapshot, "updatedAt">;
    validateMarketFilterValues(defaults);
    this.snapshot = database.ensurePaperTradingPreferences(defaults);
    validateMarketFilterValues(this.snapshot);
    this.selectionOverrides = new Map(
      database
        .listPaperCandidateSelectionOverrides()
        .map((override) => [override.tokenId, override.selected]),
    );
  }

  public getSnapshot(): PaperTradingPreferencesSnapshot {
    return { ...this.snapshot, resultCounts: [...this.snapshot.resultCounts] };
  }

  public getMarketScanPreferences(): MarketScanPreferences {
    return {
      resultCounts: [...this.snapshot.resultCounts],
      maxBuyPriceMicros: this.snapshot.maxBuyPriceMicros,
      maxMarketDurationDays: this.snapshot.maxMarketDurationDays,
      maxMarketProgressPercent: this.snapshot.maxMarketProgressPercent,
    };
  }

  public updateMarketFilters(
    update: MarketFilterUpdate,
  ): PaperMarketFilterUpdateResult {
    const resultCounts = normalizeResultCounts(update.resultCounts);

    const normalizedUpdate: NormalizedMarketFilters = {
      resultCounts,
      maxBuyPriceMicros: update.maxBuyPriceMicros,
      maxMarketDurationDays: update.maxMarketDurationDays,
      maxMarketProgressPercent:
        update.maxMarketProgressPercent ?? this.snapshot.maxMarketProgressPercent,
    };
    validateMarketFilterValues(normalizedUpdate);
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

  public isTokenSelected(tokenId: string): boolean {
    return (
      this.selectionOverrides.get(tokenId) ??
      this.snapshot.candidatesSelectedByDefault
    );
  }

  public candidateMatchesMarketFilters(
    candidate: Pick<
      TradeCandidate,
      "resultCount" | "makerBuyPriceMicros" | "durationDays" | "progressPercent"
    >,
    now?: Date,
  ): boolean {
    return marketMatchesFilters(candidate, this.snapshot, now);
  }

  public isCandidateEnabled(candidate: TradeCandidate, now?: Date): boolean {
    return (
      this.candidateMatchesMarketFilters(candidate, now) &&
      this.isTokenSelected(candidate.tokenId)
    );
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

  public setCandidateSelected(tokenId: string, selected: boolean): void {
    this.database.setPaperCandidateSelected(
      tokenId,
      selected,
      this.snapshot.candidatesSelectedByDefault,
    );
    if (selected === this.snapshot.candidatesSelectedByDefault) {
      this.selectionOverrides.delete(tokenId);
    } else {
      this.selectionOverrides.set(tokenId, selected);
    }
  }

  public setAllCandidatesSelected(selected: boolean): void {
    this.snapshot = this.database.setAllPaperCandidatesSelected(selected);
    this.selectionOverrides.clear();
  }

  private ineligibleActiveBuyTokenIds(
    filters: NormalizedMarketFilters,
    now: Date,
  ): string[] {
    return this.database
      .listActivePaperBuyMarkets()
      .filter((market) => !marketMatchesFilters(market, filters, now))
      .map((market) => market.tokenId);
  }
}

function marketMatchesFilters(
  market: {
    resultCount: PaperMarketResultCount | null;
    makerBuyPriceMicros: number;
    durationDays: number | null;
    progressPercent?: number | null;
    openedAt?: string | null;
    endsAt?: string | null;
  },
  filters: NormalizedMarketFilters,
  now?: Date,
): boolean {
  const resultCountMatches =
    market.resultCount === null
      ? filters.resultCounts.includes(2) && filters.resultCounts.includes(3)
      : filters.resultCounts.includes(market.resultCount);
  const progressPercent = currentProgressPercent(market, now);
  return (
    resultCountMatches &&
    market.makerBuyPriceMicros <= filters.maxBuyPriceMicros &&
    market.durationDays !== null &&
    market.durationDays >= 1 &&
    market.durationDays <= filters.maxMarketDurationDays &&
    progressPercent !== null &&
    progressPercent >= 0 &&
    progressPercent <= filters.maxMarketProgressPercent
  );
}

function currentProgressPercent(
  market: {
    progressPercent?: number | null;
    openedAt?: string | null;
    endsAt?: string | null;
  },
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

function validateMarketFilterValues(
  values: Pick<
    PaperTradingPreferencesSnapshot,
    "maxBuyPriceMicros" | "maxMarketDurationDays" | "maxMarketProgressPercent"
  >,
): void {
  if (
    !Number.isInteger(values.maxBuyPriceMicros) ||
    values.maxBuyPriceMicros % 10_000 !== 0 ||
    values.maxBuyPriceMicros < 10_000 ||
    values.maxBuyPriceMicros > 30_000
  ) {
    throw new Error("Maximum PAPER buy price must be a whole cent between 1 and 3 cents");
  }
  if (!MARKET_DURATION_DAY_OPTIONS.includes(values.maxMarketDurationDays as never)) {
    throw new Error("Market duration must use a supported slider value");
  }
  if (
    !Number.isInteger(values.maxMarketProgressPercent) ||
    values.maxMarketProgressPercent < 1 ||
    values.maxMarketProgressPercent > 100
  ) {
    throw new Error("Market progress must be a whole percent between 1 and 100");
  }
}

function normalizeResultCounts(
  resultCounts: readonly PaperMarketResultCount[],
): PaperMarketResultCount[] {
  const normalized = Array.from(new Set(resultCounts)).sort();
  if (normalized.some((resultCount) => resultCount !== 2 && resultCount !== 3)) {
    throw new Error("PAPER market types may only contain binary or ternary events");
  }
  return normalized;
}
