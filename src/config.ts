import { z } from "zod";

const numberFromEnvironment = (fallback: number) =>
  z.coerce.number().finite().positive().default(fallback);

const durationDaysFromEnvironment = (fallback: number) =>
  z.coerce.number().int().min(1).max(365).default(fallback);

const buyPriceFromEnvironment = (fallback: number, label: string) =>
  z.coerce
    .number()
    .finite()
    .refine(
      (value) =>
        Number.isInteger(value * 1_000) && value >= 0.001 && value <= 0.99,
      `${label} must be a tenth-cent price from 0.001 to 0.99`,
    )
    .default(fallback);

const booleanFromEnvironment = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .default(fallback ? "true" : "false")
    .transform((value) => value === "true");

const configSchema = z.object({
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_PATH: z.string().min(1).default("./data/paper.db"),
  INITIAL_CAPITAL_USD: numberFromEnvironment(100),
  TOTAL_BUDGET_USD: numberFromEnvironment(100),
  ORDER_BUDGET_USD: numberFromEnvironment(1),
  MIN_MARKET_DURATION_DAYS: durationDaysFromEnvironment(1),
  MAX_MARKET_DURATION_DAYS: durationDaysFromEnvironment(30),
  MIN_BUY_PRICE: buyPriceFromEnvironment(0.001, "MIN_BUY_PRICE"),
  MAX_BUY_PRICE: buyPriceFromEnvironment(0.99, "MAX_BUY_PRICE"),
  TARGET_SELL_PRICE_INCREASE: z.coerce
    .number()
    .finite()
    .min(0)
    .max(0.99)
    .default(0.01),
  TARGET_SELL_PRICE_MULTIPLIER: z.coerce
    .number()
    .finite()
    .min(0)
    .refine(
      (value) => Number.isSafeInteger(Math.round(value * USD_SCALE)),
      "TARGET_SELL_PRICE_MULTIPLIER exceeds the supported precision",
    )
    .default(1.5),
  STOP_LOSS_ENABLED: booleanFromEnvironment(true),
  STOP_LOSS_MULTIPLIER: z.coerce
    .number()
    .finite()
    .gt(0)
    .lt(1)
    .refine(
      (value) => Number.isSafeInteger(Math.round(value * USD_SCALE)),
      "STOP_LOSS_MULTIPLIER exceeds the supported precision",
    )
    .default(0.4),
  MIN_BID_ASK_RATIO_PERCENT: z.coerce.number().int().min(1).max(100).default(50),
  MAX_MARKET_PROGRESS_PERCENT: z.coerce.number().int().min(1).max(100).default(20),
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
  minMarketDurationDays: number;
  maxMarketDurationDays: number;
  minBuyPriceMicros: number;
  maxBuyPriceMicros: number;
  targetSellPriceIncreaseMicros: number;
  targetSellPriceMultiplierMicros: number;
  stopLossEnabled: boolean;
  stopLossMultiplierMicros: number;
  minBidAskRatioPercent: number;
  maxMarketProgressPercent: number;
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

  if (parsed.MIN_MARKET_DURATION_DAYS > parsed.MAX_MARKET_DURATION_DAYS) {
    throw new Error(
      "MIN_MARKET_DURATION_DAYS cannot exceed MAX_MARKET_DURATION_DAYS",
    );
  }

  if (parsed.MIN_BUY_PRICE > parsed.MAX_BUY_PRICE) {
    throw new Error("MIN_BUY_PRICE cannot exceed MAX_BUY_PRICE");
  }

  return {
    host: parsed.HOST,
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH,
    initialCapitalMicros: toMicros(parsed.INITIAL_CAPITAL_USD),
    totalBudgetMicros: toMicros(parsed.TOTAL_BUDGET_USD),
    orderBudgetMicros: toMicros(parsed.ORDER_BUDGET_USD),
    minMarketDurationDays: parsed.MIN_MARKET_DURATION_DAYS,
    maxMarketDurationDays: parsed.MAX_MARKET_DURATION_DAYS,
    minBuyPriceMicros: toMicros(parsed.MIN_BUY_PRICE),
    maxBuyPriceMicros: toMicros(parsed.MAX_BUY_PRICE),
    targetSellPriceIncreaseMicros: toMicros(
      parsed.TARGET_SELL_PRICE_INCREASE,
    ),
    targetSellPriceMultiplierMicros: toMicros(
      parsed.TARGET_SELL_PRICE_MULTIPLIER,
    ),
    stopLossEnabled: parsed.STOP_LOSS_ENABLED,
    stopLossMultiplierMicros: toMicros(parsed.STOP_LOSS_MULTIPLIER),
    minBidAskRatioPercent: parsed.MIN_BID_ASK_RATIO_PERCENT,
    maxMarketProgressPercent: parsed.MAX_MARKET_PROGRESS_PERCENT,
    scanIntervalMs: parsed.SCAN_INTERVAL_MS,
    marketStreamReconnectMs: parsed.MARKET_STREAM_RECONNECT_MS,
    paperSchedulerIntervalMs: parsed.PAPER_SCHEDULER_INTERVAL_MS,
    paperSettlementIntervalMs: parsed.PAPER_SETTLEMENT_INTERVAL_MS,
    paperValidationIntervalMs: parsed.PAPER_VALIDATION_INTERVAL_MS,
    scanEventPageSize: parsed.SCAN_EVENT_PAGE_SIZE,
  };
}
