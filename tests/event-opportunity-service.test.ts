import { describe, expect, it } from "vitest";
import type { TokenOrderBook, TradeCandidate } from "../src/domain/types.js";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { CandidateService } from "../src/services/candidate-service.js";
import { EventOpportunityService } from "../src/services/event-opportunity-service.js";
import type {
  MarketStreamStatus,
  PaperMarketRuntime,
} from "../src/services/market-stream-service.js";
import { PaperTradingPreferencesService } from "../src/services/paper-trading-preferences-service.js";
import {
  makeCandidate,
  testConfig,
  testEligibilitySettings,
} from "./helpers.js";

class EventBookRuntime implements PaperMarketRuntime {
  public readonly readyTokenIds = new Set<string>();
  public readonly books = new Map<string, TokenOrderBook>();

  public getStatus(): MarketStreamStatus {
    return {
      running: true,
      connected: true,
      subscribedTokenCount: this.books.size,
      dataCompleteTokenCount: this.readyTokenIds.size,
      lastEventAt: null,
      processedTradeEvents: 0,
      ignoredTradeEvents: 0,
      paperBuyFillCount: 0,
      paperSellFillCount: 0,
      createdPaperSellCount: 0,
      connectionCount: 1,
      fullSnapshotCount: 1,
      unexpectedDisconnectCount: 0,
      recoveryCount: 0,
      lastFullSnapshotDurationMs: null,
      lastRecoveryDurationMs: null,
      lastError: null,
    };
  }

  public refreshSubscriptions(): void {}

  public isTokenReady(tokenId: string): boolean {
    return this.readyTokenIds.has(tokenId);
  }

  public getOrderBook(candidate: TradeCandidate): TokenOrderBook | null {
    return this.books.get(candidate.tokenId) ?? null;
  }

  public getOrderBookRevision(tokenId: string): number | null {
    return this.books.has(tokenId) ? 1 : null;
  }
}

describe("EventOpportunityService", () => {
  it("blocks an unlocked Event while one static sibling is not ready", async () => {
    const first = currentCandidate();
    const sibling = currentCandidate({
      candidateId: "sibling:20000",
      tokenId: "sibling-token",
      conditionId: "sibling-condition",
      marketId: "sibling-market",
    });
    const candidates = new CandidateService(
      { scan: async () => [first, sibling] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    const runtime = new EventBookRuntime();
    runtime.readyTokenIds.add(first.tokenId);
    runtime.books.set(first.tokenId, bookFor(first, "FIRST"));
    const preferences = new PaperTradingPreferencesService(database, testConfig);
    const opportunities = new EventOpportunityService(
      candidates,
      database,
      runtime,
      testConfig,
      preferences,
    );

    try {
      expect(opportunities.evaluateEvent(first.eventId)).toMatchObject({
        status: "INCOMPLETE",
        winner: null,
        participantCount: 2,
        incompleteTokenIds: [sibling.tokenId],
      });
      expect(database.listPaperEventLocks()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("uses the current complete Book and treats an empty Bid sibling as ineligible", async () => {
    const first = currentCandidate({
      bestAskMicros: 40_000,
      executableBuyPriceMicros: 40_000,
      makerBuyPriceMicros: 40_000,
    });
    const sibling = currentCandidate({
      candidateId: "empty-bid:20000",
      tokenId: "empty-bid-token",
      conditionId: "empty-bid-condition",
      marketId: "empty-bid-market",
    });
    const candidates = new CandidateService(
      { scan: async () => [first, sibling] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    const runtime = new EventBookRuntime();
    runtime.readyTokenIds.add(first.tokenId);
    runtime.readyTokenIds.add(sibling.tokenId);
    runtime.books.set(first.tokenId, bookFor(first, "FIRST"));
    runtime.books.set(sibling.tokenId, {
      ...bookFor(sibling, "EMPTY-BID"),
      bids: [],
    });
    const preferences = new PaperTradingPreferencesService(database, testConfig);
    const opportunities = new EventOpportunityService(
      candidates,
      database,
      runtime,
      testConfig,
      preferences,
    );

    try {
      expect(opportunities.evaluateEvent(first.eventId)).toMatchObject({
        status: "READY",
        participantCount: 2,
        eligibleOpportunityCount: 1,
        incompleteTokenIds: [],
        winner: {
          candidate: {
            tokenId: first.tokenId,
            bestAskMicros: 20_000,
            executableBuyPriceMicros: 20_000,
          },
        },
      });
    } finally {
      database.close();
    }
  });

  it("requires only the active Token to be ready after an Event is locked", async () => {
    const active = currentCandidate();
    const sibling = currentCandidate({
      candidateId: "locked-sibling:20000",
      tokenId: "locked-sibling",
      conditionId: "locked-sibling-condition",
      marketId: "locked-sibling-market",
    });
    const candidates = new CandidateService(
      { scan: async () => [active, sibling] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    database.executeTestFakBuy({
      candidate: active,
      book: {
        ...bookFor(active, "INITIAL"),
        asks: [{ priceMicros: 20_000, sizeMicros: 5_000_000 }],
      },
      maxPriceMicros: 30_000,
      orderBudgetMicros: 1_000_000,
      feeRateMicros: 0,
      feeExponent: 1,
      eligibility: testEligibilitySettings(),
    });
    const runtime = new EventBookRuntime();
    runtime.readyTokenIds.add(active.tokenId);
    runtime.books.set(active.tokenId, bookFor(active, "NEXT"));
    const preferences = new PaperTradingPreferencesService(database, testConfig);
    const opportunities = new EventOpportunityService(
      candidates,
      database,
      runtime,
      testConfig,
      preferences,
    );

    try {
      expect(opportunities.evaluateEvent(active.eventId)).toMatchObject({
        status: "READY",
        locked: true,
        participantCount: 1,
        incompleteTokenIds: [],
        arbitrationPerformed: false,
        winner: { candidate: { tokenId: active.tokenId } },
      });
    } finally {
      database.close();
    }
  });
});

function currentCandidate(
  overrides: Parameters<typeof makeCandidate>[0] = {},
): TradeCandidate {
  const now = Date.now();
  return makeCandidate({
    openedAt: new Date(now - 86_400_000).toISOString(),
    endsAt: new Date(now + 9 * 86_400_000).toISOString(),
    durationDays: 10,
    progressPercent: 10,
    bestBidMicros: 20_000,
    bestAskMicros: 20_000,
    executableBuyPriceMicros: 20_000,
    makerBuyPriceMicros: 20_000,
    ...overrides,
  });
}

function bookFor(candidate: TradeCandidate, version: string): TokenOrderBook {
  return {
    tokenId: candidate.tokenId,
    conditionId: candidate.conditionId,
    bookVersion: version,
    bids: [{ priceMicros: 20_000, sizeMicros: 100_000_000 }],
    asks: [{ priceMicros: 20_000, sizeMicros: 100_000_000 }],
    minOrderSizeMicros: candidate.minOrderSizeMicros,
    tickSizeMicros: candidate.tickSizeMicros,
    isNegativeRisk: candidate.isNegativeRisk,
  };
}
