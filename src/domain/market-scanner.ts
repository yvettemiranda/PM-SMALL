import type { OrderBook } from "@polymarket/client";
import type { AppConfig } from "../config.js";
import type { MarketDataSource } from "../infrastructure/polymarket/market-data.js";
import { isMarketEligible } from "./market-eligibility.js";
import { extractEligibleTokens, filterEligibleEvent } from "./event-filter.js";
import { buildMonitoredCandidate, decimalStringToMicros } from "./price.js";
import {
  sortTradeCandidates,
  type CandidateSortDirection,
} from "./trading-strategy.js";
import type { MarketCategory, TokenOrderBook, TradeCandidate } from "./types.js";

export type MarketScanDiagnostics = {
  phase: "EVENTS" | "ORDER_BOOKS" | "COMPLETE" | "FAILED";
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  eventPageCount: number;
  eventPageRequestCount: number;
  eventCount: number;
  eligibleTokenCount: number;
  orderBookBatchCount: number;
  orderBookRequestCount: number;
  orderBookCount: number;
  monitoredTokenCount: number;
  candidateCount: number;
  availableCategories: MarketCategory[];
  retryCount: number;
  rateLimitCount: number;
  transientErrorCount: number;
};

export type MarketScanPreferences = {
  resultCounts: readonly (2 | 3)[];
  minBuyPriceMicros: number;
  maxBuyPriceMicros: number;
  minBidAskRatioPercent: number;
  minMarketDurationDays: number;
  maxMarketDurationDays: number;
  maxMarketProgressPercent: number;
  allCategories: boolean;
  selectedCategories: readonly string[];
  candidateSortDirection: CandidateSortDirection;
  orderBudgetMicros: number;
};

export interface MarketScanPreferencesProvider {
  getMarketScanPreferences(): MarketScanPreferences;
}

function normalizeOrderBook(book: OrderBook): TokenOrderBook {
  return {
    tokenId: String(book.tokenId),
    conditionId: String(book.conditionId),
    bookVersion: `REST:${String(book.tokenId)}`,
    bids: book.bids.map((level) => ({
      priceMicros: decimalStringToMicros(level.price),
      sizeMicros: decimalStringToMicros(level.size),
    })),
    asks: book.asks.map((level) => ({
      priceMicros: decimalStringToMicros(level.price),
      sizeMicros: decimalStringToMicros(level.size),
    })),
    minOrderSizeMicros: decimalStringToMicros(book.minOrderSize),
    tickSizeMicros: decimalStringToMicros(book.tickSize),
    isNegativeRisk: book.negRisk,
  };
}

export interface CandidateScanner {
  scan(now?: Date, signal?: AbortSignal): Promise<TradeCandidate[]>;
  getLastDiagnostics?(): MarketScanDiagnostics | null;
}

export class MarketScanner implements CandidateScanner {
  private lastDiagnostics: MarketScanDiagnostics | null = null;
  private activeScanStartedAtMs: number | null = null;

  public constructor(
    private readonly marketData: MarketDataSource,
    private readonly config: AppConfig,
    private readonly preferences?: MarketScanPreferencesProvider,
  ) {}

  public getLastDiagnostics(): MarketScanDiagnostics | null {
    if (this.lastDiagnostics === null) {
      return null;
    }
    return {
      ...this.lastDiagnostics,
      durationMs:
        this.activeScanStartedAtMs === null
          ? this.lastDiagnostics.durationMs
          : Math.max(0, Date.now() - this.activeScanStartedAtMs),
    };
  }

  public async scan(
    now: Date = new Date(),
    signal?: AbortSignal,
  ): Promise<TradeCandidate[]> {
    const scanPreferences = this.preferences?.getMarketScanPreferences() ?? {
      resultCounts: [2, 3],
      minBuyPriceMicros: this.config.minBuyPriceMicros,
      maxBuyPriceMicros: this.config.maxBuyPriceMicros,
      minBidAskRatioPercent: this.config.minBidAskRatioPercent,
      minMarketDurationDays: this.config.minMarketDurationDays,
      maxMarketDurationDays: this.config.maxMarketDurationDays,
      maxMarketProgressPercent: this.config.maxMarketProgressPercent,
      allCategories: true,
      selectedCategories: [],
      candidateSortDirection: "ASC",
      orderBudgetMicros: this.config.orderBudgetMicros,
    };
    const scanConfig: AppConfig = {
      ...this.config,
      maxBuyPriceMicros: scanPreferences.maxBuyPriceMicros,
      minMarketDurationDays: 1,
      maxMarketDurationDays: 365,
    };
    const startedAt = new Date();
    const startedAtMs = Date.now();
    this.activeScanStartedAtMs = startedAtMs;
    this.lastDiagnostics = {
      phase: "EVENTS",
      startedAt: startedAt.toISOString(),
      completedAt: null,
      durationMs: 0,
      eventPageCount: 0,
      eventPageRequestCount: 0,
      eventCount: 0,
      eligibleTokenCount: 0,
      orderBookBatchCount: 0,
      orderBookRequestCount: 0,
      orderBookCount: 0,
      monitoredTokenCount: 0,
      candidateCount: 0,
      availableCategories: [],
      retryCount: 0,
      rateLimitCount: 0,
      transientErrorCount: 0,
    };
    // Event and child-market schedules can differ. Traverse every open-event
    // page, then apply the exact per-market duration rule locally so a valid
    // child market cannot be lost to an event-level date bound.
    try {
      signal?.throwIfAborted();
      const homepageCategoriesPromise =
        this.marketData.listHomepageCategories === undefined
          ? Promise.resolve([])
          : this.marketData.listHomepageCategories(signal).catch(() => []);
      let homepageCategories: MarketCategory[] = [];
      void homepageCategoriesPromise.then((syncedCategories) => {
        homepageCategories = syncedCategories.map((category) => ({
          ...category,
        }));
        if (
          homepageCategories.length > 0 &&
          this.lastDiagnostics?.startedAt === startedAt.toISOString() &&
          this.lastDiagnostics.completedAt === null
        ) {
          this.updateDiagnostics({ availableCategories: homepageCategories });
        }
      });
      let eventRetryCount = 0;
      let eventRateLimitCount = 0;
      let eventTransientErrorCount = 0;
      const events = await this.marketData.listOpenEvents(
        {
          pageSize: this.config.scanEventPageSize,
        },
        ({
          pageCount,
          eventCount,
          requestCount,
          retryCount,
          rateLimitCount,
          transientErrorCount,
        }) => {
          eventRetryCount = retryCount;
          eventRateLimitCount = rateLimitCount;
          eventTransientErrorCount = transientErrorCount;
          this.updateDiagnostics({
            phase: "EVENTS",
            eventPageCount: pageCount,
            eventPageRequestCount: requestCount,
            eventCount,
            retryCount,
            rateLimitCount,
            transientErrorCount,
          });
        },
        signal,
      );
      signal?.throwIfAborted();
      const eligibleEvents = events.flatMap((event) => {
        const eligibleEvent = filterEligibleEvent(event);
        return eligibleEvent === null ? [] : [{ event, eligibleEvent }];
      });
      const eligibleTokens = eligibleEvents.flatMap(({ event, eligibleEvent }) =>
        extractEligibleTokens(event, eligibleEvent, scanConfig, now),
      );
      const eventCategories = Array.from(
        new Map(
          eligibleTokens.flatMap((token) =>
            token.categoryIds.map((id, index) => [
              id,
              { id, label: token.categoryLabels[index] ?? id },
            ] as const),
          ),
        ).values(),
      ).sort(
        (left, right) =>
          left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
      );
      const availableCategories =
        homepageCategories.length > 0 ? homepageCategories : eventCategories;
      const tokens = eligibleTokens;

      this.updateDiagnostics({
        phase: "ORDER_BOOKS",
        eventCount: events.length,
        eligibleTokenCount: tokens.length,
        availableCategories,
      });
      const books =
        tokens.length === 0
          ? []
          : await this.marketData.fetchOrderBooks(
              tokens.map((token) => token.tokenId),
              ({
                batchCount,
                orderBookCount,
                requestCount,
                retryCount,
                rateLimitCount,
                transientErrorCount,
              }) => {
                this.updateDiagnostics({
                  phase: "ORDER_BOOKS",
                  orderBookBatchCount: batchCount,
                  orderBookRequestCount: requestCount,
                  orderBookCount,
                  retryCount: eventRetryCount + retryCount,
                  rateLimitCount: eventRateLimitCount + rateLimitCount,
                  transientErrorCount:
                    eventTransientErrorCount + transientErrorCount,
                });
              },
              signal,
            );
      signal?.throwIfAborted();
      const bookByToken = new Map(
        books.map((book) => {
          const normalized = normalizeOrderBook(book);
          return [normalized.tokenId, normalized] as const;
        }),
      );

      const monitoredCandidates: TradeCandidate[] = [];
      let candidateCount = 0;
      for (const token of tokens) {
        const fetchedBook = bookByToken.get(token.tokenId);
        const book =
          fetchedBook !== undefined &&
          fetchedBook.isNegativeRisk === token.isNegativeRisk
            ? fetchedBook
            : null;
        const monitored = buildMonitoredCandidate(
          token,
          book,
          scanPreferences.orderBudgetMicros,
        );
        monitoredCandidates.push(monitored);
        if (isMarketEligible(monitored, {
          resultCounts: scanPreferences.resultCounts,
          allCategories: scanPreferences.allCategories,
          selectedCategoryIds: scanPreferences.selectedCategories,
          minBuyPriceMicros: scanPreferences.minBuyPriceMicros,
          maxBuyPriceMicros: scanPreferences.maxBuyPriceMicros,
          minBidAskRatioPercent: scanPreferences.minBidAskRatioPercent,
          minMarketDurationDays: scanPreferences.minMarketDurationDays,
          maxMarketDurationDays: scanPreferences.maxMarketDurationDays,
          maxMarketProgressPercent: scanPreferences.maxMarketProgressPercent,
          orderBudgetMicros: scanPreferences.orderBudgetMicros,
        }, now)) {
          candidateCount += 1;
        }
      }
      const orderedCandidates = sortTradeCandidates(
        monitoredCandidates,
        scanPreferences.candidateSortDirection,
      );
      this.finishDiagnostics("COMPLETE", {
        eventCount: events.length,
        eligibleTokenCount: tokens.length,
        orderBookCount: books.length,
        monitoredTokenCount: orderedCandidates.length,
        candidateCount,
        availableCategories:
          homepageCategories.length > 0
            ? homepageCategories
            : availableCategories,
      });
      return orderedCandidates;
    } catch (error) {
      this.finishDiagnostics("FAILED");
      throw error;
    }
  }

  private updateDiagnostics(update: Partial<MarketScanDiagnostics>): void {
    if (this.lastDiagnostics === null) {
      return;
    }
    this.lastDiagnostics = {
      ...this.lastDiagnostics,
      ...update,
      durationMs: Math.max(
        0,
        Date.now() - (this.activeScanStartedAtMs ?? Date.now()),
      ),
    };
  }

  private finishDiagnostics(
    phase: "COMPLETE" | "FAILED",
    update: Partial<MarketScanDiagnostics> = {},
  ): void {
    const completedAt = new Date();
    this.updateDiagnostics({
      ...update,
      phase,
      completedAt: completedAt.toISOString(),
    });
    this.activeScanStartedAtMs = null;
  }
}
