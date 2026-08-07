import type { Event, OrderBook } from "@polymarket/client";
import type { AppConfig } from "../config.js";
import type {
  MarketDataSource,
  OpenEventScanProgress,
} from "../infrastructure/polymarket/market-data.js";
import {
  emptyMarketEligibilityRejectionCounts,
  marketEligibilityRejectionReason,
  staticMarketEligibilityRejectionReason,
  type MarketEligibilityRejectionCounts,
} from "./market-eligibility.js";
import { extractEligibleTokens, filterEligibleEvent } from "./event-filter.js";
import {
  DECIMAL_SCALE,
  buildMonitoredCandidate,
  decimalStringToMicros,
} from "./price.js";
import {
  sortTradeCandidates,
  type CandidateSortDirection,
} from "./trading-strategy.js";
import type {
  MarketCategory,
  MarketToken,
  TokenOrderBook,
  TradeCandidate,
} from "./types.js";
import type { MarketType } from "./market-type.js";

export type MarketScanDiagnostics = {
  phase: "EVENTS" | "ORDER_BOOKS" | "COMPLETE" | "FAILED";
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  eventPageCount: number;
  eventPageRequestCount: number;
  eventCount: number;
  eligibleEventCount: number;
  staticEligibleEventCount: number;
  candidateEventCount: number;
  eligibleTokenCount: number;
  participatingTokenCount: number;
  maxObservedResultCount: number;
  staticEligibleTokenCount: number;
  orderBookTargetTokenCount: number;
  orderBookBatchCount: number;
  orderBookRequestCount: number;
  orderBookCount: number;
  monitoredTokenCount: number;
  candidateCount: number;
  availableCategories: MarketCategory[];
  rejectionCounts: MarketEligibilityRejectionCounts;
  retryCount: number;
  rateLimitCount: number;
  transientErrorCount: number;
};

export type MarketScanPreferences = {
  marketTypes: readonly MarketType[];
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

function normalizeOrderBook(book: OrderBook): TokenOrderBook | null {
  try {
    const bids = book.bids.map((level) => ({
      priceMicros: decimalStringToMicros(level.price),
      sizeMicros: decimalStringToMicros(level.size),
    }));
    const asks = book.asks.map((level) => ({
      priceMicros: decimalStringToMicros(level.price),
      sizeMicros: decimalStringToMicros(level.size),
    }));
    if (
      [...bids, ...asks].some(
        (level) =>
          level.priceMicros <= 0 || level.priceMicros >= DECIMAL_SCALE,
      )
    ) {
      return null;
    }
    return {
      tokenId: String(book.tokenId),
      conditionId: String(book.conditionId),
      bookVersion: `REST:${String(book.tokenId)}`,
      bids,
      asks,
      minOrderSizeMicros: decimalStringToMicros(book.minOrderSize),
      tickSizeMicros: decimalStringToMicros(book.tickSize),
      isNegativeRisk: book.negRisk,
    };
  } catch {
    return null;
  }
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
      marketTypes: ["BINARY", "TERNARY"],
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
    const eligibilitySettings = {
      marketTypes: scanPreferences.marketTypes,
      allCategories: scanPreferences.allCategories,
      selectedCategoryIds: scanPreferences.selectedCategories,
      minBuyPriceMicros: scanPreferences.minBuyPriceMicros,
      maxBuyPriceMicros: scanPreferences.maxBuyPriceMicros,
      minBidAskRatioPercent: scanPreferences.minBidAskRatioPercent,
      minMarketDurationDays: scanPreferences.minMarketDurationDays,
      maxMarketDurationDays: scanPreferences.maxMarketDurationDays,
      maxMarketProgressPercent: scanPreferences.maxMarketProgressPercent,
      orderBudgetMicros: scanPreferences.orderBudgetMicros,
    };
    const categoryNeutralEligibilitySettings = {
      ...eligibilitySettings,
      allCategories: true,
      selectedCategoryIds: [],
    };
    const rejectionCounts = emptyMarketEligibilityRejectionCounts();
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
      eligibleEventCount: 0,
      staticEligibleEventCount: 0,
      candidateEventCount: 0,
      eligibleTokenCount: 0,
      participatingTokenCount: 0,
      maxObservedResultCount: 0,
      staticEligibleTokenCount: 0,
      orderBookTargetTokenCount: 0,
      orderBookBatchCount: 0,
      orderBookRequestCount: 0,
      orderBookCount: 0,
      monitoredTokenCount: 0,
      candidateCount: 0,
      availableCategories: [],
      rejectionCounts,
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
      const reportEventProgress = ({
        pageCount,
        eventCount,
        requestCount,
        retryCount,
        rateLimitCount,
        transientErrorCount,
      }: OpenEventScanProgress) => {
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
      };
      const staticTokens: MarketToken[] = [];
      const eventCategoryById = new Map<string, MarketCategory>();
      let eventCount = 0;
      let eligibleEventCount = 0;
      let eligibleTokenCount = 0;
      let maxObservedResultCount = 0;
      const processEventPage = (events: readonly Event[]): void => {
        eventCount += events.length;
        for (const event of events) {
          const eligibleEvent = filterEligibleEvent(event);
          if (eligibleEvent === null) {
            continue;
          }
          eligibleEventCount += 1;
          maxObservedResultCount = Math.max(
            maxObservedResultCount,
            eligibleEvent.resultCount,
          );
          const eventTokens = extractEligibleTokens(
            event,
            eligibleEvent,
            scanConfig,
            now,
          );
          eligibleTokenCount += eventTokens.length;
          for (const token of eventTokens) {
            for (const [index, id] of token.categoryIds.entries()) {
              eventCategoryById.set(id, {
                id,
                label: token.categoryLabels[index] ?? id,
              });
            }
            const reason = staticMarketEligibilityRejectionReason(
              token,
              categoryNeutralEligibilitySettings,
              now,
            );
            if (reason === null) {
              staticTokens.push(token);
            } else {
              rejectionCounts[reason] += 1;
            }
          }
        }
        this.updateDiagnostics({
          eligibleEventCount,
          eligibleTokenCount,
          maxObservedResultCount,
        });
      };
      const scanRequest = { pageSize: this.config.scanEventPageSize };
      if (this.marketData.streamOpenEventPages !== undefined) {
        for await (const events of this.marketData.streamOpenEventPages(
          scanRequest,
          reportEventProgress,
          signal,
        )) {
          signal?.throwIfAborted();
          processEventPage(events);
        }
      } else {
        processEventPage(
          await this.marketData.listOpenEvents(
            scanRequest,
            reportEventProgress,
            signal,
          ),
        );
      }
      signal?.throwIfAborted();
      await Promise.race([
        homepageCategoriesPromise.then(() => undefined),
        new Promise<void>((resolve) => setImmediate(resolve)),
      ]);
      signal?.throwIfAborted();
      const eventCategories = Array.from(eventCategoryById.values()).sort(
        (left, right) =>
          left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
      );
      const availableCategories =
        homepageCategories.length > 0 ? homepageCategories : eventCategories;
      const homepageCategoryIds = new Set(
        homepageCategories.map((category) => category.id),
      );
      const effectiveEligibilitySettings =
        !eligibilitySettings.allCategories
          ? {
              ...eligibilitySettings,
              selectedCategoryIds: eligibilitySettings.selectedCategoryIds.filter(
                (categoryId) => homepageCategoryIds.has(categoryId),
              ),
            }
          : eligibilitySettings;
      const tokens: MarketToken[] = [];
      for (const token of staticTokens) {
        const reason = staticMarketEligibilityRejectionReason(
          token,
          effectiveEligibilitySettings,
          now,
        );
        if (reason === null) {
          tokens.push(token);
        } else {
          rejectionCounts[reason] += 1;
        }
      }

      this.updateDiagnostics({
        phase: "ORDER_BOOKS",
        eventCount,
        eligibleEventCount,
        staticEligibleEventCount: new Set(
          tokens.map((token) => token.eventId),
        ).size,
        eligibleTokenCount,
        participatingTokenCount: tokens.length,
        maxObservedResultCount,
        staticEligibleTokenCount: tokens.length,
        orderBookTargetTokenCount: tokens.length,
        availableCategories,
        rejectionCounts: { ...rejectionCounts },
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
      const bookByToken = new Map<string, TokenOrderBook>();
      for (const rawBook of books) {
        const normalized = normalizeOrderBook(rawBook);
        if (normalized !== null) {
          bookByToken.set(normalized.tokenId, normalized);
        }
      }

      const monitoredCandidates: TradeCandidate[] = [];
      let candidateCount = 0;
      const candidateEventIds = new Set<string>();
      for (const token of tokens) {
        const fetchedBook = bookByToken.get(token.tokenId);
        const book =
          fetchedBook !== undefined &&
          fetchedBook.conditionId === token.conditionId &&
          fetchedBook.isNegativeRisk === token.isNegativeRisk
            ? fetchedBook
            : null;
        const monitored = buildMonitoredCandidate(
          token,
          book,
          scanPreferences.orderBudgetMicros,
        );
        monitoredCandidates.push(monitored);
        const rejectionReason = marketEligibilityRejectionReason(
          monitored,
          eligibilitySettings,
          now,
        );
        if (rejectionReason === null) {
          candidateCount += 1;
          candidateEventIds.add(monitored.eventId);
        } else {
          rejectionCounts[rejectionReason] += 1;
        }
      }
      const orderedCandidates = sortTradeCandidates(
        monitoredCandidates,
        scanPreferences.candidateSortDirection,
      );
      this.finishDiagnostics("COMPLETE", {
        eventCount,
        eligibleEventCount,
        staticEligibleEventCount: new Set(
          tokens.map((token) => token.eventId),
        ).size,
        candidateEventCount: candidateEventIds.size,
        eligibleTokenCount,
        participatingTokenCount: tokens.length,
        maxObservedResultCount,
        staticEligibleTokenCount: tokens.length,
        orderBookTargetTokenCount: tokens.length,
        orderBookCount: books.length,
        monitoredTokenCount: orderedCandidates.length,
        candidateCount,
        rejectionCounts: { ...rejectionCounts },
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
