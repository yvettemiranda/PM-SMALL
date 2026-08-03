import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { MarketScanner } from "./domain/market-scanner.js";
import { PaperDatabase } from "./infrastructure/db/database.js";
import { LiveExecutorDisabled } from "./infrastructure/execution/live-executor-disabled.js";
import { PolymarketMarketDataSource } from "./infrastructure/polymarket/market-data.js";
import { CandidateService } from "./services/candidate-service.js";

const config = loadConfig();
const database = new PaperDatabase(
  config.databasePath,
  config.initialCapitalMicros,
);
const marketData = new PolymarketMarketDataSource();
const scanner = new MarketScanner(marketData, config);
const candidates = new CandidateService(scanner, config.scanIntervalMs);
const liveExecutor = new LiveExecutorDisabled();
const app = buildApp({ config, database, candidates, liveExecutor });

candidates.start();

const shutdown = async () => {
  candidates.stop();
  await app.close();
  database.close();
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: config.host, port: config.port });
