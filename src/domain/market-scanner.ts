import type { OrderBook } from "@polymarket/client";
import type { AppConfig } from "../config.js";
import type { MarketDataSource } from "../infrastructure/polymarket/market-data.js";
import { extractEligibleTokens, filterEligibleEvent } from "./event-filter.js";
import { buildTradeCandidate, decimalStringToMicros } from "./price.js";
import type { TokenOrderBook, TradeCandidate } from "./types.js";

const DAY_MS = 86_400_000;

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
  candidateCount: number;
  retryCount: number;
  rateLimitCount: number;
  transientErrorCount: number;
};

export type MarketScanPreferences = {
  resultCounts: readonly (2 | 3)[];
  maxBuyPriceMicros: number;
  maxMarketDurationDays: number;
  maxMarketProgressPercent: number;
};

export interface MarketScanPreferencesProvider {
  getMarketScanPreferences(): MarketScanPreferences;
}

function normalizeOrderBook(book: OrderBook): TokenOrderBook {
  return {
    tokenId: String(book.tokenId),
    conditionId: String(book.conditionId),
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
      maxBuyPriceMicros: this.config.maxBuyPriceMicros,
      maxMarketDurationDays: this.config.maxMarketDurationDays,
      maxMarketProgressPercent: this.config.maxMarketProgressPercent,
    };
    const scanConfig: AppConfig = {
      ...this.config,
      maxBuyPriceMicros: scanPreferences.maxBuyPriceMicros,
      maxMarketDurationDays: scanPreferences.maxMarketDurationDays,
      maxMarketProgressPercent: scanPreferences.maxMarketProgressPercent,
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
      candidateCount: 0,
      retryCount: 0,
      rateLimitCount: 0,
      transientErrorCount: 0,
    };
    // The time window is only a safe upstream reduction. Every page inside it
    // is traversed, then the exact domain and order-book rules run locally.
    try {
      signal?.throwIfAborted();
      const scanWindowMs = scanPreferences.maxMarketDurationDays * DAY_MS;
      const nowMs = now.getTime();
      let eventRetryCount = 0;
      let eventRateLimitCount = 0;
      let eventTransientErrorCount = 0;
      const events = await this.marketData.listOpenEvents(
        {
          pageSize: this.config.scanEventPageSize,
          startDateMin: new Date(nowMs - scanWindowMs).toISOString(),
          startDateMax: now.toISOString(),
          endDateMin: now.toISOString(),
          endDateMax: new Date(nowMs + scanWindowMs).toISOString(),
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
      const tokens = events.flatMap((event) => {
        const eligibleEvent = filterEligibleEvent(event, scanConfig, now);
        return eligibleEvent === null ||
          !scanPreferences.resultCounts.includes(eligibleEvent.resultCount)
          ? []
          : extractEligibleTokens(event, eligibleEvent, now);
      });

      this.updateDiagnostics({
        phase: "ORDER_BOOKS",
        eventCount: events.length,
        eligibleTokenCount: tokens.length,
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

      const candidates = tokens.flatMap((token) => {
        const book = bookByToken.get(token.tokenId);
        if (book === undefined || book.isNegativeRisk !== token.isNegativeRisk) {
          return [];
        }

        const candidate = buildTradeCandidate(
          token,
          book,
          this.config.orderBudgetMicros,
          this.config.minBuyPriceMicros,
          scanPreferences.maxBuyPriceMicros,
        );
        return candidate === null ? [] : [candidate];
      });
      this.finishDiagnostics("COMPLETE", {
        eventCount: events.length,
        eligibleTokenCount: tokens.length,
        orderBookCount: books.length,
        candidateCount: candidates.length,
      });
      return candidates;
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
