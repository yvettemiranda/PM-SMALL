import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { TradingExecutionAdapter } from "./domain/execution.js";
import {
  calculateFixedSellPriceMicros,
  calculateOrderCostMicros,
  microsToDecimalString,
  type TargetSellPriceSettings,
} from "./domain/price.js";
import { calculateTakerFeeMicros } from "./domain/trading-strategy.js";
import type { PaperOrder, TradeCandidate } from "./domain/types.js";
import type {
  PaperDatabase,
  PaperEventLock,
  PaperPositionView,
  PaperSettlement,
  PaperTradeRecord,
  StrategyState,
} from "./infrastructure/db/database.js";
import type { LiveExecutorDisabled } from "./infrastructure/execution/live-executor-disabled.js";
import { TestExecutor } from "./infrastructure/execution/test-executor.js";
import type { CandidateService, CandidateSnapshot } from "./services/candidate-service.js";
import type { PaperMarketRuntime } from "./services/market-stream-service.js";
import type {
  PaperAutomationEventEvaluation,
  PaperAutomationRuntime,
} from "./services/paper-automation-service.js";
import {
  EventOpportunityService,
  type EventOpportunityEvaluation,
} from "./services/event-opportunity-service.js";
import type { PaperSettlementRuntime } from "./services/paper-settlement-service.js";
import type {
  PaperTradingPreferencesService,
  PaperTradingPreferencesSnapshot,
} from "./services/paper-trading-preferences-service.js";
import type { PaperValidationRuntime } from "./services/paper-validation-service.js";

export type AppDependencies = {
  config: AppConfig;
  database: PaperDatabase;
  candidates: CandidateService;
  tradingPreferences: PaperTradingPreferencesService;
  liveExecutor: LiveExecutorDisabled;
  testExecutor?: TradingExecutionAdapter;
  marketStream?: PaperMarketRuntime;
  paperAutomation?: PaperAutomationRuntime;
  paperSettlement?: PaperSettlementRuntime;
  paperValidation?: PaperValidationRuntime;
};

const tenthCentPriceSchema = z
  .number()
  .finite()
  .min(0.1)
  .max(99)
  .refine(isTenthCent, "Buy price must use 0.1-cent increments");

function isTenthCent(value: number): boolean {
  return Number.isInteger(value * 10);
}

function publicConfig(
  config: AppConfig,
  preferences: PaperTradingPreferencesSnapshot,
  strategy: StrategyState,
) {
  return {
    initialCapital: microsToDecimalString(strategy.initialCapitalMicros),
    totalBudget: microsToDecimalString(strategy.initialCapitalMicros),
    orderBudget: microsToDecimalString(preferences.orderBudgetMicros),
    marketTypes: preferences.marketTypes,
    minMarketDurationDays: preferences.minMarketDurationDays,
    maxMarketDurationDays: preferences.maxMarketDurationDays,
    minBuyPrice: microsToDecimalString(preferences.minBuyPriceMicros),
    maxBuyPrice: microsToDecimalString(preferences.maxBuyPriceMicros),
    targetSellPriceIncrease: microsToDecimalString(
      preferences.targetSellPriceIncreaseMicros,
    ),
    targetSellPriceMultiplier:
      preferences.targetSellPriceMultiplierMicros / 1_000_000,
    minBidAskRatioPercent: preferences.minBidAskRatioPercent,
    maxMarketProgressPercent: preferences.maxMarketProgressPercent,
    scanIntervalMs: config.scanIntervalMs,
    paperSettlementIntervalMs: config.paperSettlementIntervalMs,
    paperValidationIntervalMs: config.paperValidationIntervalMs,
  };
}

function runtimeStatus() {
  const { rss, heapTotal, heapUsed, external } = process.memoryUsage();
  return {
    uptimeSeconds: process.uptime(),
    rssBytes: rss,
    heapTotalBytes: heapTotal,
    heapUsedBytes: heapUsed,
    externalBytes: external,
  };
}

function serializeState(state: StrategyState) {
  return {
    ...state,
    mode: "TEST" as const,
    initialCapital: microsToDecimalString(state.initialCapitalMicros),
    availableCash: microsToDecimalString(state.availableCashMicros),
    reservedCash: microsToDecimalString(state.reservedCashMicros),
    realizedPnl: microsToDecimalString(state.realizedPnlMicros),
    positionCost: microsToDecimalString(state.positionCostMicros),
  };
}

function serializeOrder(order: PaperOrder) {
  return {
    ...order,
    price: microsToDecimalString(order.priceMicros),
    targetSellPrice:
      order.targetSellPriceMicros === null
        ? null
        : microsToDecimalString(order.targetSellPriceMicros),
    originalSize: microsToDecimalString(order.originalSizeMicros),
    filledSize: microsToDecimalString(order.filledSizeMicros),
    queueAheadSize: microsToDecimalString(order.queueAheadSizeMicros),
    observedTradeSize: microsToDecimalString(order.observedTradeSizeMicros),
    cashLimit: microsToDecimalString(order.cashLimitMicros),
    fee: microsToDecimalString(order.feeMicros),
  };
}

function serializeSettlement(settlement: PaperSettlement) {
  return {
    ...settlement,
    positionCost: microsToDecimalString(settlement.positionCostMicros),
    payout: microsToDecimalString(settlement.payoutMicros),
    realizedPnl: microsToDecimalString(settlement.realizedPnlMicros),
  };
}

function serializeTradeRecord(record: PaperTradeRecord) {
  return {
    ...record,
    marketUrl: polymarketEventUrl(record.eventSlug, record.eventId),
    quantity:
      record.quantityMicros === null
        ? null
        : microsToDecimalString(record.quantityMicros),
    price:
      record.priceMicros === null
        ? null
        : microsToDecimalString(record.priceMicros),
    amount: microsToDecimalString(record.amountMicros),
    realizedPnl:
      record.realizedPnlMicros === null
        ? null
        : microsToDecimalString(record.realizedPnlMicros),
  };
}

function serializeCandidate(
  candidate: TradeCandidate,
  availability: { tradable: boolean; quoteStatus: string } = {
    tradable: candidate.bookReady,
    quoteStatus: candidate.bookReady ? "READY" : "NOT_READY",
  },
  targetSellPriceSettings?: TargetSellPriceSettings,
) {
  const fixedSellPriceMicros =
    targetSellPriceSettings === undefined ||
    candidate.executableBuyPriceMicros === 0
      ? candidate.fixedSellPriceMicros
      : calculateFixedSellPriceMicros(
          candidate.executableBuyPriceMicros,
          candidate.tickSizeMicros,
          targetSellPriceSettings,
        );
  return {
    ...candidate,
    ...availability,
    marketUrl: polymarketEventUrl(candidate.eventSlug, candidate.eventId),
    bestBid:
      candidate.bestBidMicros === null
        ? null
        : microsToDecimalString(candidate.bestBidMicros),
    bestAsk:
      candidate.bestAskMicros === null
        ? null
        : microsToDecimalString(candidate.bestAskMicros),
    executableBuyPrice: microsToDecimalString(
      candidate.executableBuyPriceMicros,
    ),
    fixedSellPrice: microsToDecimalString(fixedSellPriceMicros),
    orderSize: microsToDecimalString(candidate.orderSizeMicros),
    queueAheadSize: microsToDecimalString(candidate.queueAheadSizeMicros),
    minOrderSize: microsToDecimalString(candidate.minOrderSizeMicros),
    tickSize: microsToDecimalString(candidate.tickSizeMicros),
  };
}

function serializeSnapshot(
  snapshot: CandidateSnapshot,
  dependencies: AppDependencies,
  includeCandidates = true,
) {
  const { candidates: _unfilteredCandidates, ...status } = snapshot;
  const marketScan = buildEventMarketScan(snapshot, dependencies, new Date());
  const summary = {
    ...status,
    ...marketScan.summary,
  };
  return includeCandidates
    ? {
        ...summary,
        events: marketScan.events,
        candidates: marketScan.candidates,
      }
    : summary;
}

function buildEventMarketScan(
  snapshot: CandidateSnapshot,
  dependencies: AppDependencies,
  now: Date,
) {
  const staticCandidates = snapshot.candidates.filter((candidate) =>
    dependencies.tradingPreferences.candidateMatchesStaticFilters(
      candidate,
      now,
    ),
  );
  const candidatesByEvent = new Map<string, TradeCandidate[]>();
  for (const candidate of staticCandidates) {
    const siblings = candidatesByEvent.get(candidate.eventId) ?? [];
    siblings.push(candidate);
    candidatesByEvent.set(candidate.eventId, siblings);
  }
  const evaluationByEvent = new Map<string, PaperAutomationEventEvaluation>(
    (dependencies.paperAutomation?.getEventEvaluations?.() ?? []).map(
      (evaluation) => [evaluation.eventId, evaluation],
    ),
  );
  const lockByEvent = new Map(
    dependencies.database
      .listPaperEventLocks()
      .map((lock) => [lock.eventId, lock]),
  );
  const exitingEventIds = new Set(
    dependencies.database
      .listCurrentPaperPositionViews()
      .filter(
        (position) =>
          position.eventId !== null && position.firstSellAt !== null,
      )
      .map((position) => position.eventId as string),
  );
  const direction =
    dependencies.tradingPreferences.getSnapshot().candidateSortDirection;
  const targetSellPriceSettings =
    dependencies.tradingPreferences.getTargetSellPriceSettings();
  const events = [...candidatesByEvent.entries()].map(([eventId, siblings]) => {
    const orderedSiblings = dependencies.tradingPreferences.getOrderedCandidates(
      siblings.map((candidate) => ({ ...candidate, bookReady: true })),
      now,
    );
    const evaluation = evaluationByEvent.get(eventId);
    const lock = evaluation?.lock ?? lockByEvent.get(eventId) ?? null;
    const cachedWinner = evaluation?.winner;
    const fallbackWinner =
      evaluation === undefined && dependencies.marketStream === undefined
        ? dependencies.tradingPreferences
            .getOrderedCandidates(siblings, now)
            .find((candidate) => candidate.bookReady)
        : undefined;
    const winner = cachedWinner ?? fallbackWinner ?? null;
    const activeCandidate =
      lock?.activeTokenId === null || lock?.activeTokenId === undefined
        ? undefined
        : siblings.find((candidate) => candidate.tokenId === lock.activeTokenId);
    const representative = winner ?? activeCandidate ?? orderedSiblings[0] ?? siblings[0];
    if (representative === undefined) {
      throw new Error(`Event has no display candidate: ${eventId}`);
    }
    const status =
      evaluation?.status ??
      (winner !== null
        ? "READY"
        : dependencies.marketStream !== undefined &&
            siblings.some(
              (candidate) =>
                !dependencies.marketStream?.isTokenReady(candidate.tokenId),
            )
          ? "INCOMPLETE"
          : "NO_WINNER");
    const winnerTokenId = winner?.tokenId ?? null;
    const incompleteTokenIds = new Set(evaluation?.incompleteTokenIds ?? []);
    const opportunityTokenIds = new Set(
      evaluation?.opportunityTokenIds ?? [],
    );
    const outcomes = [...siblings]
      .sort(
        (left, right) =>
          left.marketId.localeCompare(right.marketId) ||
          left.direction.localeCompare(right.direction) ||
          left.tokenId.localeCompare(right.tokenId),
      )
      .map((candidate) => {
        const isWinner = candidate.tokenId === winnerTokenId;
        const quoteStatus = incompleteTokenIds.has(candidate.tokenId)
          ? dependencies.marketStream?.getQuoteStatus?.(candidate.tokenId) ??
            "NOT_READY"
          : isWinner
            ? "READY"
            : opportunityTokenIds.has(candidate.tokenId)
              ? "ELIGIBLE"
              : "FILTERED";
        return {
          ...serializeCandidate(candidate, {
            tradable: isWinner && status === "READY",
            quoteStatus,
          }, targetSellPriceSettings),
          isWinner,
          participationStatus: incompleteTokenIds.has(candidate.tokenId)
            ? "INCOMPLETE"
            : isWinner
              ? "WINNER"
              : opportunityTokenIds.has(candidate.tokenId)
                ? "ELIGIBLE"
                : "FILTERED",
        };
      });
    const serializedRepresentative = serializeCandidate(representative, {
      tradable: winnerTokenId === representative.tokenId && status === "READY",
      quoteStatus:
        dependencies.marketStream?.getQuoteStatus?.(representative.tokenId) ??
        (winnerTokenId === representative.tokenId && status === "READY"
          ? "READY"
          : status),
    }, targetSellPriceSettings);
    return {
      eventId,
      eventSlug: representative.eventSlug,
      eventTitle: representative.eventTitle,
      marketUrl: polymarketEventUrl(
        representative.eventSlug,
        representative.eventId,
      ),
      resultCount: Math.max(
        ...siblings.map((candidate) => candidate.resultCount ?? 0),
      ),
      participantTokenCount: evaluation?.participantCount ?? siblings.length,
      eligibleTokenCount:
        evaluation?.eligibleOpportunityCount ?? (winner === null ? 0 : 1),
      marketCount: new Set(siblings.map((candidate) => candidate.marketId)).size,
      tokenCount: siblings.length,
      progressPercent: representative.progressPercent,
      openedAt: representative.openedAt,
      endsAt: representative.endsAt,
      status,
      locked: lock !== null,
      lockState: lock?.state ?? null,
      activeTokenId: lock?.activeTokenId ?? null,
      winnerTokenId,
      winner:
        winner === null
          ? null
          : serializeCandidate(winner, {
              tradable: status === "READY",
              quoteStatus: status === "READY" ? "READY" : status,
            }, targetSellPriceSettings),
      representative: serializedRepresentative,
      outcomes,
    };
  });
  events.sort((left, right) => {
    const tradability =
      (left.status === "READY" ? 0 : 1) -
      (right.status === "READY" ? 0 : 1);
    const progress =
      direction === "ASC"
        ? left.progressPercent - right.progressPercent
        : right.progressPercent - left.progressPercent;
    return tradability || progress || left.eventId.localeCompare(right.eventId);
  });
  const readyEventCount = events.filter((event) => event.status === "READY").length;
  const incompleteEventCount = events.filter(
    (event) => event.status === "INCOMPLETE",
  ).length;
  const eligibleTokenCount = events.reduce(
    (sum, event) =>
      sum +
      event.outcomes.filter(
        (outcome) =>
          outcome.participationStatus === "ELIGIBLE" ||
          outcome.participationStatus === "WINNER",
      ).length,
    0,
  );
  const tokenCount = events.reduce((sum, event) => sum + event.tokenCount, 0);
  const maxObservedResultCount = events.reduce(
    (maximum, event) => Math.max(maximum, event.resultCount),
    0,
  );
  return {
    summary: {
      candidateCount: readyEventCount,
      eventCount: readyEventCount,
      monitoredEventCount: events.length,
      monitoredTokenCount: tokenCount,
      completeEventCount: events.length - incompleteEventCount,
      incompleteEventCount,
      eligibleTokenCount,
      arbitratedEventCount: events.filter(
        (event) => evaluationByEvent.get(event.eventId)?.arbitrationPerformed,
      ).length,
      winnerEventCount: readyEventCount,
      lockedEventCount: lockByEvent.size,
      exitingEventCount: exitingEventIds.size,
      legacyConflictCount: [...lockByEvent.values()].filter(
        (eventLock) => eventLock.state === "LEGACY_CONFLICT",
      ).length,
      displayCandidateCount: events.length,
      displayEventCount: events.length,
      pendingEventCount: events.length - readyEventCount,
      staleCandidateCount: events.length - readyEventCount,
      tokenCount,
      maxObservedResultCount,
    },
    events,
    candidates: events.map((event) => event.representative),
  };
}

function serializePreferences(preferences: PaperTradingPreferencesSnapshot) {
  return {
    marketTypes: preferences.marketTypes,
    allCategories: preferences.allCategories,
    selectedCategories: preferences.selectedCategories,
    selectedCategoryIds: preferences.selectedCategories,
    candidateSortDirection: preferences.candidateSortDirection,
    minMarketDurationDays: preferences.minMarketDurationDays,
    maxMarketDurationDays: preferences.maxMarketDurationDays,
    updatedAt: preferences.updatedAt,
    minBuyPrice: microsToDecimalString(preferences.minBuyPriceMicros),
    minBuyPriceCents: preferences.minBuyPriceMicros / 10_000,
    maxBuyPrice: microsToDecimalString(preferences.maxBuyPriceMicros),
    maxBuyPriceCents: preferences.maxBuyPriceMicros / 10_000,
    targetSellPriceIncrease:
      microsToDecimalString(preferences.targetSellPriceIncreaseMicros),
    targetSellPriceIncreaseCents:
      preferences.targetSellPriceIncreaseMicros / 10_000,
    targetSellPriceMultiplier:
      preferences.targetSellPriceMultiplierMicros / 1_000_000,
    minBidAskRatioPercent: preferences.minBidAskRatioPercent,
    maxMarketProgressPercent: preferences.maxMarketProgressPercent,
    orderAmount: microsToDecimalString(preferences.orderBudgetMicros),
  };
}

function averagePriceMicros(position: PaperPositionView): number | null {
  if (position.grossBuySizeMicros <= 0) {
    return null;
  }
  return Number(
    (BigInt(position.grossBuyNotionalMicros) * 1_000_000n) /
      BigInt(position.grossBuySizeMicros),
  );
}

function currentMarketProgress(
  openedAt: string | null,
  endsAt: string | null,
  now: Date,
): number | null {
  if (openedAt === null || endsAt === null) {
    return null;
  }
  const openedAtMs = Date.parse(openedAt);
  const endsAtMs = Date.parse(endsAt);
  if (
    !Number.isFinite(openedAtMs) ||
    !Number.isFinite(endsAtMs) ||
    endsAtMs <= openedAtMs
  ) {
    return null;
  }
  return Math.min(
    100,
    Math.max(0, ((now.getTime() - openedAtMs) / (endsAtMs - openedAtMs)) * 100),
  );
}

function polymarketEventUrl(eventSlug: string | null, eventId: string | null) {
  const identifier = eventSlug ?? eventId;
  return identifier === null
    ? null
    : `https://polymarket.com/event/${encodeURIComponent(identifier)}`;
}

function markPriceMicros(
  position: PaperPositionView,
  dependencies: AppDependencies,
  candidate: TradeCandidate | undefined = undefined,
): number | null {
  const streamed = dependencies.marketStream?.getBestBidMicros?.(position.tokenId);
  if (streamed !== undefined) {
    return streamed;
  }
  return (
    candidate?.bestBidMicros ??
    dependencies.candidates
      .getSnapshot()
      .candidates.find((item) => item.tokenId === position.tokenId)
      ?.bestBidMicros ??
    null
  );
}

type PositionSerializationContext = {
  candidateByToken: Map<string, TradeCandidate>;
  eventLockByEvent: Map<string, PaperEventLock>;
  targetSellPricesByToken: Map<string, number[]>;
};

function positionSerializationContext(
  dependencies: AppDependencies,
): PositionSerializationContext {
  const targetSellPricesByToken = new Map<string, number[]>();
  for (const order of dependencies.database.listActivePaperOrders()) {
    if (order.side !== "SELL" || order.executionKind !== "TARGET") continue;
    const prices = targetSellPricesByToken.get(order.tokenId) ?? [];
    prices.push(order.priceMicros);
    targetSellPricesByToken.set(order.tokenId, prices);
  }
  for (const prices of targetSellPricesByToken.values()) {
    prices.sort((left, right) => left - right);
  }
  return {
    candidateByToken: new Map(
      dependencies.candidates
        .getSnapshot()
        .candidates.map((candidate) => [candidate.tokenId, candidate]),
    ),
    eventLockByEvent: new Map(
      dependencies.database
        .listPaperEventLocks()
        .map((eventLock) => [eventLock.eventId, eventLock]),
    ),
    targetSellPricesByToken,
  };
}

function serializePositionViews(
  positions: readonly PaperPositionView[],
  dependencies: AppDependencies,
  now: Date,
) {
  const context = positionSerializationContext(dependencies);
  return positions.map((position) =>
    serializePositionView(position, dependencies, now, context),
  );
}

function serializePositionView(
  position: PaperPositionView,
  dependencies: AppDependencies,
  now: Date,
  context: PositionSerializationContext,
) {
  const candidate = context.candidateByToken.get(position.tokenId);
  const eventId = position.eventId ?? candidate?.eventId ?? null;
  const eventLock = eventId === null ? null : context.eventLockByEvent.get(eventId) ?? null;
  const eventSlug = position.eventSlug ?? candidate?.eventSlug ?? null;
  const openedAt = position.openedAt ?? candidate?.openedAt ?? null;
  const endsAt = position.endsAt ?? candidate?.endsAt ?? null;
  const averageBuyPriceMicros = averagePriceMicros(position);
  const currentMarkPriceMicros = markPriceMicros(
    position,
    dependencies,
    candidate,
  );
  const currentSellPriceStatus = quoteStatusForPosition(
    position.tokenId,
    currentMarkPriceMicros,
    dependencies,
  );
  const marketValueMicros = positionMarketValueMicros(
    position,
    currentMarkPriceMicros,
    dependencies,
  );
  const targetSellPrices = context.targetSellPricesByToken.get(position.tokenId) ?? [];
  const cycleStatus =
    eventLock?.state === "LEGACY_CONFLICT"
      ? "LEGACY_CONFLICT"
      : position.firstSellAt === null
        ? "ACCUMULATING"
        : "EXITING";
  return {
    ...position,
    eventId,
    eventSlug,
    eventTitle: position.eventTitle ?? candidate?.eventTitle ?? null,
    marketId: position.marketId ?? candidate?.marketId ?? null,
    marketQuestion:
      position.marketQuestion ?? candidate?.marketQuestion ?? null,
    direction: position.direction ?? candidate?.direction ?? null,
    openedAt,
    endsAt,
    marketUrl: polymarketEventUrl(eventSlug, eventId),
    eventLockState: eventLock?.state ?? null,
    activeTokenId: eventLock?.activeTokenId ?? null,
    cycleStatus,
    cycleBudget:
      eventLock?.state !== "ACTIVE"
        ? null
        : microsToDecimalString(eventLock.cycleBudgetMicros),
    cycleSpent: microsToDecimalString(position.cycleSpendMicros),
    quantity: microsToDecimalString(position.quantityMicros),
    cost: microsToDecimalString(position.costMicros),
    realizedPnl: microsToDecimalString(position.realizedPnlMicros),
    averageBuyPrice:
      averageBuyPriceMicros === null
        ? null
        : microsToDecimalString(averageBuyPriceMicros),
    markPrice:
      currentMarkPriceMicros === null
        ? null
        : microsToDecimalString(currentMarkPriceMicros),
    currentSellPrice:
      currentMarkPriceMicros === null
        ? null
        : microsToDecimalString(currentMarkPriceMicros),
    currentSellPriceStatus,
    targetSellPrice:
      targetSellPrices[0] === undefined
        ? null
        : microsToDecimalString(targetSellPrices[0]),
    targetSellPrices: targetSellPrices.map(microsToDecimalString),
    unrealizedPnl: microsToDecimalString(
      marketValueMicros - position.costMicros,
    ),
    progressPercent: currentMarketProgress(openedAt, endsAt, now),
  };
}

function quoteStatusForPosition(
  tokenId: string,
  currentMarkPriceMicros: number | null,
  dependencies: AppDependencies,
) {
  const explicitStatus = dependencies.marketStream?.getQuoteStatus?.(tokenId);
  if (explicitStatus !== undefined) {
    return explicitStatus;
  }
  if (currentMarkPriceMicros !== null) {
    return "READY" as const;
  }
  const streamStatus = dependencies.marketStream?.getStatus();
  if (streamStatus === undefined || !streamStatus.running) {
    return "DISCONNECTED" as const;
  }
  return streamStatus.connected ? ("NO_BID" as const) : ("RECONNECTING" as const);
}

function serializePortfolio(
  state: StrategyState,
  positions: readonly PaperPositionView[],
  dependencies: AppDependencies,
) {
  let marketValueMicros = 0;
  for (const position of positions) {
    marketValueMicros += positionMarketValueMicros(
      position,
      markPriceMicros(position, dependencies),
      dependencies,
    );
  }
  const unrealizedPnlMicros = marketValueMicros - state.positionCostMicros;
  const totalPnlMicros = state.realizedPnlMicros + unrealizedPnlMicros;
  const totalFundsMicros =
    state.availableCashMicros + state.reservedCashMicros + marketValueMicros;
  return {
    totalFunds: microsToDecimalString(totalFundsMicros),
    positionValue: microsToDecimalString(marketValueMicros),
    totalPnl: microsToDecimalString(totalPnlMicros),
    realizedPnl: microsToDecimalString(state.realizedPnlMicros),
    unrealizedPnl: microsToDecimalString(unrealizedPnlMicros),
  };
}

function positionMarketValueMicros(
  position: PaperPositionView,
  valuationPriceMicros: number | null,
  dependencies: AppDependencies,
): number {
  if (valuationPriceMicros === null) {
    // TEST PnL is based on immediately executable value. With no bid there is
    // currently no realizable exit value, so carrying the position at cost
    // would overstate both funds and performance.
    return 0;
  }
  const grossValueMicros = calculateOrderCostMicros(
    valuationPriceMicros,
    position.quantityMicros,
  );
  const metadata = dependencies.database.getTestMarketExecutionMetadata(
    position.tokenId,
  );
  const feeMicros =
    metadata === null
      ? 0
      : calculateTakerFeeMicros({
          sizeMicros: position.quantityMicros,
          priceMicros: valuationPriceMicros,
          feeRateMicros: metadata.feeRateMicros,
          feeExponent: metadata.feeExponent,
        });
  return Math.max(0, grossValueMicros - feeMicros);
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: true });
  const testExecutor =
    dependencies.testExecutor ?? new TestExecutor(dependencies.database);
  if (testExecutor.mode !== "TEST" || !testExecutor.enabled) {
    throw new Error("The HTTP app requires the enabled TEST executor");
  }

  app.get("/api/health", async () => ({ status: "ok", mode: "TEST" }));

  app.get("/api/status", async (request) => {
    const query = z
      .object({ compact: z.enum(["true", "false"]).optional() })
      .parse(request.query);
    const strategy = dependencies.database.getStrategyState();
    const positions = dependencies.database.listCurrentPaperPositionViews();
    const preferences = dependencies.tradingPreferences.getSnapshot();
    return {
      version: "0.5.0",
      executionMode: "TEST",
      liveExecutionEnabled: dependencies.liveExecutor.enabled,
      strategy: serializeState(strategy),
      capitalEditable: dependencies.database.canUpdateTestInitialCapital(),
      portfolio: serializePortfolio(strategy, positions, dependencies),
      configuration: publicConfig(dependencies.config, preferences, strategy),
      runtime: runtimeStatus(),
      marketScan: serializeSnapshot(
        dependencies.candidates.getSnapshot(),
        dependencies,
        query.compact !== "true",
      ),
      marketStream: dependencies.marketStream?.getStatus() ?? {
        running: false,
        connected: false,
        subscribedTokenCount: 0,
        dataCompleteTokenCount: 0,
        lastEventAt: null,
        processedTradeEvents: 0,
        ignoredTradeEvents: 0,
        paperBuyFillCount: 0,
        paperSellFillCount: 0,
        createdPaperSellCount: 0,
        connectionCount: 0,
        fullSnapshotCount: 0,
        unexpectedDisconnectCount: 0,
        recoveryCount: 0,
        lastFullSnapshotDurationMs: null,
        lastRecoveryDurationMs: null,
        lastError: null,
      },
      paperAutomation: dependencies.paperAutomation?.getStatus() ?? {
        running: false,
        lastRunAt: null,
        lastError: null,
        placedBuyCount: 0,
        cancelledFilterBuyCount: 0,
        cancelledStartedBuyCount: 0,
        cancelledProgressedBuyCount: 0,
        eventsEvaluatedCount: 0,
        incompleteEventCount: 0,
        arbitrationCount: 0,
        arbitrationRecomputeCount: 0,
        staleArbitrationRejectionCount: 0,
        skippedLockedSiblingQuoteCount: 0,
        maxObservedResultCount: 0,
        recovery: null,
      },
      paperSettlement: dependencies.paperSettlement?.getStatus() ?? {
        running: false,
        lastRunAt: null,
        lastError: null,
        checkedMarketCount: 0,
        waitingMarketCount: 0,
        settledMarketCount: 0,
      },
      paperValidation: dependencies.paperValidation?.getStatus() ?? {
        running: false,
        validationCount: 0,
        failedValidationCount: 0,
        lastRunAt: null,
        lastError: null,
        lastResult: null,
      },
    };
  });

  app.get("/api/dashboard", async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).default(20),
      })
      .parse(request.query);
    const strategy = dependencies.database.getStrategyState();
    const positions = dependencies.database.listCurrentPaperPositionViews();
    const preferences = dependencies.tradingPreferences.getSnapshot();
    const candidateSnapshot = dependencies.candidates.getSnapshot();
    const eventMarketScan = buildEventMarketScan(
      candidateSnapshot,
      dependencies,
      new Date(),
    );
    const { candidates: _unfilteredCandidates, ...marketScanStatus } =
      candidateSnapshot;
    const visibleEvents = eventMarketScan.events.slice(0, query.limit);
    return {
      version: "0.5.0",
      executionMode: "TEST",
      liveExecutionEnabled: false,
      strategy: serializeState(strategy),
      portfolio: serializePortfolio(strategy, positions, dependencies),
      positions: serializePositionViews(positions, dependencies, new Date()),
      preferences: serializePreferences(preferences),
      capitalEditable: dependencies.database.canUpdateTestInitialCapital(),
      marketScan: {
        ...marketScanStatus,
        ...eventMarketScan.summary,
        events: visibleEvents,
        candidates: visibleEvents.map((event) => event.representative),
        displayedCandidateCount: visibleEvents.length,
        displayedEventCount: visibleEvents.length,
      },
    };
  });

  app.get("/api/test/validation", async (_request, reply) => {
    // Keep GET side-effect free. The periodic service owns pause and audit.
    const validation = dependencies.database.validatePaperState();
    return reply.code(validation.passed ? 200 : 503).send({ validation });
  });

  app.post("/api/test/start", async () => {
    const strategy = dependencies.database.setStrategyStatus("RUNNING");
    dependencies.paperAutomation?.requestRun();
    dependencies.paperSettlement?.requestRun();
    dependencies.marketStream?.refreshSubscriptions();
    return { strategy: serializeState(strategy) };
  });

  app.post("/api/test/pause", async () => ({
    strategy: serializeState(dependencies.database.setStrategyStatus("PAUSED")),
  }));

  app.post("/api/test/stop", async () => ({
    strategy: serializeState(dependencies.database.setStrategyStatus("STOPPED")),
  }));

  app.get("/api/candidates", async (request) => {
    const query = z
      .object({ refresh: z.enum(["true", "false"]).optional() })
      .parse(request.query);
    const snapshot =
      query.refresh === "true"
        ? await dependencies.candidates.refresh()
        : dependencies.candidates.getSnapshot();
    return serializeSnapshot(snapshot, dependencies);
  });

  app.get("/api/test/preferences", async () => ({
    preferences: serializePreferences(dependencies.tradingPreferences.getSnapshot()),
    capitalEditable: dependencies.database.canUpdateTestInitialCapital(),
  }));

  app.put("/api/test/preferences", async (request) => {
    const body = z
      .object({
        marketTypes: z.array(z.enum(["BINARY", "TERNARY", "MULTI"])).min(1),
        minBuyPriceCents: tenthCentPriceSchema.optional(),
        maxBuyPriceCents: tenthCentPriceSchema,
        targetSellPriceIncreaseCents: z
          .number()
          .finite()
          .min(0)
          .max(99)
          .optional(),
        targetSellPriceMultiplier: z
          .number()
          .finite()
          .nonnegative()
          .refine(
            (value) => Number.isSafeInteger(Math.round(value * 1_000_000)),
            "Target multiplier is outside the supported precision",
          )
          .optional(),
        minMarketDurationDays: z.number().int().min(1).max(365).optional(),
        maxMarketDurationDays: z.number().int().min(1).max(365),
        allCategories: z.boolean().optional(),
        selectedCategoryIds: z.array(z.string().trim().min(1).max(80)).optional(),
        selectedCategories: z.array(z.string().trim().min(1).max(80)).optional(),
        candidateSortDirection: z.enum(["ASC", "DESC"]).optional(),
        minBidAskRatioPercent: z.number().int().min(1).max(100).optional(),
        maxMarketProgressPercent: z.number().int().min(1).max(100).optional(),
        orderAmount: z.number().finite().positive().max(1_000_000).optional(),
        initialCapital: z.number().finite().positive().max(1_000_000).optional(),
      })
      .parse(request.body);
    const currentPreferences = dependencies.tradingPreferences.getSnapshot();
    const requestedMinBuyPriceMicros =
      body.minBuyPriceCents === undefined
        ? currentPreferences.minBuyPriceMicros
        : centsToMicros(body.minBuyPriceCents);
    const requestedMaxBuyPriceMicros = centsToMicros(body.maxBuyPriceCents);
    if (requestedMinBuyPriceMicros > requestedMaxBuyPriceMicros) {
      throw new Error(
        "Minimum TEST buy price cannot exceed maximum TEST buy price",
      );
    }
    const requestedMinMarketDurationDays =
      body.minMarketDurationDays ?? currentPreferences.minMarketDurationDays;
    if (requestedMinMarketDurationDays > body.maxMarketDurationDays) {
      throw new Error(
        "Minimum market duration cannot exceed maximum market duration",
      );
    }
    const selectedCategoryIds =
      body.selectedCategoryIds ?? body.selectedCategories;
    if (
      body.allCategories === false &&
      (selectedCategoryIds === undefined || selectedCategoryIds.length === 0)
    ) {
      throw new Error("Select at least one official market category");
    }
    const currentStrategy = dependencies.database.getStrategyState();
    const requestedInitialCapitalMicros =
      body.initialCapital === undefined
        ? currentStrategy.initialCapitalMicros
        : unitsToMicros(body.initialCapital);
    const requestedOrderBudgetMicros =
      body.orderAmount === undefined
        ? dependencies.tradingPreferences.getSnapshot().orderBudgetMicros
        : unitsToMicros(body.orderAmount);
    if (requestedOrderBudgetMicros > requestedInitialCapitalMicros) {
      throw new Error("Per-Event cycle TEST amount cannot exceed total TEST capital");
    }
    if (
      requestedInitialCapitalMicros !== currentStrategy.initialCapitalMicros &&
      !dependencies.database.canUpdateTestInitialCapital()
    ) {
      throw new Error(
        "Pause and reset TEST before changing total capital after trading history exists",
      );
    }
    const strategy =
      requestedInitialCapitalMicros === currentStrategy.initialCapitalMicros
        ? currentStrategy
        : dependencies.database.updateTestInitialCapital(
            requestedInitialCapitalMicros,
          );
    const update = dependencies.tradingPreferences.updateMarketFilters({
      marketTypes: body.marketTypes,
      minBuyPriceMicros: requestedMinBuyPriceMicros,
      maxBuyPriceMicros: requestedMaxBuyPriceMicros,
      ...(body.targetSellPriceIncreaseCents === undefined
        ? {}
        : {
            targetSellPriceIncreaseMicros: centsToMicros(
              body.targetSellPriceIncreaseCents,
              true,
            ),
          }),
      ...(body.targetSellPriceMultiplier === undefined
        ? {}
        : {
            targetSellPriceMultiplierMicros: multiplierToMicros(
              body.targetSellPriceMultiplier,
            ),
          }),
      minMarketDurationDays: requestedMinMarketDurationDays,
      maxMarketDurationDays: body.maxMarketDurationDays,
      ...(body.allCategories === undefined
        ? {}
        : { allCategories: body.allCategories }),
      ...(selectedCategoryIds === undefined
        ? {}
        : { selectedCategories: selectedCategoryIds }),
      ...(body.candidateSortDirection === undefined
        ? {}
        : { candidateSortDirection: body.candidateSortDirection }),
      ...(body.orderAmount === undefined
        ? {}
        : { orderBudgetMicros: requestedOrderBudgetMicros }),
      ...(body.minBidAskRatioPercent === undefined
        ? {}
        : { minBidAskRatioPercent: body.minBidAskRatioPercent }),
      ...(body.maxMarketProgressPercent === undefined
        ? {}
        : { maxMarketProgressPercent: body.maxMarketProgressPercent }),
    });
    dependencies.paperAutomation?.requestRun();
    dependencies.marketStream?.refreshSubscriptions();
    const scanWasRunning = dependencies.candidates.getSnapshot().scanning;
    void dependencies.candidates.refresh().then(() => {
      if (scanWasRunning) void dependencies.candidates.refresh();
    });
    return {
      preferences: serializePreferences(update.preferences),
      cancelledBuyCount: update.cancelledBuyCount,
      strategy: serializeState(strategy),
      capitalEditable: dependencies.database.canUpdateTestInitialCapital(),
    };
  });

  app.get("/api/test/orders", async () => ({
    orders: dependencies.database.listPaperOrders().map(serializeOrder),
    activeBuyOrderCount: dependencies.database
      .listActivePaperOrders()
      .filter((order) => order.side === "BUY").length,
  }));

  app.get("/api/test/trade-records", async (request) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
      .parse(request.query);
    const page = dependencies.database.listPaperTradeRecords(query.limit);
    return {
      totalCount: page.totalCount,
      records: page.records.map(serializeTradeRecord),
    };
  });

  app.get("/api/test/positions", async () => ({
    positions: serializePositionViews(
      dependencies.database.listCurrentPaperPositionViews(),
      dependencies,
      new Date(),
    ),
  }));

  app.get("/api/test/settlements", async () => ({
    settlements: dependencies.database
      .listPaperSettlements()
      .map(serializeSettlement),
  }));

  app.post("/api/test/orders/buy", async (request, reply) => {
    const body = z.object({ candidateId: z.string().min(1) }).parse(request.body);
    const candidate = dependencies.candidates.getCandidate(body.candidateId);
    if (candidate === null) {
      return reply.code(404).send({ error: "Candidate is unavailable or stale" });
    }
    if (
      !dependencies.tradingPreferences.candidateMatchesStaticFilters(
        candidate,
        new Date(),
      )
    ) {
      return reply.code(409).send({
        error: "Candidate is excluded by the current TEST filters",
      });
    }

    if (dependencies.marketStream === undefined) {
      return reply.code(409).send({ error: "Current TEST order book is incomplete" });
    }
    const opportunities = new EventOpportunityService(
      dependencies.candidates,
      dependencies.database,
      dependencies.marketStream,
      dependencies.config,
      dependencies.tradingPreferences,
    );
    const initial = opportunities.evaluateEvent(candidate.eventId, new Date());
    if (
      initial.status !== "READY" ||
      initial.winner?.candidate.tokenId !== candidate.tokenId
    ) {
      return reply.code(409).send({
        error:
          initial.status === "INCOMPLETE"
            ? "Current Event order books are incomplete"
            : "Candidate is not the current Event winner",
      });
    }
    const rechecked = opportunities.evaluateEvent(candidate.eventId, new Date());
    if (
      rechecked.status !== "READY" ||
      rechecked.winner?.candidate.tokenId !== candidate.tokenId
    ) {
      return reply.code(409).send({
        error: "Event arbitration changed before TEST execution",
      });
    }
    const execution = testExecutor.executeBuy(rechecked.winner.intent);
    if (execution.order === null) {
      return reply.code(409).send({
        error: `TEST FAK buy was not executed: ${execution.outcome}`,
      });
    }
    dependencies.marketStream?.consumeTestBuyLiquidity?.(
      candidate.tokenId,
      execution.consumedAsks,
    );
    dependencies.marketStream?.executeTargetSells?.(candidate.tokenId);
    dependencies.marketStream?.refreshSubscriptions();
    return reply.code(201).send({
      outcome: execution.outcome,
      order: serializeOrder(
        dependencies.database.getPaperOrder(execution.order.id),
      ),
      spent: microsToDecimalString(execution.spentMicros),
      fee: microsToDecimalString(execution.feeMicros),
    });
  });

  app.post("/api/test/reset", async (request) => {
    z.object({
      confirmation: z.literal("RESET TEST"),
      finalConfirmation: z.literal("RESET TEST AGAIN"),
    }).parse(request.body);
    dependencies.tradingPreferences.resetTestState();
    dependencies.marketStream?.refreshSubscriptions();
    void dependencies.candidates.refresh();
    return {
      strategy: serializeState(dependencies.database.getStrategyState()),
      preferences: serializePreferences(
        dependencies.tradingPreferences.getSnapshot(),
      ),
    };
  });

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error instanceof z.ZodError ? 400 : 409;
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(statusCode).send({ error: message });
  });

  const webFiles = new Map([
    ["/", { name: "index.html", type: "text/html; charset=utf-8" }],
    ["/app.js", { name: "app.js", type: "text/javascript; charset=utf-8" }],
    ["/styles.css", { name: "styles.css", type: "text/css; charset=utf-8" }],
  ]);

  for (const [route, file] of webFiles) {
    app.get(route, async (_request, reply) => {
      const path = fileURLToPath(new URL(`./web/${file.name}`, import.meta.url));
      const content = await readFile(path);
      return reply.type(file.type).send(content);
    });
  }

  return app;
}

function unitsToMicros(value: number): number {
  const micros = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(micros) || micros <= 0) {
    throw new Error("TEST amount is outside the supported range");
  }
  return micros;
}

function centsToMicros(value: number, allowZero = false): number {
  const micros = Math.round(value * 10_000);
  if (
    !Number.isSafeInteger(micros) ||
    (allowZero ? micros < 0 : micros <= 0)
  ) {
    throw new Error("TEST price is outside the supported range");
  }
  return micros;
}

function multiplierToMicros(value: number): number {
  const micros = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new Error("Target multiplier is outside the supported range");
  }
  return micros;
}
