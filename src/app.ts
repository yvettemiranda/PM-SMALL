import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { microsToDecimalString } from "./domain/price.js";
import type { PaperOrder, TradeCandidate } from "./domain/types.js";
import type {
  PaperDatabase,
  PaperPosition,
  PaperSettlement,
  StrategyState,
} from "./infrastructure/db/database.js";
import type { LiveExecutorDisabled } from "./infrastructure/execution/live-executor-disabled.js";
import type { CandidateService, CandidateSnapshot } from "./services/candidate-service.js";
import type { PaperMarketRuntime } from "./services/market-stream-service.js";
import type { PaperAutomationRuntime } from "./services/paper-automation-service.js";
import type { PaperSettlementRuntime } from "./services/paper-settlement-service.js";
import type { PaperValidationRuntime } from "./services/paper-validation-service.js";

export type AppDependencies = {
  config: AppConfig;
  database: PaperDatabase;
  candidates: CandidateService;
  liveExecutor: LiveExecutorDisabled;
  marketStream?: PaperMarketRuntime;
  paperAutomation?: PaperAutomationRuntime;
  paperSettlement?: PaperSettlementRuntime;
  paperValidation?: PaperValidationRuntime;
};

function publicConfig(config: AppConfig) {
  return {
    initialCapital: microsToDecimalString(config.initialCapitalMicros),
    totalBudget: microsToDecimalString(config.totalBudgetMicros),
    orderBudget: microsToDecimalString(config.orderBudgetMicros),
    maxMarketDurationDays: config.maxMarketDurationDays,
    maxMarketProgressPercent: config.maxMarketProgressPercent,
    stopBuyProgressPercent: config.stopBuyProgressPercent,
    minBuyPrice: microsToDecimalString(config.minBuyPriceMicros),
    maxBuyPrice: microsToDecimalString(config.maxBuyPriceMicros),
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

function serializePosition(position: PaperPosition) {
  return {
    ...position,
    quantity: microsToDecimalString(position.quantityMicros),
    cost: microsToDecimalString(position.costMicros),
    realizedPnl: microsToDecimalString(position.realizedPnlMicros),
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

function serializeCandidate(candidate: TradeCandidate) {
  return {
    ...candidate,
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
  includeCandidates = true,
) {
  const { candidates, ...status } = snapshot;
  const summary = { ...status, candidateCount: candidates.length };
  return includeCandidates
    ? { ...summary, candidates: candidates.map(serializeCandidate) }
    : summary;
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/api/health", async () => ({ status: "ok", mode: "PAPER" }));

  app.get("/api/status", async (request) => {
    const query = z
      .object({ compact: z.enum(["true", "false"]).optional() })
      .parse(request.query);
    return {
      version: "0.4.0",
      executionMode: "PAPER",
      liveExecutionEnabled: dependencies.liveExecutor.enabled,
      strategy: serializeState(dependencies.database.getStrategyState()),
      configuration: publicConfig(dependencies.config),
      runtime: runtimeStatus(),
      marketScan: serializeSnapshot(
        dependencies.candidates.getSnapshot(),
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
    return serializeSnapshot(snapshot);
  });

  app.get("/api/paper/orders", async () => ({
    orders: dependencies.database.listPaperOrders().map(serializeOrder),
  }));

  app.get("/api/paper/positions", async () => ({
    positions: dependencies.database.listPaperPositions().map(serializePosition),
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
