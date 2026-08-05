import type { AppConfig } from "../config.js";
import type { MarketScanPreferences } from "../domain/market-scanner.js";
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
    this.snapshot = database.ensurePaperTradingPreferences({
      resultCounts: [2, 3],
      maxBuyPriceMicros: config.maxBuyPriceMicros,
      maxMarketDurationDays: config.maxMarketDurationDays,
      candidatesSelectedByDefault: true,
    });
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
    if (
      !Number.isInteger(update.maxBuyPriceMicros) ||
      update.maxBuyPriceMicros < 10_000 ||
      update.maxBuyPriceMicros > 990_000
    ) {
      throw new Error("Maximum PAPER buy price must be between 1 and 99 cents");
    }
    if (!MARKET_DURATION_DAY_OPTIONS.includes(update.maxMarketDurationDays as never)) {
      throw new Error("Market duration must use a supported slider value");
    }

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

function normalizeResultCounts(
  resultCounts: readonly PaperMarketResultCount[],
): PaperMarketResultCount[] {
  const normalized = Array.from(new Set(resultCounts)).sort();
  if (normalized.some((resultCount) => resultCount !== 2 && resultCount !== 3)) {
    throw new Error("PAPER market types may only contain binary or ternary events");
  }
  return normalized;
}
