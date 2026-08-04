import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { MarketScanner } from "./domain/market-scanner.js";
import { PaperDatabase } from "./infrastructure/db/database.js";
import { LiveExecutorDisabled } from "./infrastructure/execution/live-executor-disabled.js";
import { PolymarketMarketDataSource } from "./infrastructure/polymarket/market-data.js";
import { PolymarketMarketStreamSource } from "./infrastructure/polymarket/market-stream.js";
import { CandidateService } from "./services/candidate-service.js";
import { MarketStreamService } from "./services/market-stream-service.js";
import { PaperMarketProcessor } from "./services/paper-market-processor.js";
import { PaperAutomationService } from "./services/paper-automation-service.js";
import { PaperSettlementService } from "./services/paper-settlement-service.js";
import { PaperValidationService } from "./services/paper-validation-service.js";
import { runShutdownWithDeadline } from "./services/process-shutdown.js";

const SHUTDOWN_TIMEOUT_MS = 5_000;

const config = loadConfig();
const database = new PaperDatabase(
  config.databasePath,
  config.initialCapitalMicros,
);
const marketData = new PolymarketMarketDataSource();
const scanner = new MarketScanner(marketData, config);
const candidates = new CandidateService(scanner, config.scanIntervalMs);
const paperMarketProcessor = new PaperMarketProcessor(database);
const marketStream = new MarketStreamService(
  new PolymarketMarketStreamSource(),
  candidates,
  database,
  paperMarketProcessor,
  config.marketStreamReconnectMs,
);
const liveExecutor = new LiveExecutorDisabled();
const paperAutomation = new PaperAutomationService(
  candidates,
  database,
  marketStream,
  config,
);
const paperSettlement = new PaperSettlementService(
  marketData,
  database,
  config.paperSettlementIntervalMs,
  () => marketStream.refreshSubscriptions(),
);
const paperValidation = new PaperValidationService(
  database,
  config.paperValidationIntervalMs,
);
const app = buildApp({
  config,
  database,
  candidates,
  liveExecutor,
  marketStream,
  paperAutomation,
  paperSettlement,
  paperValidation,
});

candidates.start();
marketStream.start();
paperAutomation.start();
paperSettlement.start();
paperValidation.start();

const shutdown = async (): Promise<void> => {
  candidates.stop();
  const failures: string[] = [];
  const attempt = async (
    operation: string,
    action: () => void | Promise<void>,
  ): Promise<void> => {
    try {
      await action();
    } catch (error) {
      failures.push(
        `${operation}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  await attempt("paper validation stop", () => paperValidation.stop());
  await attempt("paper settlement stop", () => paperSettlement.stop());
  await attempt("paper automation stop", () => paperAutomation.stop());
  await attempt("market stream stop", () => marketStream.stop());
  await attempt("HTTP server close", () => app.close());
  await attempt("database close", () => database.close());

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
};

let shutdownRequested = false;
const requestShutdown = (signal: "SIGINT" | "SIGTERM"): void => {
  if (shutdownRequested) {
    return;
  }
  shutdownRequested = true;
  void runShutdownWithDeadline(shutdown, SHUTDOWN_TIMEOUT_MS).then(
    ({ exitCode, error }) => {
      if (error !== null) {
        app.log.error({ error, signal }, "Server shutdown failed");
      }
      process.exit(exitCode);
    },
  );
};

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
