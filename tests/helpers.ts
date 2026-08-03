import type { Event, Market } from "@polymarket/client";
import type { AppConfig } from "../src/config.js";
import type { TradeCandidate } from "../src/domain/types.js";

export const testConfig: AppConfig = {
  host: "127.0.0.1",
  port: 3000,
  databasePath: ":memory:",
  initialCapitalMicros: 100_000_000,
  totalBudgetMicros: 100_000_000,
  orderBudgetMicros: 1_000_000,
  maxMarketDurationDays: 30,
  maxMarketProgressPercent: 20,
  stopBuyProgressPercent: 90,
  minBuyPriceMicros: 10_000,
  maxBuyPriceMicros: 30_000,
  scanIntervalMs: 15_000,
  marketStreamReconnectMs: 2_000,
  scanEventPageSize: 50,
  maxScannedTokens: 120,
};

export function makeMarket(overrides: Record<string, unknown> = {}): Market {
  return {
    id: "market-1",
    conditionId: "0xcondition",
    question: "Will this test pass?",
    state: {
      active: true,
      closed: false,
      acceptingOrders: true,
      enableOrderBook: true,
    },
    outcomes: {
      yes: { label: "Yes", tokenId: "yes-token", price: "0.02" },
      no: { label: "No", tokenId: "no-token", price: "0.98" },
    },
    metrics: {},
    prices: {},
    trading: {},
    resolution: {
      questionId: null,
      negRiskRequestId: null,
      umaResolutionStatus: null,
      resolvedBy: null,
    },
    rewards: {},
    sports: {},
    events: [],
    tags: [],
    positionIds: [],
    ...overrides,
  } as unknown as Market;
}

export function makeEvent(overrides: Record<string, unknown> = {}): Event {
  return {
    id: "event-1",
    title: "Test event",
    category: "Tech",
    state: { active: true, closed: false, archived: false },
    schedule: {
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-01-11T00:00:00.000Z",
    },
    metrics: {},
    display: {},
    trading: { negRisk: false, negRiskAugmented: false },
    resolution: {},
    estimation: {},
    sports: { bestLines: [], teams: [] },
    partners: [],
    metadata: null,
    markets: [makeMarket()],
    series: [],
    tags: [],
    creators: [],
    ...overrides,
  } as unknown as Event;
}

export function makeCandidate(
  overrides: Partial<TradeCandidate> = {},
): TradeCandidate {
  return {
    candidateId: "yes-token:20000",
    eventId: "event-1",
    eventTitle: "Test event",
    category: "Tech",
    resultCount: 2,
    isNegativeRisk: false,
    marketId: "market-1",
    conditionId: "0xcondition",
    marketQuestion: "Will this test pass?",
    direction: "YES",
    tokenId: "yes-token",
    openedAt: "2026-01-01T00:00:00.000Z",
    endsAt: "2026-01-11T00:00:00.000Z",
    durationDays: 10,
    progressPercent: 10,
    gameStartsAt: null,
    bestBidMicros: 10_000,
    bestAskMicros: 30_000,
    makerBuyPriceMicros: 20_000,
    fixedSellPriceMicros: 30_000,
    orderSizeMicros: 50_000_000,
    queueAheadSizeMicros: 10_000_000,
    minOrderSizeMicros: 5_000_000,
    tickSizeMicros: 10_000,
    ...overrides,
  };
}
