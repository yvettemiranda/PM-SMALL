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
  candidatesSelectedByDefault: boolean;
  updatedAt: string;
};

type MarketFilterUpdate = Pick<
  PaperTradingPreferencesSnapshot,
  "resultCounts" | "maxBuyPriceMicros" | "maxMarketDurationDays"
>;

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
    };
  }

  public updateMarketFilters(update: MarketFilterUpdate): PaperTradingPreferencesSnapshot {
    const resultCounts = normalizeResultCounts(update.resultCounts);
    validateMarketFilterValues(update);

    this.snapshot = this.database.updatePaperTradingPreferences({
      ...this.snapshot,
      resultCounts,
      maxBuyPriceMicros: update.maxBuyPriceMicros,
      maxMarketDurationDays: update.maxMarketDurationDays,
    });
    return this.getSnapshot();
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
      "resultCount" | "makerBuyPriceMicros" | "durationDays"
    >,
  ): boolean {
    return (
      this.snapshot.resultCounts.includes(candidate.resultCount) &&
      candidate.makerBuyPriceMicros <= this.snapshot.maxBuyPriceMicros &&
      candidate.durationDays <= this.snapshot.maxMarketDurationDays
    );
  }

  public isCandidateEnabled(candidate: TradeCandidate): boolean {
    return (
      this.candidateMatchesMarketFilters(candidate) &&
      this.isTokenSelected(candidate.tokenId)
    );
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
}

function validateMarketFilterValues(
  values: Pick<
    PaperTradingPreferencesSnapshot,
    "maxBuyPriceMicros" | "maxMarketDurationDays"
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
