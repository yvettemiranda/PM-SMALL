import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import {
  calculateOrderCostMicros,
  microsToDecimalString,
} from "./domain/price.js";
import type { PaperOrder, TradeCandidate } from "./domain/types.js";
import type {
  PaperDatabase,
  PaperPositionView,
  PaperSettlement,
  StrategyState,
} from "./infrastructure/db/database.js";
import type { LiveExecutorDisabled } from "./infrastructure/execution/live-executor-disabled.js";
import type { CandidateService, CandidateSnapshot } from "./services/candidate-service.js";
import type { PaperMarketRuntime } from "./services/market-stream-service.js";
import type { PaperAutomationRuntime } from "./services/paper-automation-service.js";
import type { PaperSettlementRuntime } from "./services/paper-settlement-service.js";
import {
  MARKET_DURATION_DAY_OPTIONS,
  type PaperTradingPreferencesService,
  type PaperTradingPreferencesSnapshot,
} from "./services/paper-trading-preferences-service.js";
import type { PaperValidationRuntime } from "./services/paper-validation-service.js";

export type AppDependencies = {
  config: AppConfig;
  database: PaperDatabase;
  candidates: CandidateService;
  tradingPreferences: PaperTradingPreferencesService;
  liveExecutor: LiveExecutorDisabled;
  marketStream?: PaperMarketRuntime;
  paperAutomation?: PaperAutomationRuntime;
  paperSettlement?: PaperSettlementRuntime;
  paperValidation?: PaperValidationRuntime;
};

function publicConfig(
  config: AppConfig,
  preferences: PaperTradingPreferencesSnapshot,
) {
  return {
    initialCapital: microsToDecimalString(config.initialCapitalMicros),
    totalBudget: microsToDecimalString(config.totalBudgetMicros),
    orderBudget: microsToDecimalString(config.orderBudgetMicros),
    resultCounts: preferences.resultCounts,
    maxMarketDurationDays: preferences.maxMarketDurationDays,
    maxMarketProgressPercent: config.maxMarketProgressPercent,
    stopBuyProgressPercent: config.stopBuyProgressPercent,
    minBuyPrice: microsToDecimalString(config.minBuyPriceMicros),
    maxBuyPrice: microsToDecimalString(preferences.maxBuyPriceMicros),
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

function serializeCandidate(candidate: TradeCandidate, selected: boolean) {
  return {
    ...candidate,
    selected,
    marketUrl: polymarketEventUrl(candidate.eventSlug, candidate.eventId),
    bestBid: microsToDecimalString(candidate.bestBidMicros),
    bestAsk:
      candidate.bestAskMicros === null
        ? null
        : microsToDecimalString(candidate.bestAskMicros),
    makerBuyPrice: microsToDecimalString(candidate.makerBuyPriceMicros),
    fixedSellPrice: microsToDecimalString(candidate.fixedSellPriceMicros),
    orderSize: microsToDecimalString(candidate.orderSizeMicros),
    queueAheadSize: microsToDecimalString(candidate.queueAheadSizeMicros),
    minOrderSize: microsToDecimalString(candidate.minOrderSizeMicros),
    tickSize: microsToDecimalString(candidate.tickSizeMicros),
  };
}

function serializeSnapshot(
  snapshot: CandidateSnapshot,
  preferences: PaperTradingPreferencesService,
  includeCandidates = true,
) {
  const { candidates, ...status } = snapshot;
  const selectedCandidateCount = candidates.filter((candidate) =>
    preferences.isTokenSelected(candidate.tokenId),
  ).length;
  const summary = {
    ...status,
    candidateCount: candidates.length,
    selectedCandidateCount,
  };
  return includeCandidates
    ? {
        ...summary,
        candidates: candidates.map((candidate) =>
          serializeCandidate(
            candidate,
            preferences.isTokenSelected(candidate.tokenId),
          ),
        ),
      }
    : summary;
}

function serializePreferences(preferences: PaperTradingPreferencesSnapshot) {
  return {
    ...preferences,
    maxBuyPrice: microsToDecimalString(preferences.maxBuyPriceMicros),
    maxBuyPriceCents: preferences.maxBuyPriceMicros / 10_000,
    durationOptions: [...MARKET_DURATION_DAY_OPTIONS],
  };
}

function averagePriceMicros(position: PaperPositionView): number | null {
  if (position.quantityMicros <= 0) {
    return null;
  }
  return Number(
    (BigInt(position.costMicros) * 1_000_000n) /
      BigInt(position.quantityMicros),
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
): number | null {
  const streamed = dependencies.marketStream?.getBestBidMicros?.(position.tokenId);
  if (streamed !== undefined && streamed !== null) {
    return streamed;
  }
  return (
    dependencies.candidates
      .getSnapshot()
      .candidates.find((candidate) => candidate.tokenId === position.tokenId)
      ?.bestBidMicros ?? null
  );
}

function serializePositionView(
  position: PaperPositionView,
  dependencies: AppDependencies,
  now: Date,
) {
  const averageBuyPriceMicros = averagePriceMicros(position);
  const currentMarkPriceMicros = markPriceMicros(position, dependencies);
  const valuationPriceMicros = currentMarkPriceMicros ?? averageBuyPriceMicros;
  const marketValueMicros =
    valuationPriceMicros === null
      ? position.costMicros
      : calculateOrderCostMicros(valuationPriceMicros, position.quantityMicros);
  return {
    ...position,
    marketUrl: polymarketEventUrl(position.eventSlug, position.eventId),
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
    unrealizedPnl: microsToDecimalString(
      marketValueMicros - position.costMicros,
    ),
    progressPercent: currentMarketProgress(position.openedAt, position.endsAt, now),
  };
}

function serializePortfolio(
  state: StrategyState,
  positions: readonly PaperPositionView[],
  dependencies: AppDependencies,
) {
  let marketValueMicros = 0;
  for (const position of positions) {
    const averageBuyPriceMicros = averagePriceMicros(position);
    const valuationPriceMicros =
      markPriceMicros(position, dependencies) ?? averageBuyPriceMicros;
    marketValueMicros +=
      valuationPriceMicros === null
        ? position.costMicros
        : calculateOrderCostMicros(valuationPriceMicros, position.quantityMicros);
  }
  const unrealizedPnlMicros = marketValueMicros - state.positionCostMicros;
  const totalPnlMicros = state.realizedPnlMicros + unrealizedPnlMicros;
  const totalFundsMicros =
    state.availableCashMicros + state.reservedCashMicros + marketValueMicros;
  return {
    totalFunds: microsToDecimalString(totalFundsMicros),
    totalPnl: microsToDecimalString(totalPnlMicros),
    realizedPnl: microsToDecimalString(state.realizedPnlMicros),
    unrealizedPnl: microsToDecimalString(unrealizedPnlMicros),
  };
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/api/health", async () => ({ status: "ok", mode: "PAPER" }));

  app.get("/api/status", async (request) => {
    const query = z
      .object({ compact: z.enum(["true", "false"]).optional() })
      .parse(request.query);
    const strategy = dependencies.database.getStrategyState();
    const positions = dependencies.database.listPaperPositionViews();
    const preferences = dependencies.tradingPreferences.getSnapshot();
    return {
      version: "0.4.0",
      executionMode: "PAPER",
      liveExecutionEnabled: dependencies.liveExecutor.enabled,
      strategy: serializeState(strategy),
      portfolio: serializePortfolio(strategy, positions, dependencies),
      configuration: publicConfig(dependencies.config, preferences),
      runtime: runtimeStatus(),
      marketScan: serializeSnapshot(
        dependencies.candidates.getSnapshot(),
        dependencies.tradingPreferences,
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
        cancelledStartedBuyCount: 0,
        cancelledProgressedBuyCount: 0,
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

  app.get("/api/paper/validation", async (_request, reply) => {
    // Keep GET side-effect free. The periodic service owns pause and audit.
    const validation = dependencies.database.validatePaperState();
    return reply.code(validation.passed ? 200 : 503).send({ validation });
  });

  app.post("/api/paper/start", async () => {
    const strategy = dependencies.database.setStrategyStatus("RUNNING");
    dependencies.paperAutomation?.requestRun();
    dependencies.paperSettlement?.requestRun();
    dependencies.marketStream?.refreshSubscriptions();
    return { strategy: serializeState(strategy) };
  });

  app.post("/api/paper/pause", async () => ({
    strategy: serializeState(dependencies.database.setStrategyStatus("PAUSED")),
  }));

  app.post("/api/paper/stop", async () => ({
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
    return serializeSnapshot(snapshot, dependencies.tradingPreferences);
  });

  app.get("/api/paper/preferences", async () => ({
    preferences: serializePreferences(dependencies.tradingPreferences.getSnapshot()),
  }));

  app.put("/api/paper/preferences", async (request) => {
    const body = z
      .object({
        resultCounts: z.array(z.union([z.literal(2), z.literal(3)])),
        maxBuyPriceCents: z.number().int().min(1).max(99),
        maxMarketDurationDays: z
          .number()
          .int()
          .refine((value) => MARKET_DURATION_DAY_OPTIONS.includes(value as never)),
      })
      .parse(request.body);
    const preferences = dependencies.tradingPreferences.updateMarketFilters({
      resultCounts: body.resultCounts,
      maxBuyPriceMicros: body.maxBuyPriceCents * 10_000,
      maxMarketDurationDays: body.maxMarketDurationDays,
    });
    const scanWasRunning = dependencies.candidates.getSnapshot().scanning;
    void dependencies.candidates.refresh().then(() => {
      if (scanWasRunning) void dependencies.candidates.refresh();
    });
    return { preferences: serializePreferences(preferences) };
  });

  app.put("/api/paper/candidate-selection", async (request) => {
    const body = z
      .discriminatedUnion("action", [
        z.object({ action: z.literal("all") }),
        z.object({ action: z.literal("none") }),
        z.object({
          action: z.literal("set"),
          tokenId: z.string().min(1),
          selected: z.boolean(),
        }),
      ])
      .parse(request.body);
    if (body.action === "all") {
      dependencies.tradingPreferences.setAllCandidatesSelected(true);
    } else if (body.action === "none") {
      dependencies.tradingPreferences.setAllCandidatesSelected(false);
    } else {
      dependencies.tradingPreferences.setCandidateSelected(
        body.tokenId,
        body.selected,
      );
    }
    dependencies.paperAutomation?.requestRun();
    dependencies.marketStream?.refreshSubscriptions();
    const candidates = dependencies.candidates.getSnapshot().candidates;
    return {
      selectedCandidateCount: candidates.filter((candidate) =>
        dependencies.tradingPreferences.isTokenSelected(candidate.tokenId),
      ).length,
      candidateCount: candidates.length,
    };
  });

  app.get("/api/paper/orders", async () => ({
    orders: dependencies.database.listPaperOrders().map(serializeOrder),
  }));

  app.get("/api/paper/positions", async () => ({
    positions: dependencies.database
      .listPaperPositionViews()
      .map((position) => serializePositionView(position, dependencies, new Date())),
  }));

  app.get("/api/paper/settlements", async () => ({
    settlements: dependencies.database
      .listPaperSettlements()
      .map(serializeSettlement),
  }));

  app.post("/api/paper/orders/buy", async (request, reply) => {
    const body = z.object({ candidateId: z.string().min(1) }).parse(request.body);
    const candidate = dependencies.candidates.getCandidate(body.candidateId);
    if (candidate === null) {
      return reply.code(404).send({ error: "Candidate is unavailable or stale" });
    }

    const order = dependencies.database.placePaperBuy(
      candidate,
      dependencies.config.totalBudgetMicros,
    );
    dependencies.marketStream?.refreshSubscriptions();
    return reply.code(201).send({ order: serializeOrder(order) });
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
