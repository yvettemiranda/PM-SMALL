import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { microsToDecimalString } from "./domain/price.js";
import type { PaperOrder, TradeCandidate } from "./domain/types.js";
import type { PaperDatabase, StrategyState } from "./infrastructure/db/database.js";
import type { LiveExecutorDisabled } from "./infrastructure/execution/live-executor-disabled.js";
import type { CandidateService, CandidateSnapshot } from "./services/candidate-service.js";

export type AppDependencies = {
  config: AppConfig;
  database: PaperDatabase;
  candidates: CandidateService;
  liveExecutor: LiveExecutorDisabled;
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
    originalSize: microsToDecimalString(order.originalSizeMicros),
    filledSize: microsToDecimalString(order.filledSizeMicros),
    queueAheadSize: microsToDecimalString(order.queueAheadSizeMicros),
    observedTradeSize: microsToDecimalString(order.observedTradeSizeMicros),
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

function serializeSnapshot(snapshot: CandidateSnapshot) {
  return {
    ...snapshot,
    candidates: snapshot.candidates.map(serializeCandidate),
  };
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/api/health", async () => ({ status: "ok", mode: "PAPER" }));

  app.get("/api/status", async () => ({
    version: "0.1.0",
    executionMode: "PAPER",
    liveExecutionEnabled: dependencies.liveExecutor.enabled,
    strategy: serializeState(dependencies.database.getStrategyState()),
    configuration: publicConfig(dependencies.config),
    marketScan: serializeSnapshot(dependencies.candidates.getSnapshot()),
  }));

  app.post("/api/paper/start", async () => ({
    strategy: serializeState(dependencies.database.setStrategyStatus("RUNNING")),
  }));

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
