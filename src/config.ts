import { z } from "zod";

const numberFromEnvironment = (fallback: number) =>
  z.coerce.number().finite().positive().default(fallback);

const configSchema = z.object({
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_PATH: z.string().min(1).default("./data/paper.db"),
  INITIAL_CAPITAL_USD: numberFromEnvironment(100),
  TOTAL_BUDGET_USD: numberFromEnvironment(100),
  ORDER_BUDGET_USD: numberFromEnvironment(1),
  MAX_MARKET_DURATION_DAYS: numberFromEnvironment(30),
  MAX_MARKET_PROGRESS_PERCENT: z.coerce.number().min(0).max(100).default(20),
  STOP_BUY_PROGRESS_PERCENT: z.coerce.number().min(0).max(100).default(90),
  MIN_BUY_PRICE: z.coerce.number().min(0.0001).max(0.99).default(0.01),
  MAX_BUY_PRICE: z.coerce.number().min(0.0001).max(0.99).default(0.03),
  SCAN_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
  MARKET_STREAM_RECONNECT_MS: z.coerce.number().int().min(250).default(2_000),
  PAPER_SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(250).default(1_000),
  PAPER_SETTLEMENT_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
  PAPER_VALIDATION_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
  SCAN_EVENT_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(100),
});

export type AppConfig = {
  host: string;
  port: number;
  databasePath: string;
  initialCapitalMicros: number;
  totalBudgetMicros: number;
  orderBudgetMicros: number;
  maxMarketDurationDays: number;
  maxMarketProgressPercent: number;
  stopBuyProgressPercent: number;
  minBuyPriceMicros: number;
  maxBuyPriceMicros: number;
  scanIntervalMs: number;
  marketStreamReconnectMs: number;
  paperSchedulerIntervalMs: number;
  paperSettlementIntervalMs: number;
  paperValidationIntervalMs: number;
  scanEventPageSize: number;
};

const USD_SCALE = 1_000_000;

function toMicros(value: number): number {
  return Math.round(value * USD_SCALE);
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse(environment);

  if (parsed.ORDER_BUDGET_USD > parsed.TOTAL_BUDGET_USD) {
    throw new Error("ORDER_BUDGET_USD cannot exceed TOTAL_BUDGET_USD");
  }

  if (parsed.TOTAL_BUDGET_USD > parsed.INITIAL_CAPITAL_USD) {
    throw new Error("TOTAL_BUDGET_USD cannot exceed INITIAL_CAPITAL_USD");
  }

  if (parsed.MIN_BUY_PRICE > parsed.MAX_BUY_PRICE) {
    throw new Error("MIN_BUY_PRICE cannot exceed MAX_BUY_PRICE");
  }

  if (parsed.MAX_MARKET_PROGRESS_PERCENT >= parsed.STOP_BUY_PROGRESS_PERCENT) {
    throw new Error(
      "MAX_MARKET_PROGRESS_PERCENT must be below STOP_BUY_PROGRESS_PERCENT",
    );
  }

  return {
    host: parsed.HOST,
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH,
    initialCapitalMicros: toMicros(parsed.INITIAL_CAPITAL_USD),
    totalBudgetMicros: toMicros(parsed.TOTAL_BUDGET_USD),
    orderBudgetMicros: toMicros(parsed.ORDER_BUDGET_USD),
    maxMarketDurationDays: parsed.MAX_MARKET_DURATION_DAYS,
    maxMarketProgressPercent: parsed.MAX_MARKET_PROGRESS_PERCENT,
    stopBuyProgressPercent: parsed.STOP_BUY_PROGRESS_PERCENT,
    minBuyPriceMicros: toMicros(parsed.MIN_BUY_PRICE),
    maxBuyPriceMicros: toMicros(parsed.MAX_BUY_PRICE),
    scanIntervalMs: parsed.SCAN_INTERVAL_MS,
    marketStreamReconnectMs: parsed.MARKET_STREAM_RECONNECT_MS,
    paperSchedulerIntervalMs: parsed.PAPER_SCHEDULER_INTERVAL_MS,
    paperSettlementIntervalMs: parsed.PAPER_SETTLEMENT_INTERVAL_MS,
    paperValidationIntervalMs: parsed.PAPER_VALIDATION_INTERVAL_MS,
    scanEventPageSize: parsed.SCAN_EVENT_PAGE_SIZE,
  };
}
