import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { calculateConservativePaperFill } from "../../domain/paper-fill-model.js";
import type {
  ConsumedBookLevel,
  ImmediateBuyExecution,
  ImmediateBuyIntent,
  ImmediateBuyOutcome,
  TargetSellExecution,
} from "../../domain/execution.js";
import {
  PaperResolutionValidationError,
  type PaperSettlementPayout,
} from "../../domain/paper-settlement.js";
import {
  bestAskLevel,
  bestBidLevel,
  calculateFixedSellPriceMicros,
  calculateOrderCostMicros,
  calculateOrderSizeMicros,
} from "../../domain/price.js";
import { isMarketEligible } from "../../domain/market-eligibility.js";
import type { MarketEligibilitySettings } from "../../domain/market-eligibility.js";
import type { MarketType } from "../../domain/market-type.js";
import {
  planFakSellTargets,
  previewFakBuy,
  type FakBuyPreview,
} from "../../domain/trading-strategy.js";
import type {
  BookLevel,
  PaperOrder,
  PaperOrderStatus,
  TokenOrderBook,
  TradeCandidate,
} from "../../domain/types.js";

type StrategyStatus = "STOPPED" | "RUNNING" | "PAUSED";

export type StrategyState = {
  mode: "PAPER";
  status: StrategyStatus;
  initialCapitalMicros: number;
  availableCashMicros: number;
  reservedCashMicros: number;
  realizedPnlMicros: number;
  positionCostMicros: number;
  updatedAt: string;
};

export type TestResetResult = {
  strategy: StrategyState;
  preferences: PaperTradingPreferences;
};

export type AppliedPaperTrade = {
  order: PaperOrder;
  createdSellOrder: PaperOrder | null;
  duplicate: boolean;
  incrementalFillSizeMicros: number;
};

export type PaperRecoveryResult = {
  passed: boolean;
  errors: string[];
  activeOrderCount: number;
  cancelledBuyCount: number;
  recoveredAt: string;
};

export type PaperValidationResult = {
  passed: boolean;
  errors: string[];
  sqliteIntegrity: string;
  activeOrderCount: number;
  openPositionCount: number;
  pendingSettlementCount: number;
  checkedAt: string;
};

export type PaperSettlementStatus = "PENDING" | "SETTLED";
export type PaperRedemptionStatus = "PENDING" | "SIMULATED" | "NOT_APPLICABLE";
export type PaperSettlementOutcome = "WIN" | "LOSS" | "MIXED" | "NO_POSITION";

export type PaperSettlementTarget = {
  conditionId: string;
  marketId: string;
  eventId: string;
};

export type PaperSettlement = PaperSettlementTarget & {
  status: PaperSettlementStatus;
  resolutionStatus: string | null;
  winningTokenId: string | null;
  winningOutcome: string | null;
  redemptionStatus: PaperRedemptionStatus;
  outcome: PaperSettlementOutcome | null;
  positionCostMicros: number;
  payoutMicros: number;
  realizedPnlMicros: number;
  attemptCount: number;
  lastError: string | null;
  settledAt: string | null;
  redeemedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AppliedPaperSettlement = {
  settlement: PaperSettlement;
  duplicate: boolean;
  positionCount: number;
  cancelledBuyCount: number;
  cancelledSellCount: number;
};

export type PaperPosition = {
  tokenId: string;
  conditionId: string;
  quantityMicros: number;
  costMicros: number;
  realizedPnlMicros: number;
  firstSellAt: string | null;
  cycleClosedAt: string | null;
  cycleSpendMicros: number;
  grossBuySizeMicros: number;
  grossBuyNotionalMicros: number;
  updatedAt: string;
};

export type PaperPositionView = PaperPosition & {
  eventId: string | null;
  eventSlug: string | null;
  eventTitle: string | null;
  marketId: string | null;
  marketQuestion: string | null;
  direction: "YES" | "NO" | null;
  openedAt: string | null;
  endsAt: string | null;
};

export type PaperEventLockState = "ACTIVE" | "LEGACY_CONFLICT";

export type PaperEventLock = {
  eventId: string;
  activeTokenId: string | null;
  marketId: string | null;
  conditionId: string | null;
  cycleBudgetMicros: number;
  state: PaperEventLockState;
  lockedAt: string;
  updatedAt: string;
};

export type TestFakBuyPreviewResult = {
  outcome: "READY" | "NO_FILL" | "BLOCKED";
  preview: FakBuyPreview | null;
  eventLock: PaperEventLock | null;
  eventStateVersion: string;
};

export type PaperTradingPreferences = {
  marketTypes: MarketType[];
  allCategories: boolean;
  selectedCategories: string[];
  candidateSortDirection: "ASC" | "DESC";
  orderBudgetMicros: number;
  minBuyPriceMicros: number;
  maxBuyPriceMicros: number;
  targetSellPriceIncreaseMicros: number;
  targetSellPriceMultiplierMicros: number;
  minBidAskRatioPercent: number;
  minMarketDurationDays: number;
  maxMarketDurationDays: number;
  maxMarketProgressPercent: number;
  candidatesSelectedByDefault: boolean;
  updatedAt: string;
};

export type PaperTradingPreferencesUpdate = {
  preferences: PaperTradingPreferences;
  cancelledBuyCount: number;
};

export type ActivePaperBuyMarket = {
  tokenId: string;
  makerBuyPriceMicros: number;
  bestAskMicros: number;
  bestBidMicros: number;
  bookReady: boolean;
  category: string | null;
  categoryIds: string[];
  resultCount: number | null;
  durationDays: number | null;
  openedAt: string | null;
  endsAt: string | null;
  minOrderSizeMicros: number;
  tickSizeMicros: number;
};

export type TestMarketExecutionMetadata = {
  tokenId: string;
  feeRateMicros: number;
  feeExponent: number;
  minOrderSizeMicros: number;
  tickSizeMicros: number;
};

type PaperOrderRow = {
  id: string;
  token_id: string;
  condition_id: string;
  event_id: string;
  market_id: string;
  game_starts_at: string | null;
  market_opened_at: string | null;
  market_ends_at: string | null;
  side: "BUY" | "SELL";
  price_micros: number;
  target_sell_price_micros: number | null;
  linked_buy_order_id: string | null;
  original_size_micros: number;
  filled_size_micros: number;
  queue_ahead_size_micros: number;
  queue_baseline_filled_size_micros: number;
  observed_trade_size_micros: number;
  status: PaperOrderStatus;
  execution_kind: "LEGACY_MAKER" | "FAK" | "TARGET";
  cash_limit_micros: number;
  fee_micros: number;
  created_at: string;
  updated_at: string;
};

type PaperSettlementRow = {
  condition_id: string;
  market_id: string;
  event_id: string;
  status: PaperSettlementStatus;
  resolution_status: string | null;
  winning_token_id: string | null;
  winning_outcome: string | null;
  redemption_status: PaperRedemptionStatus;
  outcome: PaperSettlementOutcome | null;
  position_cost_micros: number;
  payout_micros: number;
  realized_pnl_micros: number;
  attempt_count: number;
  last_error: string | null;
  settled_at: string | null;
  redeemed_at: string | null;
  created_at: string;
  updated_at: string;
};

type PaperPositionRow = {
  token_id: string;
  condition_id: string;
  quantity_micros: number;
  cost_micros: number;
  realized_pnl_micros: number;
  first_sell_at: string | null;
  cycle_closed_at: string | null;
  cycle_spend_micros: number;
  gross_buy_size_micros: number;
  gross_buy_notional_micros: number;
  updated_at: string;
};

type PaperPositionViewRow = PaperPositionRow & {
  event_id: string | null;
  event_slug: string | null;
  event_title: string | null;
  market_id: string | null;
  market_question: string | null;
  direction: "YES" | "NO" | null;
  opened_at: string | null;
  ends_at: string | null;
};

type PaperEventLockRow = {
  event_id: string;
  active_token_id: string | null;
  market_id: string | null;
  condition_id: string | null;
  cycle_budget_micros: number;
  state: PaperEventLockState;
  locked_at: string;
  updated_at: string;
};

type TestFakBuyPlanningResult = TestFakBuyPreviewResult & {
  availableBids: BookLevel[];
  availableAsks: BookLevel[];
  startingNewCycle: boolean;
  maxSpendMicros: number;
};

const FINAL_RESOLUTION_STATUSES = new Set(["resolved", "settled"]);

function normalizeFinalResolutionStatus(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!FINAL_RESOLUTION_STATUSES.has(normalized)) {
    throw new PaperResolutionValidationError(
      "Paper settlement requires a final resolved or settled status",
    );
  }
  return normalized;
}

function samePaperSettlementPayouts(
  recorded: readonly PaperSettlementPayout[] | null,
  received: readonly PaperSettlementPayout[],
): boolean {
  return (
    recorded !== null &&
    recorded.length === received.length &&
    recorded.every(
      (payout, index) =>
        payout.tokenId === received[index]?.tokenId &&
        payout.priceMicros === received[index]?.priceMicros,
    )
  );
}

function rowToPaperOrder(row: PaperOrderRow): PaperOrder {
  return {
    id: row.id,
    tokenId: row.token_id,
    conditionId: row.condition_id,
    eventId: row.event_id,
    marketId: row.market_id,
    gameStartsAt: row.game_starts_at,
    marketOpenedAt: row.market_opened_at,
    marketEndsAt: row.market_ends_at,
    side: row.side,
    priceMicros: row.price_micros,
    targetSellPriceMicros: row.target_sell_price_micros,
    linkedBuyOrderId: row.linked_buy_order_id,
    originalSizeMicros: row.original_size_micros,
    filledSizeMicros: row.filled_size_micros,
    queueAheadSizeMicros: row.queue_ahead_size_micros,
    queueBaselineFilledSizeMicros: row.queue_baseline_filled_size_micros,
    observedTradeSizeMicros: row.observed_trade_size_micros,
    status: row.status,
    executionKind: row.execution_kind ?? "LEGACY_MAKER",
    cashLimitMicros: row.cash_limit_micros ?? 0,
    feeMicros: row.fee_micros ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPaperSettlement(row: PaperSettlementRow): PaperSettlement {
  return {
    conditionId: row.condition_id,
    marketId: row.market_id,
    eventId: row.event_id,
    status: row.status,
    resolutionStatus: row.resolution_status,
    winningTokenId: row.winning_token_id,
    winningOutcome: row.winning_outcome,
    redemptionStatus: row.redemption_status,
    outcome: row.outcome,
    positionCostMicros: row.position_cost_micros,
    payoutMicros: row.payout_micros,
    realizedPnlMicros: row.realized_pnl_micros,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    settledAt: row.settled_at,
    redeemedAt: row.redeemed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPaperPosition(row: PaperPositionRow): PaperPosition {
  return {
    tokenId: row.token_id,
    conditionId: row.condition_id,
    quantityMicros: row.quantity_micros,
    costMicros: row.cost_micros,
    realizedPnlMicros: row.realized_pnl_micros,
    firstSellAt: row.first_sell_at,
    cycleClosedAt: row.cycle_closed_at,
    cycleSpendMicros: row.cycle_spend_micros ?? row.cost_micros,
    grossBuySizeMicros: row.gross_buy_size_micros ?? row.quantity_micros,
    grossBuyNotionalMicros:
      row.gross_buy_notional_micros ?? row.cost_micros,
    updatedAt: row.updated_at,
  };
}

function rowToPaperPositionView(row: PaperPositionViewRow): PaperPositionView {
  return {
    ...rowToPaperPosition(row),
    eventId: row.event_id,
    eventSlug: row.event_slug,
    eventTitle: row.event_title,
    marketId: row.market_id,
    marketQuestion: row.market_question,
    direction: row.direction,
    openedAt: row.opened_at,
    endsAt: row.ends_at,
  };
}

function rowToPaperEventLock(row: PaperEventLockRow): PaperEventLock {
  return {
    eventId: row.event_id,
    activeTokenId: row.active_token_id,
    marketId: row.market_id,
    conditionId: row.condition_id,
    cycleBudgetMicros: row.cycle_budget_micros,
    state: row.state,
    lockedAt: row.locked_at,
    updatedAt: row.updated_at,
  };
}

function rowToPaperTradingPreferences(row: {
  binary_enabled: number;
  ternary_enabled: number;
  multi_enabled: number;
  min_buy_price_micros: number;
  max_buy_price_micros: number;
  target_sell_price_increase_micros: number;
  target_sell_price_multiplier_micros: number;
  min_bid_ask_ratio_percent: number;
  min_market_duration_days: number;
  max_market_duration_days: number;
  max_market_progress_percent: number;
  candidates_selected_by_default: number;
  all_categories_enabled: number;
  selected_categories_json: string;
  candidate_sort_direction: "ASC" | "DESC";
  order_budget_micros: number;
  updated_at: string;
}): PaperTradingPreferences {
  const marketTypes: MarketType[] = [];
  if (row.binary_enabled === 1) marketTypes.push("BINARY");
  if (row.ternary_enabled === 1) marketTypes.push("TERNARY");
  if (row.multi_enabled === 1) marketTypes.push("MULTI");
  return {
    marketTypes,
    allCategories: row.all_categories_enabled === 1,
    selectedCategories: parseCategoryJson(row.selected_categories_json),
    candidateSortDirection: row.candidate_sort_direction,
    orderBudgetMicros: row.order_budget_micros,
    minBuyPriceMicros: row.min_buy_price_micros,
    maxBuyPriceMicros: row.max_buy_price_micros,
    targetSellPriceIncreaseMicros: row.target_sell_price_increase_micros,
    targetSellPriceMultiplierMicros: row.target_sell_price_multiplier_micros,
    minBidAskRatioPercent: row.min_bid_ask_ratio_percent,
    minMarketDurationDays: row.min_market_duration_days,
    maxMarketDurationDays: row.max_market_duration_days,
    maxMarketProgressPercent: row.max_market_progress_percent,
    candidatesSelectedByDefault: row.candidates_selected_by_default === 1,
    updatedAt: row.updated_at,
  };
}

function parseCategoryJson(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (category): category is string =>
            typeof category === "string" && category.trim().length > 0,
        )
      : [];
  } catch {
    return [];
  }
}

export class PaperDatabase {
  private readonly database: Database.Database;
  private paperValidationBlocked = false;

  public constructor(
    databasePath: string,
    initialCapitalMicros: number,
  ) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.database = new Database(databasePath);
    this.database.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;",
    );
    this.applyMigrations();
    this.ensureStrategyState(initialCapitalMicros);
  }

  private applyMigrations(): void {
    this.database.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );`,
    );
    const migrations = [
      { version: 1, file: "001_initial.sql" },
      { version: 2, file: "002_queue_rebase.sql" },
      { version: 3, file: "003_game_start.sql" },
      { version: 4, file: "004_paper_settlement.sql" },
      { version: 5, file: "005_paper_trading_preferences.sql" },
      { version: 6, file: "006_paper_market_metadata.sql" },
      { version: 7, file: "007_paper_market_filter_metadata.sql" },
      { version: 8, file: "008_market_progress_preference.sql" },
      { version: 9, file: "009_test_fak_execution.sql" },
      { version: 10, file: "010_test_strategy_preferences.sql" },
      { version: 11, file: "011_legacy_target_exit_metadata.sql" },
      { version: 12, file: "012_final_market_eligibility.sql" },
      { version: 13, file: "013_fak_buy_fill_invariant.sql" },
      { version: 14, file: "014_market_duration_range.sql" },
      { version: 15, file: "015_event_cycles.sql" },
      { version: 16, file: "016_configurable_prices.sql" },
    ];

    for (const migration of migrations) {
      const applied = this.database
        .prepare(
          "SELECT 1 FROM schema_migrations WHERE version = ?",
        )
        .get(migration.version);
      if (applied !== undefined) {
        continue;
      }

      const migrationPath = fileURLToPath(
        new URL(`./migrations/${migration.file}`, import.meta.url),
      );
      const migrationSql = readFileSync(migrationPath, "utf8");
      this.database.transaction(() => {
        this.database.exec(migrationSql);
        this.database
          .prepare(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
          )
          .run(migration.version, new Date().toISOString());
      })();
    }
  }

  private ensureStrategyState(initialCapitalMicros: number): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT OR IGNORE INTO strategy_state(
          id, mode, status, initial_capital_micros, available_cash_micros,
          reserved_cash_micros, realized_pnl_micros, updated_at
        ) VALUES (1, 'PAPER', 'PAUSED', ?, ?, 0, 0, ?)`,
      )
      .run(initialCapitalMicros, initialCapitalMicros, now);
  }

  private transaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private assertPaperAccountingMutationAllowed(): void {
    if (this.paperValidationBlocked) {
      throw new Error("Paper mutation is blocked by failed validation");
    }
  }

  private enterRunningState<T>(action: (now: string) => T): T {
    const validation = this.validatePaperState();
    if (!validation.passed) {
      try {
        this.pausePaperStrategyForValidationFailure(validation.errors);
      } catch {
        // The pause method raises the in-memory block before writing, so
        // preserve the validation error even if PAUSED cannot be persisted.
      }
      throw new Error(
        `Paper validation failed: ${validation.errors.join("; ")}`,
      );
    }

    // A validated synchronous transition is the only place that may lift the
    // accounting block before entering RUNNING.
    this.paperValidationBlocked = false;
    try {
      return this.transaction(() => action(new Date().toISOString()));
    } catch (error) {
      this.paperValidationBlocked = true;
      throw error;
    }
  }

  public close(): void {
    this.database.close();
  }

  public setStrategyStatus(status: StrategyStatus): StrategyState {
    if (status === "RUNNING") {
      return this.enterRunningState((now) => {
        this.cancelClosedCycleBuys(now, "STRATEGY_RESUME_FIRST_SELL");
        this.database
          .prepare(
            "UPDATE strategy_state SET status = 'RUNNING', updated_at = ? WHERE id = 1",
          )
          .run(now);
        this.writeAudit("STRATEGY_STATUS_CHANGED", "strategy", "1", {
          status: "RUNNING",
        });
        return this.getStrategyState();
      });
    }

    return this.transaction(() => {
      const now = new Date().toISOString();
      this.database
        .prepare(
          "UPDATE strategy_state SET status = ?, updated_at = ? WHERE id = 1",
        )
        .run(status, now);
      if (!this.paperValidationBlocked) {
        for (const order of this.listActivePaperOrders().filter(
          (paperOrder) => paperOrder.side === "BUY",
        )) {
          this.cancelPaperBuy(order, now, `STRATEGY_${status}`);
        }
      }
      this.writeAudit("STRATEGY_STATUS_CHANGED", "strategy", "1", { status });
      return this.getStrategyState();
    });
  }

  public getStrategyState(): StrategyState {
    const row = this.database
      .prepare(
        `SELECT mode, status, initial_capital_micros, available_cash_micros,
          reserved_cash_micros, realized_pnl_micros, updated_at
        FROM strategy_state WHERE id = 1`,
      )
      .get() as
      | {
          mode: "PAPER";
          status: StrategyStatus;
          initial_capital_micros: number;
          available_cash_micros: number;
          reserved_cash_micros: number;
          realized_pnl_micros: number;
          updated_at: string;
        }
      | undefined;
    if (row === undefined) {
      throw new Error("Strategy state is missing");
    }

    const positionRow = this.database
      .prepare(
        "SELECT COALESCE(SUM(cost_micros), 0) AS position_cost FROM paper_positions",
      )
      .get() as { position_cost: number };

    return {
      mode: row.mode,
      status: row.status,
      initialCapitalMicros: row.initial_capital_micros,
      availableCashMicros: row.available_cash_micros,
      reservedCashMicros: row.reserved_cash_micros,
      realizedPnlMicros: row.realized_pnl_micros,
      positionCostMicros: positionRow.position_cost,
      updatedAt: row.updated_at,
    };
  }

  public updateTestInitialCapital(initialCapitalMicros: number): StrategyState {
    if (!Number.isSafeInteger(initialCapitalMicros) || initialCapitalMicros <= 0) {
      throw new Error("Total TEST capital must be positive");
    }
    return this.transaction(() => {
      const state = this.getStrategyState();
      if (state.status !== "PAUSED") {
        throw new Error("Pause TEST before changing total capital");
      }
      const historyCount = this.getTestTradingHistoryCount();
      if (historyCount > 0) {
        throw new Error(
          "Reset TEST before changing total capital after trading history exists",
        );
      }
      const deltaMicros = initialCapitalMicros - state.initialCapitalMicros;
      if (state.availableCashMicros + deltaMicros < 0) {
        throw new Error("Total TEST capital cannot be lower than committed funds");
      }
      const now = new Date().toISOString();
      this.database
        .prepare(
          `UPDATE strategy_state
          SET initial_capital_micros = ?,
              available_cash_micros = available_cash_micros + ?,
              updated_at = ? WHERE id = 1`,
        )
        .run(initialCapitalMicros, deltaMicros, now);
      this.writeAudit("TEST_CAPITAL_UPDATED", "strategy", "1", {
        previousInitialCapitalMicros: state.initialCapitalMicros,
        initialCapitalMicros,
      });
      return this.getStrategyState();
    });
  }

  public canUpdateTestInitialCapital(): boolean {
    return (
      this.getStrategyState().status === "PAUSED" &&
      this.getTestTradingHistoryCount() === 0
    );
  }

  private getTestTradingHistoryCount(): number {
    const row = this.database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM paper_orders) +
          (SELECT COUNT(*) FROM paper_fills) +
          (SELECT COUNT(*) FROM paper_positions) +
          (SELECT COUNT(*) FROM paper_settlements) +
          (SELECT COUNT(*) FROM paper_event_locks) AS count`,
      )
      .get() as { count: number };
    return row.count;
  }

  public resetTestState(
    initialCapitalMicros: number,
    defaultPreferences: Omit<PaperTradingPreferences, "updatedAt">,
  ): TestResetResult {
    if (!Number.isSafeInteger(initialCapitalMicros) || initialCapitalMicros <= 0) {
      throw new Error("Total TEST capital must be positive");
    }
    const result = this.transaction(() => {
      if (this.getStrategyState().status !== "PAUSED") {
        throw new Error("Pause TEST before resetting it");
      }
      this.database.prepare("DELETE FROM processed_market_trades").run();
      this.database.prepare("DELETE FROM test_order_book_consumption").run();
      this.database.prepare("DELETE FROM paper_fills").run();
      this.database
        .prepare("DELETE FROM paper_orders WHERE side = 'SELL'")
        .run();
      this.database.prepare("DELETE FROM paper_orders").run();
      this.database.prepare("DELETE FROM paper_settlements").run();
      this.database.prepare("DELETE FROM paper_event_locks").run();
      this.database.prepare("DELETE FROM paper_positions").run();
      this.database.prepare("DELETE FROM paper_market_metadata").run();
      this.database
        .prepare("DELETE FROM paper_candidate_selection_overrides")
        .run();
      this.database.prepare("DELETE FROM paper_trading_preferences").run();
      this.database.prepare("DELETE FROM audit_log").run();
      const now = new Date().toISOString();
      this.database
        .prepare(
          `UPDATE strategy_state
          SET status = 'PAUSED', initial_capital_micros = ?,
              available_cash_micros = ?, reserved_cash_micros = 0,
              realized_pnl_micros = 0, updated_at = ? WHERE id = 1`,
        )
        .run(initialCapitalMicros, initialCapitalMicros, now);
      const preferences = this.ensurePaperTradingPreferences(defaultPreferences);
      return { strategy: this.getStrategyState(), preferences };
    });
    this.paperValidationBlocked = false;
    return result;
  }

  public ensurePaperTradingPreferences(
    defaults: Omit<PaperTradingPreferences, "updatedAt">,
  ): PaperTradingPreferences {
    const existing = this.getPaperTradingPreferencesRow();
    if (existing === undefined) {
      const now = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO paper_trading_preferences(
            id, binary_enabled, ternary_enabled, multi_enabled,
            min_buy_price_micros, max_buy_price_micros,
            target_sell_price_increase_micros,
            target_sell_price_multiplier_micros,
            min_market_duration_days, max_market_duration_days,
            max_market_progress_percent,
            candidates_selected_by_default, all_categories_enabled,
            selected_categories_json, candidate_sort_direction,
            order_budget_micros, min_bid_ask_ratio_percent, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          defaults.marketTypes.includes("BINARY") ? 1 : 0,
          defaults.marketTypes.includes("TERNARY") ? 1 : 0,
          defaults.marketTypes.includes("MULTI") ? 1 : 0,
          defaults.minBuyPriceMicros,
          defaults.maxBuyPriceMicros,
          defaults.targetSellPriceIncreaseMicros,
          defaults.targetSellPriceMultiplierMicros,
          defaults.minMarketDurationDays,
          defaults.maxMarketDurationDays,
          defaults.maxMarketProgressPercent,
          defaults.candidatesSelectedByDefault ? 1 : 0,
          defaults.allCategories ? 1 : 0,
          JSON.stringify(defaults.selectedCategories),
          defaults.candidateSortDirection,
          defaults.orderBudgetMicros,
          defaults.minBidAskRatioPercent,
          now,
        );
    }
    return this.getPaperTradingPreferences();
  }

  public getPaperTradingPreferences(): PaperTradingPreferences {
    const row = this.getPaperTradingPreferencesRow();
    if (row === undefined) {
      throw new Error("Paper trading preferences are missing");
    }
    return rowToPaperTradingPreferences(row);
  }

  public updatePaperTradingPreferences(
    preferences: Omit<PaperTradingPreferences, "updatedAt">,
    cancelBuyTokenIds: readonly string[] = [],
  ): PaperTradingPreferencesUpdate {
    const requestedTokenIds = new Set(cancelBuyTokenIds);
    const activeBuyTokenIds = new Set(
      this.listActivePaperOrders()
        .filter(
          (order) =>
            order.side === "BUY" && requestedTokenIds.has(order.tokenId),
        )
        .map((order) => order.tokenId),
    );
    if (activeBuyTokenIds.size > 0) {
      this.assertPaperAccountingMutationAllowed();
    }
    return this.transaction(() => {
      const now = new Date().toISOString();
      this.database
        .prepare(
          `UPDATE paper_trading_preferences
          SET binary_enabled = ?, ternary_enabled = ?, multi_enabled = ?,
              min_buy_price_micros = ?, max_buy_price_micros = ?,
              target_sell_price_increase_micros = ?,
              target_sell_price_multiplier_micros = ?,
              min_market_duration_days = ?, max_market_duration_days = ?,
              max_market_progress_percent = ?,
              candidates_selected_by_default = ?, all_categories_enabled = ?,
              selected_categories_json = ?, candidate_sort_direction = ?,
              order_budget_micros = ?, min_bid_ask_ratio_percent = ?, updated_at = ?
          WHERE id = 1`,
        )
        .run(
          preferences.marketTypes.includes("BINARY") ? 1 : 0,
          preferences.marketTypes.includes("TERNARY") ? 1 : 0,
          preferences.marketTypes.includes("MULTI") ? 1 : 0,
          preferences.minBuyPriceMicros,
          preferences.maxBuyPriceMicros,
          preferences.targetSellPriceIncreaseMicros,
          preferences.targetSellPriceMultiplierMicros,
          preferences.minMarketDurationDays,
          preferences.maxMarketDurationDays,
          preferences.maxMarketProgressPercent,
          preferences.candidatesSelectedByDefault ? 1 : 0,
          preferences.allCategories ? 1 : 0,
          JSON.stringify(preferences.selectedCategories),
          preferences.candidateSortDirection,
          preferences.orderBudgetMicros,
          preferences.minBidAskRatioPercent,
          now,
        );
      let cancelledBuyCount = 0;
      for (const tokenId of activeBuyTokenIds) {
        cancelledBuyCount += this.cancelActiveBuysForToken(
          tokenId,
          now,
          "MARKET_FILTER_EXCLUDED",
        );
      }
      this.writeAudit("PAPER_TRADING_FILTERS_UPDATED", "strategy", "1", {
        marketTypes: preferences.marketTypes,
        minBuyPriceMicros: preferences.minBuyPriceMicros,
        maxBuyPriceMicros: preferences.maxBuyPriceMicros,
        targetSellPriceIncreaseMicros:
          preferences.targetSellPriceIncreaseMicros,
        targetSellPriceMultiplierMicros:
          preferences.targetSellPriceMultiplierMicros,
        minBidAskRatioPercent: preferences.minBidAskRatioPercent,
        minMarketDurationDays: preferences.minMarketDurationDays,
        maxMarketDurationDays: preferences.maxMarketDurationDays,
        maxMarketProgressPercent: preferences.maxMarketProgressPercent,
        allCategories: preferences.allCategories,
        selectedCategories: preferences.selectedCategories,
        candidateSortDirection: preferences.candidateSortDirection,
        orderBudgetMicros: preferences.orderBudgetMicros,
        cancelledBuyCount,
      });
      return {
        preferences: this.getPaperTradingPreferences(),
        cancelledBuyCount,
      };
    });
  }

  public listActivePaperBuyMarkets(): ActivePaperBuyMarket[] {
    const rows = this.database
      .prepare(
        `SELECT po.token_id, po.price_micros, pm.category,
          pm.category_ids_json, pm.result_count, pm.duration_days,
          pm.opened_at, pm.ends_at, pm.min_order_size_micros,
          pm.tick_size_micros
        FROM paper_orders po
        LEFT JOIN paper_market_metadata pm ON pm.token_id = po.token_id
        WHERE po.side = 'BUY' AND po.status IN ('OPEN', 'PARTIALLY_FILLED')
        ORDER BY po.token_id`,
      )
      .all() as unknown as Array<{
      token_id: string;
      price_micros: number;
      category: string | null;
      category_ids_json: string | null;
      result_count: number | null;
      duration_days: number | null;
      opened_at: string | null;
      ends_at: string | null;
      min_order_size_micros: number | null;
      tick_size_micros: number | null;
    }>;
    return rows.map((row) => ({
      tokenId: row.token_id,
      makerBuyPriceMicros: row.price_micros,
      bestAskMicros: row.price_micros,
      bestBidMicros: row.price_micros,
      bookReady: true,
      category: row.category,
      categoryIds: parseCategoryJson(row.category_ids_json ?? "[]"),
      resultCount: row.result_count,
      durationDays: row.duration_days,
      openedAt: row.opened_at,
      endsAt: row.ends_at,
      minOrderSizeMicros:
        row.min_order_size_micros !== null && row.min_order_size_micros > 0
          ? row.min_order_size_micros
          : 1,
      tickSizeMicros:
        row.tick_size_micros !== null && row.tick_size_micros > 0
          ? row.tick_size_micros
          : 1,
    }));
  }

  public getTestMarketExecutionMetadata(
    tokenId: string,
  ): TestMarketExecutionMetadata | null {
    const row = this.database
      .prepare(
        `SELECT token_id, fee_rate_micros, fee_exponent,
          min_order_size_micros, tick_size_micros
        FROM paper_market_metadata WHERE token_id = ?`,
      )
      .get(tokenId) as
      | {
          token_id: string;
          fee_rate_micros: number;
          fee_exponent: number;
          min_order_size_micros: number;
          tick_size_micros: number;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          tokenId: row.token_id,
          feeRateMicros: row.fee_rate_micros,
          feeExponent: row.fee_exponent,
          minOrderSizeMicros: row.min_order_size_micros,
          tickSizeMicros: row.tick_size_micros,
        };
  }

  public listPaperPositions(limit = 100): PaperPosition[] {
    const rows = this.database
      .prepare(
        `SELECT token_id, condition_id, quantity_micros, cost_micros,
          realized_pnl_micros, first_sell_at, cycle_closed_at,
          cycle_spend_micros, gross_buy_size_micros,
          gross_buy_notional_micros, updated_at
        FROM paper_positions ORDER BY updated_at DESC, token_id LIMIT ?`,
      )
      .all(limit) as unknown as PaperPositionRow[];
    return rows.map(rowToPaperPosition);
  }

  public listPaperPositionViews(limit = 100): PaperPositionView[] {
    const rows = this.database
      .prepare(
        `SELECT pp.token_id, pp.condition_id, pp.quantity_micros, pp.cost_micros,
          pp.realized_pnl_micros, pp.first_sell_at, pp.cycle_closed_at,
          pp.cycle_spend_micros, pp.gross_buy_size_micros,
          pp.gross_buy_notional_micros, pp.updated_at,
          pm.event_id, pm.event_slug, pm.event_title,
          pm.market_id, pm.market_question, pm.direction, pm.opened_at, pm.ends_at
        FROM paper_positions pp
        LEFT JOIN paper_market_metadata pm ON pm.token_id = pp.token_id
        ORDER BY pp.updated_at DESC, pp.token_id LIMIT ?`,
      )
      .all(limit) as unknown as PaperPositionViewRow[];
    return rows.map(rowToPaperPositionView);
  }

  public listCurrentPaperPositionViews(): PaperPositionView[] {
    const rows = this.database
      .prepare(
        `SELECT pp.token_id, pp.condition_id, pp.quantity_micros, pp.cost_micros,
          pp.realized_pnl_micros, pp.first_sell_at, pp.cycle_closed_at,
          pp.cycle_spend_micros, pp.gross_buy_size_micros,
          pp.gross_buy_notional_micros, pp.updated_at,
          pm.event_id, pm.event_slug, pm.event_title,
          pm.market_id, pm.market_question, pm.direction, pm.opened_at, pm.ends_at
        FROM paper_positions pp
        LEFT JOIN paper_market_metadata pm ON pm.token_id = pp.token_id
        WHERE pp.quantity_micros > 0
        ORDER BY pp.updated_at DESC, pp.token_id`,
      )
      .all() as unknown as PaperPositionViewRow[];
    return rows.map(rowToPaperPositionView);
  }

  public listPaperEventLocks(): PaperEventLock[] {
    const rows = this.database
      .prepare(
        `SELECT event_id, active_token_id, market_id, condition_id,
          cycle_budget_micros, state, locked_at, updated_at
        FROM paper_event_locks ORDER BY event_id`,
      )
      .all() as unknown as PaperEventLockRow[];
    return rows.map(rowToPaperEventLock);
  }

  public getPaperEventLock(eventId: string): PaperEventLock | null {
    const row = this.getPaperEventLockRow(eventId);
    return row === undefined ? null : rowToPaperEventLock(row);
  }

  public listPaperSettlements(limit = 100): PaperSettlement[] {
    const rows = this.database
      .prepare(
        `SELECT condition_id, market_id, event_id, status,
          resolution_status, winning_token_id, winning_outcome, outcome,
          redemption_status, position_cost_micros, payout_micros,
          realized_pnl_micros, attempt_count, last_error, settled_at,
          redeemed_at, created_at, updated_at
        FROM paper_settlements ORDER BY updated_at DESC, condition_id LIMIT ?`,
      )
      .all(limit) as unknown as PaperSettlementRow[];
    return rows.map(rowToPaperSettlement);
  }

  public getPaperSettlement(conditionId: string): PaperSettlement | null {
    const row = this.getPaperSettlementRow(conditionId);
    return row === undefined ? null : rowToPaperSettlement(row);
  }

  public listPaperSettlementTargets(
    now: Date = new Date(),
  ): PaperSettlementTarget[] {
    const rows = this.database
      .prepare(
        `SELECT po.condition_id, po.market_id, po.event_id
        FROM paper_orders po
        LEFT JOIN paper_settlements ps ON ps.condition_id = po.condition_id
        LEFT JOIN paper_positions pp
          ON pp.token_id = po.token_id
          AND pp.condition_id = po.condition_id
          AND pp.quantity_micros > 0
        WHERE (
            po.market_ends_at IS NOT NULL AND po.market_ends_at <= ?
          OR pp.token_id IS NOT NULL
          OR ps.status = 'PENDING'
        )
          AND (ps.status IS NULL OR ps.status = 'PENDING')
          AND (
            ps.status = 'PENDING' OR
            pp.token_id IS NOT NULL OR
            po.status IN ('OPEN', 'PARTIALLY_FILLED')
          )
        GROUP BY po.condition_id, po.market_id, po.event_id
        ORDER BY MIN(po.market_ends_at), po.condition_id`,
      )
      .all(now.toISOString()) as unknown as Array<{
      condition_id: string;
      market_id: string;
      event_id: string;
    }>;
    return rows.map((row) => ({
      conditionId: row.condition_id,
      marketId: row.market_id,
      eventId: row.event_id,
    }));
  }

  public ensurePaperSettlement(
    target: PaperSettlementTarget,
    now: Date = new Date(),
  ): PaperSettlement {
    this.assertPaperAccountingMutationAllowed();
    return this.transaction(() => {
      const existing = this.getPaperSettlementRow(target.conditionId);
      if (existing !== undefined) {
        this.assertSettlementTargetMatches(existing, target);
        return rowToPaperSettlement(existing);
      }

      const nowIso = now.toISOString();
      this.database
        .prepare(
          `INSERT INTO paper_settlements(
            condition_id, market_id, event_id, status, resolution_status,
            winning_token_id, winning_outcome, outcome, redemption_status,
            position_cost_micros, payout_micros, realized_pnl_micros,
            attempt_count, last_error, settled_at, redeemed_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'PENDING', NULL, NULL, NULL, NULL, 'PENDING',
            0, 0, 0, 0, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          target.conditionId,
          target.marketId,
          target.eventId,
          nowIso,
          nowIso,
        );
      this.writeAudit("PAPER_SETTLEMENT_TRACKED", "paper_settlement", target.conditionId, {
        marketId: target.marketId,
        eventId: target.eventId,
      });
      return this.getPaperSettlement(target.conditionId) as PaperSettlement;
    });
  }

  public recordPaperSettlementCheck(input: {
    target: PaperSettlementTarget;
    resolutionStatus: string | null;
    reason: string;
    error?: string | null;
    now?: Date;
  }): PaperSettlement {
    this.assertPaperAccountingMutationAllowed();
    return this.transaction(() => {
      const current = this.getPaperSettlementRow(input.target.conditionId);
      if (current === undefined) {
        this.ensurePaperSettlementWithoutTransaction(input.target, input.now ?? new Date());
      } else {
        this.assertSettlementTargetMatches(current, input.target);
      }

      const row = this.getPaperSettlementRow(input.target.conditionId);
      if (row === undefined) {
        throw new Error(`Paper settlement not found: ${input.target.conditionId}`);
      }
      if (row.status === "SETTLED") {
        return rowToPaperSettlement(row);
      }

      const nowIso = (input.now ?? new Date()).toISOString();
      const lastError = input.error ?? input.reason;
      this.database
        .prepare(
          `UPDATE paper_settlements
          SET resolution_status = ?, attempt_count = attempt_count + 1,
              last_error = ?, updated_at = ? WHERE condition_id = ?`,
        )
        .run(input.resolutionStatus, lastError, nowIso, input.target.conditionId);
      this.writeAudit("PAPER_SETTLEMENT_CHECKED", "paper_settlement", input.target.conditionId, {
        reason: input.reason,
        resolutionStatus: input.resolutionStatus,
        error: input.error ?? null,
      });
      return this.getPaperSettlement(input.target.conditionId) as PaperSettlement;
    });
  }

  public applyPaperSettlement(input: {
    target: PaperSettlementTarget;
    closed: boolean;
    resolutionStatus: string;
    winningTokenId: string | null;
    winningOutcome: string;
    payouts?: readonly PaperSettlementPayout[];
    now?: Date;
  }): AppliedPaperSettlement {
    this.assertPaperAccountingMutationAllowed();
    const normalizedResolutionStatus = input.resolutionStatus
      .trim()
      .toLowerCase();
    const hasFinalResolutionStatus = FINAL_RESOLUTION_STATUSES.has(
      normalizedResolutionStatus,
    );
    let receivedPayouts: PaperSettlementPayout[] | null = null;
    if (
      input.payouts === undefined &&
      input.winningTokenId !== null &&
      input.winningTokenId.length > 0 &&
      input.winningTokenId === input.winningTokenId.trim() &&
      input.winningOutcome.length > 0 &&
      input.winningOutcome === input.winningOutcome.trim() &&
      input.winningOutcome !== "50/50"
    ) {
      receivedPayouts = [
        { tokenId: input.winningTokenId, priceMicros: 1_000_000 },
      ];
    } else if (
      input.payouts !== undefined &&
      input.winningTokenId === null &&
      input.winningOutcome === "50/50" &&
      input.payouts.length === 2 &&
      input.payouts.every(
        (payout) =>
          payout.tokenId.length > 0 &&
          payout.tokenId === payout.tokenId.trim() &&
          payout.priceMicros === 500_000,
      ) &&
      input.payouts[0]?.tokenId !== input.payouts[1]?.tokenId
    ) {
      receivedPayouts = [...input.payouts].sort((left, right) =>
        left.tokenId.localeCompare(right.tokenId),
      );
    }
    let conflictError: Error | null = null;
    const result = this.transaction<AppliedPaperSettlement | null>(() => {
      const target = input.target;
      let existing = this.getPaperSettlementRow(target.conditionId);
      let recordedPayouts: PaperSettlementPayout[] | null = null;
      let conflictReason: string | null = null;
      if (existing !== undefined) {
        const targetMatches =
          existing.market_id === target.marketId &&
          existing.event_id === target.eventId;
        if (!targetMatches) {
          conflictReason = "TARGET_METADATA_CHANGED";
        } else if (existing.status === "SETTLED") {
          recordedPayouts = this.getRecordedPaperSettlementPayouts(
            target.conditionId,
          );
          if (!input.closed) {
            conflictReason = "MARKET_NOT_CLOSED";
          } else if (!hasFinalResolutionStatus) {
            conflictReason = "RESOLUTION_STATUS_NOT_FINAL";
          } else if (receivedPayouts === null) {
            conflictReason = "RESULT_VECTOR_INVALID";
          } else if (existing.winning_token_id !== input.winningTokenId) {
            conflictReason = "WINNING_TOKEN_CHANGED";
          } else if (existing.winning_outcome !== input.winningOutcome) {
            conflictReason = "WINNING_OUTCOME_CHANGED";
          } else if (
            !samePaperSettlementPayouts(recordedPayouts, receivedPayouts)
          ) {
            conflictReason = "PAYOUT_VECTOR_CHANGED";
          }
        }
      }

      if (existing !== undefined && conflictReason !== null) {
        const nowIso = (input.now ?? new Date()).toISOString();
        this.database
          .prepare(
            "UPDATE strategy_state SET status = 'PAUSED', updated_at = ? WHERE id = 1",
          )
          .run(nowIso);
        this.writeAudit(
          "PAPER_SETTLEMENT_CONFLICT",
          "paper_settlement",
          target.conditionId,
          {
            conflictReason,
            recordedMarketId: existing.market_id,
            receivedMarketId: target.marketId,
            recordedEventId: existing.event_id,
            receivedEventId: target.eventId,
            recordedResolutionStatus: existing.resolution_status,
            receivedClosed: input.closed,
            receivedResolutionStatus: input.resolutionStatus,
            recordedWinningTokenId: existing.winning_token_id,
            receivedWinningTokenId: input.winningTokenId,
            recordedWinningOutcome: existing.winning_outcome,
            receivedWinningOutcome: input.winningOutcome,
            recordedPayouts,
            receivedPayouts: receivedPayouts ?? input.payouts ?? null,
          },
        );
        conflictError = new Error(
          `Conflicting paper settlement result for condition: ${target.conditionId}`,
        );
        return null;
      }

      if (existing?.status === "SETTLED") {
        return {
          settlement: rowToPaperSettlement(existing),
          duplicate: true,
          positionCount: 0,
          cancelledBuyCount: 0,
          cancelledSellCount: 0,
        };
      }

      if (!input.closed) {
        throw new PaperResolutionValidationError(
          "Paper settlement requires a closed market",
        );
      }
      const resolutionStatus = normalizeFinalResolutionStatus(
        input.resolutionStatus,
      );
      if (receivedPayouts === null) {
        throw new Error(
          "Paper settlement result must be an official 1/0 or 50/50 result",
        );
      }

      if (existing === undefined) {
        this.ensurePaperSettlementWithoutTransaction(
          target,
          input.now ?? new Date(),
        );
        existing = this.getPaperSettlementRow(target.conditionId);
      }
      if (existing === undefined) {
        throw new Error(`Paper settlement not found: ${target.conditionId}`);
      }
      this.assertSettlementTargetMatches(existing, target);

      const now = input.now ?? new Date();
      const nowIso = now.toISOString();
      const allPositions = this.database
        .prepare(
          `SELECT token_id, condition_id, quantity_micros, cost_micros,
            realized_pnl_micros, first_sell_at, cycle_closed_at, updated_at
          FROM paper_positions WHERE condition_id = ?`,
        )
        .all(target.conditionId) as unknown as PaperPositionRow[];
      for (const position of allPositions) {
        if (position.quantity_micros < 0 || position.cost_micros < 0) {
          throw new Error(
            `Paper position contains a negative value: ${position.token_id}`,
          );
        }
        if (position.quantity_micros === 0 && position.cost_micros !== 0) {
          throw new Error(
            `Paper position cost exists without quantity: ${position.token_id}`,
          );
        }
      }
      const positions = allPositions.filter((position) => position.quantity_micros > 0);

      const payoutByToken = new Map(
        receivedPayouts.map((payout) => [payout.tokenId, payout.priceMicros]),
      );
      if (receivedPayouts.length === 2) {
        for (const position of positions) {
          if (!payoutByToken.has(position.token_id)) {
            throw new Error(
              `Paper settlement payout vector is missing position token: ${position.token_id}`,
            );
          }
        }
      }

      let cancelledBuyCount = 0;
      let cancelledSellCount = 0;
      const activeOrdersForMarket = this.listActivePaperOrders().filter(
        (paperOrder) => paperOrder.conditionId === target.conditionId,
      );
      const activeSellByToken = new Map<string, number>();
      for (const order of activeOrdersForMarket.filter(
        (paperOrder) => paperOrder.side === "SELL",
      )) {
        activeSellByToken.set(
          order.tokenId,
          (activeSellByToken.get(order.tokenId) ?? 0) +
            order.originalSizeMicros -
            order.filledSizeMicros,
        );
      }
      for (const position of positions) {
        if ((activeSellByToken.get(position.token_id) ?? 0) !== position.quantity_micros) {
          throw new Error(
            `Active paper sells do not cover position at settlement: ${position.token_id}`,
          );
        }
      }
      const positionTokens = new Set(positions.map((position) => position.token_id));
      for (const tokenId of activeSellByToken.keys()) {
        if (!positionTokens.has(tokenId)) {
          throw new Error(
            `Active paper sell has no matching position at settlement: ${tokenId}`,
          );
        }
      }

      for (const order of activeOrdersForMarket) {
        if (order.side === "BUY") {
          this.cancelPaperBuy(order, nowIso, "MARKET_SETTLED");
          cancelledBuyCount += 1;
        } else {
          this.cancelPaperSell(order, nowIso, "MARKET_SETTLED");
          cancelledSellCount += 1;
        }
      }

      let positionCostMicros = 0;
      let payoutMicros = 0;
      let realizedPnlMicros = 0;
      let winningPositionCount = 0;
      for (const position of positions) {
        const payoutPriceMicros = payoutByToken.get(position.token_id) ?? 0;
        const payout = calculateOrderCostMicros(
          payoutPriceMicros,
          position.quantity_micros,
        );
        const positionPnl = payout - position.cost_micros;
        positionCostMicros += position.cost_micros;
        payoutMicros += payout;
        realizedPnlMicros += positionPnl;
        if (payout > 0) {
          winningPositionCount += 1;
        }

        this.database
          .prepare(
            `UPDATE paper_positions
            SET quantity_micros = 0, cost_micros = 0,
                realized_pnl_micros = realized_pnl_micros + ?,
                cycle_closed_at = ?, updated_at = ? WHERE token_id = ?`,
          )
          .run(positionPnl, nowIso, nowIso, position.token_id);
      }

      if (positions.length > 0) {
        this.database
          .prepare(
            `UPDATE strategy_state
            SET available_cash_micros = available_cash_micros + ?,
                realized_pnl_micros = realized_pnl_micros + ?,
                updated_at = ? WHERE id = 1`,
          )
          .run(payoutMicros, realizedPnlMicros, nowIso);
      }

      const outcome: PaperSettlementOutcome =
        positions.length === 0
          ? "NO_POSITION"
          : winningPositionCount === 0
            ? "LOSS"
            : winningPositionCount === positions.length
              ? "WIN"
              : "MIXED";
      const redemptionStatus: PaperRedemptionStatus =
        winningPositionCount > 0 ? "SIMULATED" : "NOT_APPLICABLE";
      const redeemedAt = winningPositionCount > 0 ? nowIso : null;
      this.database
        .prepare(
          `UPDATE paper_settlements
          SET status = 'SETTLED', resolution_status = ?,
              winning_token_id = ?, winning_outcome = ?, outcome = ?,
              redemption_status = ?, position_cost_micros = ?,
              payout_micros = ?, realized_pnl_micros = ?,
              attempt_count = attempt_count + 1, last_error = NULL,
              settled_at = ?, redeemed_at = ?, updated_at = ?
          WHERE condition_id = ?`,
        )
        .run(
          resolutionStatus,
          input.winningTokenId,
          input.winningOutcome,
          outcome,
          redemptionStatus,
          positionCostMicros,
          payoutMicros,
          realizedPnlMicros,
          nowIso,
          redeemedAt,
          nowIso,
          target.conditionId,
        );
      this.writeAudit("PAPER_MARKET_SETTLED", "paper_settlement", target.conditionId, {
        marketId: target.marketId,
        eventId: target.eventId,
        resolutionStatus,
        winningTokenId: input.winningTokenId,
        payouts: Array.from(payoutByToken.entries()).map(
          ([tokenId, priceMicros]) => ({ tokenId, priceMicros }),
        ),
        positionCount: positions.length,
        positionCostMicros,
        payoutMicros,
        realizedPnlMicros,
        redemptionStatus,
      });
      this.releasePaperEventLockIfClosed(target.eventId, nowIso);

      return {
        settlement: this.getPaperSettlement(target.conditionId) as PaperSettlement,
        duplicate: false,
        positionCount: positions.length,
        cancelledBuyCount,
        cancelledSellCount,
      };
    });
    if (conflictError !== null) {
      throw conflictError;
    }
    if (result === null) {
      throw new Error(`Paper settlement was not applied: ${input.target.conditionId}`);
    }
    return result;
  }

  public listPaperOrders(limit = 100): PaperOrder[] {
    const rows = this.database
      .prepare(
        `SELECT id, token_id, condition_id, event_id, market_id, game_starts_at,
          market_opened_at, market_ends_at, side,
          price_micros, target_sell_price_micros, linked_buy_order_id,
          original_size_micros, filled_size_micros,
          queue_ahead_size_micros, queue_baseline_filled_size_micros,
          observed_trade_size_micros, status, execution_kind,
          cash_limit_micros, fee_micros,
          created_at, updated_at
        FROM paper_orders ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as PaperOrderRow[];
    return rows.map(rowToPaperOrder);
  }

  public listActivePaperOrders(tokenId?: string): PaperOrder[] {
    const filter = tokenId === undefined ? "" : "AND token_id = ?";
    const rows = this.database
      .prepare(
        `SELECT id, token_id, condition_id, event_id, market_id, game_starts_at,
          market_opened_at, market_ends_at, side,
          price_micros, target_sell_price_micros, linked_buy_order_id,
          original_size_micros, filled_size_micros,
          queue_ahead_size_micros, queue_baseline_filled_size_micros,
          observed_trade_size_micros, status, execution_kind,
          cash_limit_micros, fee_micros,
          created_at, updated_at
        FROM paper_orders
        WHERE status IN ('OPEN', 'PARTIALLY_FILLED') ${filter}
        ORDER BY created_at, id`,
      )
      .all(...(tokenId === undefined ? [] : [tokenId])) as unknown as PaperOrderRow[];
    return rows.map(rowToPaperOrder);
  }

  public rebaseActivePaperOrderQueues(
    tokenId: string,
    bids: BookLevel[],
    asks: BookLevel[],
  ): PaperOrder[] {
    return this.transaction(() => {
      const orders = this.listActivePaperOrders(tokenId).filter(
        (order) =>
          order.executionKind === "LEGACY_MAKER" &&
          (!this.paperValidationBlocked || order.side === "SELL"),
      );
      const virtualAhead = new Map<string, number>();
      const now = new Date().toISOString();

      for (const order of orders) {
        const levels = order.side === "BUY" ? bids : asks;
        const key = `${order.side}:${order.priceMicros}`;
        const realQueue = levels
          .filter((level) => level.priceMicros === order.priceMicros)
          .reduce((sum, level) => sum + level.sizeMicros, 0);
        const queueAhead = realQueue + (virtualAhead.get(key) ?? 0);
        const remainingSize = order.originalSizeMicros - order.filledSizeMicros;

        this.database
          .prepare(
            `UPDATE paper_orders
            SET queue_ahead_size_micros = ?,
                queue_baseline_filled_size_micros = ?,
                observed_trade_size_micros = 0, updated_at = ? WHERE id = ?`,
          )
          .run(queueAhead, order.filledSizeMicros, now, order.id);
        virtualAhead.set(key, (virtualAhead.get(key) ?? 0) + remainingSize);
      }

      if (orders.length > 0) {
        this.writeAudit("PAPER_QUEUES_REBASED", "market_token", tokenId, {
          orderCount: orders.length,
        });
      }
      return this.listActivePaperOrders(tokenId);
    });
  }

  public cancelStartedGameBuys(now: Date = new Date()): number {
    if (this.paperValidationBlocked) {
      return 0;
    }
    return this.transaction(() => {
      const nowIso = now.toISOString();
      const orders = this.listActivePaperOrders().filter(
        (order) =>
          order.side === "BUY" &&
          order.gameStartsAt !== null &&
          Date.parse(order.gameStartsAt) <= now.getTime(),
      );
      for (const order of orders) {
        this.cancelPaperBuy(order, nowIso, "GAME_STARTED");
      }
      return orders.length;
    });
  }

  public cancelProgressedMarketBuys(
    stopProgressPercent: number,
    now: Date = new Date(),
  ): number {
    if (this.paperValidationBlocked) {
      return 0;
    }
    return this.transaction(() => {
      const nowIso = now.toISOString();
      const orders = this.listActivePaperOrders().filter((order) => {
        if (
          order.side !== "BUY" ||
          order.marketOpenedAt === null ||
          order.marketEndsAt === null
        ) {
          return false;
        }
        const openedAt = Date.parse(order.marketOpenedAt);
        const endsAt = Date.parse(order.marketEndsAt);
        if (
          !Number.isFinite(openedAt) ||
          !Number.isFinite(endsAt) ||
          endsAt <= openedAt
        ) {
          return true;
        }
        const progressPercent =
          ((now.getTime() - openedAt) / (endsAt - openedAt)) * 100;
        return progressPercent >= stopProgressPercent;
      });
      for (const order of orders) {
        this.cancelPaperBuy(order, nowIso, "MARKET_PROGRESS_LIMIT");
      }
      return orders.length;
    });
  }

  public cancelEndedPaperBuys(now: Date = new Date()): number {
    if (this.paperValidationBlocked) {
      return 0;
    }
    return this.transaction(() => {
      const nowIso = now.toISOString();
      const orders = this.listActivePaperOrders().filter(
        (order) =>
          order.side === "BUY" &&
          order.marketEndsAt !== null &&
          Date.parse(order.marketEndsAt) <= now.getTime(),
      );
      for (const order of orders) {
        this.cancelPaperBuy(order, nowIso, "MARKET_ENDED");
      }
      return orders.length;
    });
  }

  public validatePaperState(): PaperValidationResult {
    const checkedAt = new Date().toISOString();
    const sqliteIntegrity = String(
      this.database.pragma("quick_check", { simple: true }),
    );
    const errors = sqliteIntegrity === "ok"
      ? []
      : [`SQLite quick check failed: ${sqliteIntegrity}`];
    const activeOrders = this.listActivePaperOrders();
    errors.push(
      ...this.collectPaperStateErrors(activeOrders, this.getStrategyState()),
    );
    const openPositionCount = (
      this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM paper_positions WHERE quantity_micros != 0 OR cost_micros != 0",
        )
        .get() as { count: number }
    ).count;
    const pendingSettlementCount = (
      this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM paper_settlements WHERE status = 'PENDING'",
        )
        .get() as { count: number }
    ).count;

    return {
      passed: errors.length === 0,
      errors,
      sqliteIntegrity,
      activeOrderCount: activeOrders.length,
      openPositionCount,
      pendingSettlementCount,
      checkedAt,
    };
  }

  private collectPaperStateErrors(
    activeOrders: readonly PaperOrder[],
    state: StrategyState,
  ): string[] {
    const errors: string[] = [];
    const invalidOrderRows = this.database
      .prepare(
        `SELECT id FROM paper_orders
        WHERE original_size_micros <= 0
          OR filled_size_micros < 0
          OR filled_size_micros > original_size_micros
          OR (status = 'OPEN' AND filled_size_micros != 0)
          OR (
            status = 'PARTIALLY_FILLED'
            AND (filled_size_micros <= 0 OR filled_size_micros >= original_size_micros)
          )
          OR (status = 'FILLED' AND filled_size_micros != original_size_micros)`,
      )
      .all() as unknown as Array<{ id: string }>;
    for (const order of invalidOrderRows) {
      errors.push(`Paper order has an invalid fill range: ${order.id}`);
    }

    const invalidFillRows = this.database
      .prepare(
        `SELECT pf.id FROM paper_fills pf
        JOIN paper_orders po ON po.id = pf.order_id
        WHERE length(trim(pf.source_trade_id)) = 0
          OR pf.price_micros <= 0
          OR pf.price_micros >= 1000000
          OR pf.size_micros <= 0
          OR pf.net_size_micros <= 0
          OR pf.net_size_micros > pf.size_micros
          OR pf.fee_micros < 0
          OR (po.side = 'SELL' AND pf.net_size_micros != pf.size_micros)`,
      )
      .all() as unknown as Array<{ id: string }>;
    for (const fill of invalidFillRows) {
      errors.push(`Paper fill contains invalid accounting values: ${fill.id}`);
    }

    const orderFillRows = this.database
      .prepare(
        `SELECT po.id, po.filled_size_micros, po.fee_micros,
          COALESCE(SUM(pf.size_micros), 0) AS fill_size_micros,
          COALESCE(SUM(pf.fee_micros), 0) AS fill_fee_micros
        FROM paper_orders po
        LEFT JOIN paper_fills pf ON pf.order_id = po.id
        GROUP BY po.id, po.filled_size_micros, po.fee_micros`,
      )
      .all() as unknown as Array<{
      id: string;
      filled_size_micros: number;
      fee_micros: number;
      fill_size_micros: number;
      fill_fee_micros: number;
    }>;
    for (const order of orderFillRows) {
      if (
        order.filled_size_micros !== order.fill_size_micros ||
        order.fee_micros !== order.fill_fee_micros
      ) {
        errors.push(`Paper order fill totals do not match: ${order.id}`);
      }
    }

    const expectedReservedCash = activeOrders
      .filter((order) => order.side === "BUY")
      .reduce(
        (sum, order) =>
          sum +
          calculateOrderCostMicros(
            order.priceMicros,
            order.originalSizeMicros - order.filledSizeMicros,
          ),
        0,
      );
    if (state.reservedCashMicros !== expectedReservedCash) {
      errors.push("Reserved paper cash does not match active buy orders");
    }
    if (
      state.availableCashMicros < 0 ||
      state.reservedCashMicros < 0 ||
      state.positionCostMicros < 0
    ) {
      errors.push("Paper balances contain a negative value");
    }
    if (
      state.availableCashMicros +
        state.reservedCashMicros +
        state.positionCostMicros !==
      state.initialCapitalMicros + state.realizedPnlMicros
    ) {
      errors.push("Paper balance conservation check failed");
    }

    const positionRows = this.database
      .prepare(
        `SELECT token_id, condition_id, quantity_micros, cost_micros
        FROM paper_positions
        WHERE quantity_micros != 0 OR cost_micros != 0`,
      )
      .all() as unknown as Array<{
      token_id: string;
      condition_id: string;
      quantity_micros: number;
      cost_micros: number;
    }>;
    const fillPositionRows = this.database
      .prepare(
        `SELECT po.token_id, po.condition_id,
          SUM(
            CASE WHEN po.side = 'BUY'
              THEN pf.net_size_micros
              ELSE -pf.size_micros
            END
          ) AS quantity_micros
        FROM paper_orders po
        JOIN paper_fills pf ON pf.order_id = po.id
        LEFT JOIN paper_settlements ps ON ps.condition_id = po.condition_id
        WHERE ps.status IS NULL OR ps.status != 'SETTLED'
        GROUP BY po.token_id, po.condition_id`,
      )
      .all() as unknown as Array<{
      token_id: string;
      condition_id: string;
      quantity_micros: number;
    }>;
    const fillPositionByMarket = new Map(
      fillPositionRows.map((position) => [
        `${position.condition_id}\u0000${position.token_id}`,
        position.quantity_micros,
      ]),
    );
    const activeSellByToken = new Map<string, number>();
    for (const order of activeOrders.filter((order) => order.side === "SELL")) {
      activeSellByToken.set(
        order.tokenId,
        (activeSellByToken.get(order.tokenId) ?? 0) +
          order.originalSizeMicros -
          order.filledSizeMicros,
      );
    }
    for (const position of positionRows) {
      const fillPositionKey = `${position.condition_id}\u0000${position.token_id}`;
      if (
        (fillPositionByMarket.get(fillPositionKey) ?? 0) !==
        position.quantity_micros
      ) {
        errors.push(
          `Paper fill position total does not match: ${position.token_id}`,
        );
      }
      fillPositionByMarket.delete(fillPositionKey);
      if (position.quantity_micros <= 0 || position.cost_micros <= 0) {
        errors.push(
          `Paper position has invalid quantity or cost: ${position.token_id}`,
        );
      }
      if (position.quantity_micros <= 0) {
        continue;
      }
      if (
        (activeSellByToken.get(position.token_id) ?? 0) !==
        position.quantity_micros
      ) {
        errors.push(
          `Active paper sells do not cover position: ${position.token_id}`,
        );
      }
      activeSellByToken.delete(position.token_id);
    }
    if (activeSellByToken.size > 0) {
      errors.push("Active paper sells exist without matching positions");
    }
    for (const [key, quantityMicros] of fillPositionByMarket) {
      if (quantityMicros !== 0) {
        errors.push(
          `Paper fill position total does not match: ${key.split("\u0000")[1]}`,
        );
      }
    }

    errors.push(...this.collectPaperEventStateErrors(activeOrders));

    const settledConditions = this.database
      .prepare(
        "SELECT condition_id FROM paper_settlements WHERE status = 'SETTLED'",
      )
      .all() as unknown as Array<{ condition_id: string }>;
    for (const settlement of settledConditions) {
      if (
        activeOrders.some(
          (order) => order.conditionId === settlement.condition_id,
        )
      ) {
        errors.push(
          `Settled market still has active paper orders: ${settlement.condition_id}`,
        );
      }
      const openPosition = this.database
        .prepare(
          `SELECT 1 FROM paper_positions
          WHERE condition_id = ? AND (quantity_micros != 0 OR cost_micros != 0)
          LIMIT 1`,
        )
        .get(settlement.condition_id);
      if (openPosition !== undefined) {
        errors.push(
          `Settled market still has an open paper position: ${settlement.condition_id}`,
        );
      }
    }
    return errors;
  }

  private collectPaperEventStateErrors(
    activeOrders: readonly PaperOrder[],
  ): string[] {
    const errors = new Set<string>();
    const positions = this.database
      .prepare(
        `SELECT pp.token_id, pp.condition_id, pp.cycle_spend_micros,
          pp.first_sell_at, pm.event_id, pm.market_id
        FROM paper_positions pp
        LEFT JOIN paper_market_metadata pm ON pm.token_id = pp.token_id
        WHERE pp.quantity_micros > 0`,
      )
      .all() as unknown as Array<{
      token_id: string;
      condition_id: string;
      cycle_spend_micros: number;
      first_sell_at: string | null;
      event_id: string | null;
      market_id: string | null;
    }>;
    const positionsByEvent = new Map<string, typeof positions>();
    for (const position of positions) {
      if (position.event_id === null || position.market_id === null) {
        errors.add(
          `Paper position is missing Event metadata: ${position.token_id}`,
        );
        continue;
      }
      const eventPositions = positionsByEvent.get(position.event_id) ?? [];
      eventPositions.push(position);
      positionsByEvent.set(position.event_id, eventPositions);
    }

    const metadataRows = this.database
      .prepare(
        `SELECT token_id, event_id, market_id FROM paper_market_metadata`,
      )
      .all() as unknown as Array<{
      token_id: string;
      event_id: string;
      market_id: string;
    }>;
    const metadataByToken = new Map(
      metadataRows.map((metadata) => [metadata.token_id, metadata]),
    );
    const locks = this.listPaperEventLocks();
    const locksByEvent = new Map(locks.map((lock) => [lock.eventId, lock]));
    const activeTargetsByEvent = new Map<string, PaperOrder[]>();
    const activeBuysByEvent = new Map<string, PaperOrder[]>();
    for (const order of activeOrders) {
      const targetMap =
        order.side === "SELL"
          ? activeTargetsByEvent
          : order.side === "BUY"
            ? activeBuysByEvent
            : null;
      if (targetMap === null) continue;
      const orders = targetMap.get(order.eventId) ?? [];
      orders.push(order);
      targetMap.set(order.eventId, orders);
    }

    for (const [eventId, eventPositions] of positionsByEvent) {
      const lock = locksByEvent.get(eventId);
      if (lock === undefined) {
        for (const position of eventPositions) {
          errors.add(
            `Paper position is missing its Event lock: ${position.token_id}`,
          );
        }
        continue;
      }
      if (eventPositions.length > 1 && lock.state !== "LEGACY_CONFLICT") {
        errors.add(
          `Paper Event has multiple positive tokens without LEGACY_CONFLICT: ${eventId}`,
        );
      }
    }

    const settledConditionRows = this.database
      .prepare(
        `SELECT condition_id FROM paper_settlements WHERE status = 'SETTLED'`,
      )
      .all() as unknown as Array<{ condition_id: string }>;
    const settledConditions = new Set(
      settledConditionRows.map((row) => row.condition_id),
    );
    for (const lock of locks) {
      const eventPositions = positionsByEvent.get(lock.eventId) ?? [];
      const activeTargets = activeTargetsByEvent.get(lock.eventId) ?? [];
      const activeBuys = activeBuysByEvent.get(lock.eventId) ?? [];
      if (eventPositions.length === 0 && activeTargets.length === 0) {
        errors.add(
          `Paper Event lock has no position or active target: ${lock.eventId}`,
        );
      }
      if (
        lock.conditionId !== null &&
        settledConditions.has(lock.conditionId)
      ) {
        errors.add(
          `Settled condition still has an Event lock: ${lock.conditionId}`,
        );
      }

      if (lock.state === "LEGACY_CONFLICT") {
        if (activeBuys.length > 0) {
          errors.add(
            `LEGACY_CONFLICT Event has an active BUY: ${lock.eventId}`,
          );
        }
        continue;
      }

      const activeTokenId = lock.activeTokenId;
      const metadata =
        activeTokenId === null ? undefined : metadataByToken.get(activeTokenId);
      const identityMatches =
        activeTokenId !== null &&
        lock.marketId !== null &&
        lock.conditionId !== null &&
        metadata?.event_id === lock.eventId &&
        metadata.market_id === lock.marketId &&
        eventPositions.every(
          (position) =>
            position.token_id === activeTokenId &&
            position.market_id === lock.marketId &&
            position.condition_id === lock.conditionId,
        ) &&
        activeTargets.every(
          (target) =>
            target.tokenId === activeTokenId &&
            target.marketId === lock.marketId &&
            target.conditionId === lock.conditionId,
        );
      if (!identityMatches) {
        errors.add(
          `Paper Event lock identity does not match metadata: ${lock.eventId}`,
        );
      }
      if (activeBuys.some((buy) => buy.tokenId !== activeTokenId)) {
        errors.add(
          `Paper Event lock has an active sibling BUY: ${lock.eventId}`,
        );
      }
      const activePosition = eventPositions.find(
        (position) => position.token_id === activeTokenId,
      );
      if (
        activePosition !== undefined &&
        activePosition.cycle_spend_micros > lock.cycleBudgetMicros
      ) {
        errors.add(
          `Paper Event cycle spend exceeds frozen budget: ${lock.eventId}`,
        );
      }
      if (
        activePosition?.first_sell_at !== null &&
        activePosition?.first_sell_at !== undefined &&
        activeBuys.length > 0
      ) {
        errors.add(
          `Paper Event has an active BUY after first sell: ${lock.eventId}`,
        );
      }
    }

    const postSellBuyRows = this.database
      .prepare(
        `SELECT DISTINCT pm.event_id
        FROM paper_positions pp
        JOIN paper_market_metadata pm ON pm.token_id = pp.token_id
        JOIN paper_event_locks pel ON pel.event_id = pm.event_id
          AND pel.state = 'ACTIVE'
          AND pel.active_token_id = pp.token_id
        JOIN paper_orders po ON po.event_id = pm.event_id
          AND po.token_id = pel.active_token_id
          AND po.side = 'BUY'
        WHERE pp.first_sell_at IS NOT NULL
          AND po.created_at > pp.first_sell_at`,
      )
      .all() as unknown as Array<{ event_id: string }>;
    for (const row of postSellBuyRows) {
      errors.add(`Paper Event has a BUY created after first sell: ${row.event_id}`);
    }
    return [...errors];
  }

  public pausePaperStrategyForValidationFailure(
    errors: readonly string[],
  ): StrategyState {
    if (errors.length === 0) {
      throw new Error("Paper validation pause requires at least one error");
    }
    this.paperValidationBlocked = true;
    return this.transaction(() => {
      const now = new Date().toISOString();
      // Do not rebalance or cancel from an inconsistent ledger. Preserve the
      // evidence and stop new placements until validation passes again.
      this.database
        .prepare(
          "UPDATE strategy_state SET status = 'PAUSED', updated_at = ? WHERE id = 1",
        )
        .run(now);
      this.writeAudit("PAPER_VALIDATION_FAILED", "strategy", "1", {
        errors: [...errors],
      });
      return this.getStrategyState();
    });
  }

  public recoverPaperState(): PaperRecoveryResult {
    this.assertPaperAccountingMutationAllowed();
    const validation = this.validatePaperState();
    if (!validation.passed) {
      try {
        this.pausePaperStrategyForValidationFailure(validation.errors);
      } catch {
        // The in-memory mutation block is raised before the persistent pause.
      }
      return {
        passed: false,
        errors: validation.errors,
        activeOrderCount: validation.activeOrderCount,
        cancelledBuyCount: 0,
        recoveredAt: new Date().toISOString(),
      };
    }
    return this.transaction(() => {
      const recoveredAt = new Date().toISOString();
      const cancelledBuyCount = this.cancelClosedCycleBuys(
        recoveredAt,
        "RECOVERY_FIRST_SELL",
      );

      const activeOrders = this.listActivePaperOrders();
      const errors = this.collectPaperStateErrors(
        activeOrders,
        this.getStrategyState(),
      );

      if (errors.length > 0) {
        this.paperValidationBlocked = true;
        this.database
          .prepare(
            "UPDATE strategy_state SET status = 'PAUSED', updated_at = ? WHERE id = 1",
          )
          .run(recoveredAt);
      }
      const result: PaperRecoveryResult = {
        passed: errors.length === 0,
        errors,
        activeOrderCount: activeOrders.length,
        cancelledBuyCount,
        recoveredAt,
      };
      this.writeAudit(
        result.passed ? "PAPER_RECOVERY_COMPLETED" : "PAPER_RECOVERY_FAILED",
        "strategy",
        "1",
        result,
      );
      return result;
    });
  }

  public previewTestFakBuy(input: ImmediateBuyIntent): TestFakBuyPreviewResult {
    const planning = this.planTestFakBuy(input, false);
    return {
      outcome: planning.outcome,
      preview: planning.preview,
      eventLock: planning.eventLock,
      eventStateVersion: planning.eventStateVersion,
    };
  }

  public executeTestFakBuy(input: ImmediateBuyIntent): ImmediateBuyExecution {
    this.assertPaperAccountingMutationAllowed();
    return this.transaction(() => {
      const { candidate, book } = input;
      const planning = this.planTestFakBuy(input, true);
      if (planning.outcome !== "READY" || planning.preview === null) {
        return emptyTestFakBuy(
          planning.outcome === "NO_FILL" ? "NO_FILL" : "BLOCKED",
        );
      }
      const plan = planning.preview.plan;
      const maxSpendMicros = planning.maxSpendMicros;

      const now = new Date().toISOString();
      if (planning.startingNewCycle) {
        this.database
          .prepare(
            `UPDATE paper_positions
            SET first_sell_at = NULL, cycle_closed_at = NULL,
                cycle_spend_micros = 0, gross_buy_size_micros = 0,
                gross_buy_notional_micros = 0, updated_at = ?
            WHERE token_id = ?`,
          )
          .run(now, candidate.tokenId);
        this.writeAudit(
          "TEST_EVENT_CYCLE_AUTOMATICALLY_STARTED",
          "event",
          candidate.eventId,
          { activeTokenId: candidate.tokenId },
        );
      }
      this.upsertTestMarketMetadata(
        candidate,
        input.feeRateMicros,
        input.feeExponent,
        now,
      );
      if (planning.eventLock === null) {
        this.database
          .prepare(
            `INSERT INTO paper_event_locks(
              event_id, active_token_id, market_id, condition_id,
              cycle_budget_micros, state, locked_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
          )
          .run(
            candidate.eventId,
            candidate.tokenId,
            candidate.marketId,
            candidate.conditionId,
            input.orderBudgetMicros,
            now,
            now,
          );
        this.writeAudit("TEST_EVENT_LOCK_CREATED", "event", candidate.eventId, {
          activeTokenId: candidate.tokenId,
          marketId: candidate.marketId,
          conditionId: candidate.conditionId,
          cycleBudgetMicros: input.orderBudgetMicros,
        });
      }
      const orderId = randomUUID();
      const requestedSizeMicros = calculateOrderSizeMicros(
        maxSpendMicros,
        plan.fills[0]?.priceMicros ?? input.maxPriceMicros,
      );
      const status: PaperOrderStatus = plan.fullySpent ? "FILLED" : "CANCELLED";
      const originalSizeMicros = plan.fullySpent
        ? plan.grossFillSizeMicros
        : Math.max(requestedSizeMicros, plan.grossFillSizeMicros);
      this.database
        .prepare(
          `INSERT INTO paper_orders(
            id, token_id, condition_id, event_id, market_id, game_starts_at,
            market_opened_at, market_ends_at, side, price_micros,
            target_sell_price_micros, linked_buy_order_id,
            original_size_micros, filled_size_micros, queue_ahead_size_micros,
            observed_trade_size_micros, status, execution_kind,
            cash_limit_micros, fee_micros, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'BUY', ?, NULL, NULL, ?, ?, 0, 0,
            ?, 'FAK', ?, ?, ?, ?)`,
        )
        .run(
          orderId,
          candidate.tokenId,
          candidate.conditionId,
          candidate.eventId,
          candidate.marketId,
          candidate.gameStartsAt,
          candidate.openedAt,
          candidate.endsAt,
          input.maxPriceMicros,
          originalSizeMicros,
          plan.grossFillSizeMicros,
          status,
          maxSpendMicros,
          plan.feeMicros,
          now,
          now,
        );

      const createdSellOrders: PaperOrder[] = [];
      for (const [index, fill] of plan.fills.entries()) {
        const fillId = randomUUID();
        this.database
          .prepare(
            `INSERT INTO paper_fills(
              id, order_id, source_trade_id, price_micros, size_micros,
              net_size_micros, fee_micros, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            fillId,
            orderId,
            `TEST-FAK-BUY:${orderId}:${index}`,
            fill.priceMicros,
            fill.grossSizeMicros,
            fill.netSizeMicros,
            fill.feeMicros,
            now,
          );
        const sellOrderId = randomUUID();
        const targetPriceMicros =
          planning.preview.fills[index]?.targetPriceMicros ??
          calculateFixedSellPriceMicros(
            fill.priceMicros,
            book.tickSizeMicros,
            input.targetSellPriceSettings,
          );
        this.database
          .prepare(
            `INSERT INTO paper_orders(
              id, token_id, condition_id, event_id, market_id, game_starts_at,
              market_opened_at, market_ends_at, side, price_micros,
              target_sell_price_micros, linked_buy_order_id,
              original_size_micros, filled_size_micros,
              queue_ahead_size_micros, observed_trade_size_micros, status,
              execution_kind, cash_limit_micros, fee_micros,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SELL', ?, NULL, ?, ?, 0, 0, 0,
              'OPEN', 'TARGET', 0, 0, ?, ?)`,
          )
          .run(
            sellOrderId,
            candidate.tokenId,
            candidate.conditionId,
            candidate.eventId,
            candidate.marketId,
            candidate.gameStartsAt,
            candidate.openedAt,
            candidate.endsAt,
            targetPriceMicros,
            orderId,
            fill.netSizeMicros,
            now,
            now,
          );
        createdSellOrders.push(this.getPaperOrder(sellOrderId));
        this.writeAudit("TEST_EXIT_TARGET_CREATED", "paper_order", sellOrderId, {
          linkedBuyOrderId: orderId,
          targetPriceMicros,
          sizeMicros: fill.netSizeMicros,
        });
      }

      this.database
        .prepare(
          `INSERT INTO paper_positions(
            token_id, condition_id, quantity_micros, cost_micros,
            realized_pnl_micros, first_sell_at, cycle_closed_at,
            cycle_spend_micros, gross_buy_size_micros,
            gross_buy_notional_micros, updated_at
          ) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?)
          ON CONFLICT(token_id) DO UPDATE SET
            quantity_micros = quantity_micros + excluded.quantity_micros,
            cost_micros = cost_micros + excluded.cost_micros,
            cycle_spend_micros = cycle_spend_micros + excluded.cycle_spend_micros,
            gross_buy_size_micros = gross_buy_size_micros + excluded.gross_buy_size_micros,
            gross_buy_notional_micros = gross_buy_notional_micros + excluded.gross_buy_notional_micros,
            updated_at = excluded.updated_at`,
        )
        .run(
          candidate.tokenId,
          candidate.conditionId,
          plan.netFillSizeMicros,
          plan.spentMicros,
          plan.spentMicros,
          plan.grossFillSizeMicros,
          plan.spentMicros,
          now,
        );
      this.database
        .prepare(
          `UPDATE strategy_state
          SET available_cash_micros = available_cash_micros - ?,
              updated_at = ? WHERE id = 1`,
        )
        .run(plan.spentMicros, now);
      this.writeAudit("TEST_FAK_BUY_EXECUTED", "paper_order", orderId, {
        candidateId: candidate.candidateId,
        outcome: plan.fullySpent ? "FILLED" : "PARTIAL",
        spentMicros: plan.spentMicros,
        grossFillSizeMicros: plan.grossFillSizeMicros,
        netFillSizeMicros: plan.netFillSizeMicros,
        feeMicros: plan.feeMicros,
        bookVersion: book.bookVersion,
      });
      this.recordTestBookConsumption(
        candidate.tokenId,
        book.bookVersion,
        "ASK",
        plan.fills.map((fill) => ({
          priceMicros: fill.priceMicros,
          sizeMicros: fill.grossSizeMicros,
        })),
        now,
      );
      return {
        outcome: plan.fullySpent ? "FILLED" : "PARTIAL",
        order: this.getPaperOrder(orderId),
        createdSellOrders,
        spentMicros: plan.spentMicros,
        feeMicros: plan.feeMicros,
        consumedAsks: plan.fills.map((fill) => ({
          priceMicros: fill.priceMicros,
          sizeMicros: fill.grossSizeMicros,
        })),
      };
    });
  }

  public executeTestFakSells(input: {
    tokenId: string;
    bookVersion: string;
    bids: readonly BookLevel[];
    minOrderSizeMicros: number;
    feeRateMicros: number;
    feeExponent: number;
  }): TargetSellExecution {
    // A validation pause blocks new exposure, but an existing position must
    // still be allowed to reduce risk at its already-recorded target price.
    return this.transaction(() => {
      if (input.bookVersion.trim().length === 0) {
        return emptyTestFakSell();
      }
      const availableBids = this.availableTestBookLevels(
        input.tokenId,
        input.bookVersion,
        "BID",
        input.bids,
      );
      let filledSizeMicros = 0;
      let grossProceedsMicros = 0;
      let netProceedsMicros = 0;
      let feeMicros = 0;
      let filledOrderCount = 0;
      const consumedBids: ConsumedBookLevel[] = [];
      const targets = this.listActivePaperOrders(input.tokenId)
        .filter(
          (order) => order.side === "SELL" && order.executionKind === "TARGET",
        )
        .sort(
          (left, right) =>
            left.priceMicros - right.priceMicros ||
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id),
        );
      const targetPlans = planFakSellTargets({
        bids: availableBids,
        targets: targets.map((order, targetIndex) => ({
          targetIndex,
          minPriceMicros: order.priceMicros,
          availableSizeMicros:
            order.originalSizeMicros - order.filledSizeMicros,
        })),
        minOrderSizeMicros: input.minOrderSizeMicros,
        feeRateMicros: input.feeRateMicros,
        feeExponent: input.feeExponent,
      });

      for (const plan of targetPlans) {
        const order = targets[plan.targetIndex];
        if (order === undefined) {
          throw new Error("FAK sell target references an unknown paper order");
        }

        const now = new Date().toISOString();
        for (const [index, fill] of plan.fills.entries()) {
          consumedBids.push({
            priceMicros: fill.priceMicros,
            sizeMicros: fill.sizeMicros,
          });
          this.database
            .prepare(
              `INSERT INTO paper_fills(
                id, order_id, source_trade_id, price_micros, size_micros,
                net_size_micros, fee_micros, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              order.id,
              `TEST-FAK-SELL:${order.id}:${order.filledSizeMicros}:${index}`,
              fill.priceMicros,
              fill.sizeMicros,
              fill.sizeMicros,
              fill.feeMicros,
              now,
            );
        }
        const nextFilledSizeMicros = order.filledSizeMicros + plan.filledSizeMicros;
        const nextStatus: PaperOrderStatus =
          nextFilledSizeMicros === order.originalSizeMicros
            ? "FILLED"
            : "PARTIALLY_FILLED";
        this.database
          .prepare(
            `UPDATE paper_orders
            SET filled_size_micros = ?, status = ?,
                fee_micros = fee_micros + ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            nextFilledSizeMicros,
            nextStatus,
            plan.feeMicros,
            now,
            order.id,
          );
        this.applyTestFakSellAccounting(
          order.tokenId,
          plan.filledSizeMicros,
          plan.netProceedsMicros,
          now,
        );
        filledSizeMicros += plan.filledSizeMicros;
        grossProceedsMicros += plan.grossProceedsMicros;
        netProceedsMicros += plan.netProceedsMicros;
        feeMicros += plan.feeMicros;
        filledOrderCount += 1;
        this.writeAudit("TEST_FAK_SELL_EXECUTED", "paper_order", order.id, {
          filledSizeMicros: plan.filledSizeMicros,
          grossProceedsMicros: plan.grossProceedsMicros,
          netProceedsMicros: plan.netProceedsMicros,
          feeMicros: plan.feeMicros,
        });
      }

      if (filledSizeMicros > 0) {
        const completedAt = new Date().toISOString();
        this.cancelActiveBuysForToken(
          input.tokenId,
          completedAt,
          "FIRST_SELL",
        );
        this.releasePaperEventLockIfClosedForToken(input.tokenId, completedAt);
      }
      this.recordTestBookConsumption(
        input.tokenId,
        input.bookVersion,
        "BID",
        consumedBids,
        new Date().toISOString(),
      );
      return {
        filledSizeMicros,
        grossProceedsMicros,
        netProceedsMicros,
        feeMicros,
        filledOrderCount,
        consumedBids,
      };
    });
  }

  public placePaperBuy(
    candidate: TradeCandidate,
    totalBudgetMicros: number,
  ): PaperOrder {
    this.assertPaperAccountingMutationAllowed();
    return this.transaction(() => {
      const state = this.getStrategyState();
      if (state.status !== "RUNNING") {
        throw new Error("Paper strategy must be running before placing orders");
      }
      if (
        candidate.gameStartsAt !== null &&
        Date.parse(candidate.gameStartsAt) <= Date.now()
      ) {
        throw new Error("Paper buy is blocked because the game has started");
      }

      const eventLock = this.getPaperEventLock(candidate.eventId);
      if (eventLock?.state === "LEGACY_CONFLICT") {
        throw new Error("Event has unresolved legacy conflicting positions");
      }
      if (
        eventLock?.state === "ACTIVE" &&
        (eventLock.activeTokenId !== candidate.tokenId ||
          eventLock.marketId !== candidate.marketId ||
          eventLock.conditionId !== candidate.conditionId)
      ) {
        throw new Error("Event is locked to another token");
      }

      const closedCycle = this.database
        .prepare(
          `SELECT first_sell_at, cycle_closed_at
          FROM paper_positions WHERE token_id = ?`,
        )
        .get(candidate.tokenId) as
        | { first_sell_at: string | null; cycle_closed_at: string | null }
        | undefined;
      if (closedCycle?.first_sell_at) {
        throw new Error("This token already recorded its first sell in this strategy cycle");
      }
      if (closedCycle?.cycle_closed_at) {
        throw new Error("This token's market has already been settled");
      }

      const settledMarket = this.database
        .prepare(
          "SELECT 1 FROM paper_settlements WHERE condition_id = ? AND status = 'SETTLED'",
        )
        .get(candidate.conditionId);
      if (settledMarket !== undefined) {
        throw new Error("This market has already been settled");
      }

      const activeOrder = this.database
        .prepare(
          `SELECT id FROM paper_orders
          WHERE token_id = ? AND side = 'BUY'
            AND status IN ('OPEN', 'PARTIALLY_FILLED') LIMIT 1`,
        )
        .get(candidate.tokenId);
      if (activeOrder !== undefined) {
        throw new Error("An active paper buy already exists for this token");
      }

      const reservedCostMicros = calculateOrderCostMicros(
        candidate.makerBuyPriceMicros,
        candidate.orderSizeMicros,
      );
      if (eventLock?.state === "ACTIVE") {
        const activePosition = this.database
          .prepare(
            `SELECT quantity_micros, first_sell_at, cycle_closed_at,
              cycle_spend_micros
            FROM paper_positions WHERE token_id = ?`,
          )
          .get(candidate.tokenId) as
          | {
              quantity_micros: number;
              first_sell_at: string | null;
              cycle_closed_at: string | null;
              cycle_spend_micros: number;
            }
          | undefined;
        if (
          activePosition === undefined ||
          activePosition.quantity_micros <= 0 ||
          activePosition.first_sell_at !== null ||
          activePosition.cycle_closed_at !== null
        ) {
          throw new Error("Event is not in an accumulating cycle");
        }
        if (
          activePosition.cycle_spend_micros + reservedCostMicros >
          eventLock.cycleBudgetMicros
        ) {
          throw new Error("Event cycle budget would be exceeded");
        }
      } else {
        const existingEventPosition = this.database
          .prepare(
            `SELECT pp.token_id
            FROM paper_positions pp
            JOIN paper_market_metadata pm ON pm.token_id = pp.token_id
            WHERE pm.event_id = ? AND pp.quantity_micros > 0
            LIMIT 1`,
          )
          .get(candidate.eventId);
        if (existingEventPosition !== undefined) {
          throw new Error("Event has an unlocked paper position");
        }
      }
      const exposureMicros =
        state.reservedCashMicros + state.positionCostMicros + reservedCostMicros;
      if (reservedCostMicros > state.availableCashMicros) {
        throw new Error("Insufficient paper cash");
      }
      if (exposureMicros > totalBudgetMicros) {
        throw new Error("Strategy budget would be exceeded");
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      this.database
        .prepare(
        `INSERT INTO paper_market_metadata(
          token_id, event_id, event_slug, event_title, market_id,
          market_question, direction, opened_at, ends_at, result_count,
          duration_days, category, category_ids_json, category_labels_json,
          updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(token_id) DO UPDATE SET
            event_id = excluded.event_id,
            event_slug = excluded.event_slug,
            event_title = excluded.event_title,
            market_id = excluded.market_id,
            market_question = excluded.market_question,
            direction = excluded.direction,
            opened_at = excluded.opened_at,
            ends_at = excluded.ends_at,
            result_count = excluded.result_count,
            duration_days = excluded.duration_days,
            category = excluded.category,
            category_ids_json = excluded.category_ids_json,
            category_labels_json = excluded.category_labels_json,
            updated_at = excluded.updated_at`,
        )
        .run(
          candidate.tokenId,
          candidate.eventId,
          candidate.eventSlug,
          candidate.eventTitle,
          candidate.marketId,
          candidate.marketQuestion,
          candidate.direction,
          candidate.openedAt,
          candidate.endsAt,
          candidate.resultCount,
          candidate.durationDays,
          candidate.category,
          JSON.stringify(candidate.categoryIds),
          JSON.stringify(candidate.categoryLabels),
          now,
        );
      this.database
        .prepare(
          `INSERT INTO paper_orders(
            id, token_id, condition_id, event_id, market_id, game_starts_at,
            market_opened_at, market_ends_at, side,
            price_micros, target_sell_price_micros, linked_buy_order_id,
            original_size_micros, filled_size_micros, queue_ahead_size_micros,
            observed_trade_size_micros, status, execution_kind,
            cash_limit_micros, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'BUY', ?, ?, NULL, ?, 0, ?, 0,
            'OPEN', 'LEGACY_MAKER', ?, ?, ?)`,
        )
        .run(
          id,
          candidate.tokenId,
          candidate.conditionId,
          candidate.eventId,
          candidate.marketId,
          candidate.gameStartsAt,
          candidate.openedAt,
          candidate.endsAt,
          candidate.makerBuyPriceMicros,
          candidate.fixedSellPriceMicros,
          candidate.orderSizeMicros,
          candidate.queueAheadSizeMicros,
          reservedCostMicros,
          now,
          now,
        );
      this.database
        .prepare(
          `UPDATE strategy_state
          SET available_cash_micros = available_cash_micros - ?,
              reserved_cash_micros = reserved_cash_micros + ?,
              updated_at = ? WHERE id = 1`,
        )
        .run(reservedCostMicros, reservedCostMicros, now);
      this.writeAudit("PAPER_BUY_PLACED", "paper_order", id, {
        candidateId: candidate.candidateId,
        reservedCostMicros,
      });

      return this.getPaperOrder(id);
    });
  }

  public applyPaperTrade(input: {
    orderId: string;
    sourceTradeId: string;
    tradePriceMicros: number;
    tradeSizeMicros: number;
    dataComplete: boolean;
    sellRealQueueAheadSizeMicros?: number;
  }): AppliedPaperTrade {
    return this.transaction(() => {
      const order = this.getPaperOrder(input.orderId);
      if (!input.dataComplete || !["OPEN", "PARTIALLY_FILLED"].includes(order.status)) {
        return {
          order,
          createdSellOrder: null,
          duplicate: false,
          incrementalFillSizeMicros: 0,
        };
      }
      if (
        order.side === "BUY" &&
        (this.paperValidationBlocked ||
          this.getStrategyState().status !== "RUNNING")
      ) {
        return {
          order,
          createdSellOrder: null,
          duplicate: false,
          incrementalFillSizeMicros: 0,
        };
      }

      const duplicate = this.database
        .prepare(
          "SELECT 1 FROM processed_market_trades WHERE order_id = ? AND trade_id = ?",
        )
        .get(order.id, input.sourceTradeId);
      if (duplicate !== undefined) {
        return {
          order,
          createdSellOrder: null,
          duplicate: true,
          incrementalFillSizeMicros: 0,
        };
      }

      if (input.tradePriceMicros !== order.priceMicros) {
        return {
          order,
          createdSellOrder: null,
          duplicate: false,
          incrementalFillSizeMicros: 0,
        };
      }

      const now = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO processed_market_trades(order_id, trade_id, token_id, processed_at)
          VALUES (?, ?, ?, ?)`,
        )
        .run(order.id, input.sourceTradeId, order.tokenId, now);

      const fill = calculateConservativePaperFill({
        queueAheadSizeMicros: order.queueAheadSizeMicros,
        baselineFilledSizeMicros: order.queueBaselineFilledSizeMicros,
        observedTradeSizeMicros: order.observedTradeSizeMicros,
        originalSizeMicros: order.originalSizeMicros,
        filledSizeMicros: order.filledSizeMicros,
        incomingTradeSizeMicros: input.tradeSizeMicros,
      });
      const status: PaperOrderStatus =
        fill.nextFilledSizeMicros === order.originalSizeMicros
          ? "FILLED"
          : fill.nextFilledSizeMicros > 0
            ? "PARTIALLY_FILLED"
            : "OPEN";

      this.database
        .prepare(
          `UPDATE paper_orders
          SET observed_trade_size_micros = ?, filled_size_micros = ?,
              status = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          fill.nextObservedTradeSizeMicros,
          fill.nextFilledSizeMicros,
          status,
          now,
          order.id,
        );

      let createdSellOrder: PaperOrder | null = null;
      if (fill.incrementalFillSizeMicros > 0) {
        const fillId = randomUUID();
        this.database
          .prepare(
            `INSERT INTO paper_fills(
              id, order_id, source_trade_id, price_micros, size_micros,
              net_size_micros, fee_micros, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
          )
          .run(
            fillId,
            order.id,
            input.sourceTradeId,
            order.priceMicros,
            fill.incrementalFillSizeMicros,
            fill.incrementalFillSizeMicros,
            now,
          );

        if (order.side === "BUY") {
          this.applyBuyFill(order, fill.incrementalFillSizeMicros, now);
          createdSellOrder = this.createPaperSellForBuyFill(
            order,
            fill.incrementalFillSizeMicros,
            input.sellRealQueueAheadSizeMicros ?? 0,
            now,
          );
        } else {
          this.applySellFill(order, fill.incrementalFillSizeMicros, now);
        }

        this.writeAudit("PAPER_FILL_RECORDED", "paper_fill", fillId, {
          orderId: order.id,
          sourceTradeId: input.sourceTradeId,
          sizeMicros: fill.incrementalFillSizeMicros,
        });
      }

      return {
        order: this.getPaperOrder(order.id),
        createdSellOrder,
        duplicate: false,
        incrementalFillSizeMicros: fill.incrementalFillSizeMicros,
      };
    });
  }

  private createPaperSellForBuyFill(
    buyOrder: PaperOrder,
    sizeMicros: number,
    realQueueAheadSizeMicros: number,
    now: string,
  ): PaperOrder {
    if (buyOrder.targetSellPriceMicros === null) {
      throw new Error("Paper buy order is missing its target sell price");
    }

    const existingVirtualQueue = this.listActivePaperOrders(buyOrder.tokenId)
      .filter(
        (order) =>
          order.side === "SELL" &&
          order.priceMicros === buyOrder.targetSellPriceMicros,
      )
      .reduce(
        (sum, order) =>
          sum + order.originalSizeMicros - order.filledSizeMicros,
        0,
      );
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO paper_orders(
          id, token_id, condition_id, event_id, market_id, game_starts_at,
          market_opened_at, market_ends_at, side,
          price_micros, target_sell_price_micros, linked_buy_order_id,
          original_size_micros, filled_size_micros, queue_ahead_size_micros,
          observed_trade_size_micros, status, execution_kind,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SELL', ?, NULL, ?, ?, 0, ?, 0,
          'OPEN', 'LEGACY_MAKER', ?, ?)`,
      )
      .run(
        id,
        buyOrder.tokenId,
        buyOrder.conditionId,
        buyOrder.eventId,
        buyOrder.marketId,
        buyOrder.gameStartsAt,
        buyOrder.marketOpenedAt,
        buyOrder.marketEndsAt,
        buyOrder.targetSellPriceMicros,
        buyOrder.id,
        sizeMicros,
        realQueueAheadSizeMicros + existingVirtualQueue,
        now,
        now,
      );
    this.writeAudit("PAPER_SELL_PLACED", "paper_order", id, {
      linkedBuyOrderId: buyOrder.id,
      sizeMicros,
    });
    return this.getPaperOrder(id);
  }

  private applyBuyFill(order: PaperOrder, sizeMicros: number, now: string): void {
    this.assertPaperAccountingMutationAllowed();
    const costMicros = calculateOrderCostMicros(order.priceMicros, sizeMicros);
    this.ensurePaperEventLockForBuyFill(order, costMicros, now);
    this.database
      .prepare(
        `INSERT INTO paper_positions(
          token_id, condition_id, quantity_micros, cost_micros,
          realized_pnl_micros, first_sell_at, cycle_closed_at,
          cycle_spend_micros, gross_buy_size_micros,
          gross_buy_notional_micros, updated_at
        ) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?)
        ON CONFLICT(token_id) DO UPDATE SET
          quantity_micros = quantity_micros + excluded.quantity_micros,
          cost_micros = cost_micros + excluded.cost_micros,
          cycle_spend_micros = cycle_spend_micros + excluded.cycle_spend_micros,
          gross_buy_size_micros = gross_buy_size_micros + excluded.gross_buy_size_micros,
          gross_buy_notional_micros = gross_buy_notional_micros + excluded.gross_buy_notional_micros,
          updated_at = excluded.updated_at`,
      )
      .run(
        order.tokenId,
        order.conditionId,
        sizeMicros,
        costMicros,
        costMicros,
        sizeMicros,
        costMicros,
        now,
      );
    this.database
      .prepare(
        `UPDATE strategy_state
        SET reserved_cash_micros = reserved_cash_micros - ?, updated_at = ?
        WHERE id = 1`,
      )
      .run(costMicros, now);
  }

  private ensurePaperEventLockForBuyFill(
    order: PaperOrder,
    incrementalCostMicros: number,
    now: string,
  ): void {
    const metadata = this.database
      .prepare(
        `SELECT event_id, market_id FROM paper_market_metadata
        WHERE token_id = ?`,
      )
      .get(order.tokenId) as
      | { event_id: string; market_id: string }
      | undefined;
    if (
      metadata === undefined ||
      metadata.event_id !== order.eventId ||
      metadata.market_id !== order.marketId
    ) {
      throw new Error("Paper buy Event identity does not match market metadata");
    }

    let eventLock = this.getPaperEventLock(order.eventId);
    if (eventLock === null) {
      const existingPosition = this.database
        .prepare(
          `SELECT pp.token_id
          FROM paper_positions pp
          JOIN paper_market_metadata pm ON pm.token_id = pp.token_id
          WHERE pm.event_id = ? AND pp.quantity_micros > 0
          LIMIT 1`,
        )
        .get(order.eventId);
      if (existingPosition !== undefined) {
        throw new Error("Event has a positive position without a lock");
      }
      const cycleBudgetMicros =
        order.cashLimitMicros > 0
          ? order.cashLimitMicros
          : calculateOrderCostMicros(
              order.priceMicros,
              order.originalSizeMicros,
            );
      this.database
        .prepare(
          `INSERT INTO paper_event_locks(
            event_id, active_token_id, market_id, condition_id,
            cycle_budget_micros, state, locked_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        )
        .run(
          order.eventId,
          order.tokenId,
          order.marketId,
          order.conditionId,
          cycleBudgetMicros,
          now,
          now,
        );
      this.writeAudit("TEST_EVENT_LOCK_CREATED", "event", order.eventId, {
        activeTokenId: order.tokenId,
        marketId: order.marketId,
        conditionId: order.conditionId,
        cycleBudgetMicros,
        executionKind: order.executionKind,
      });
      eventLock = this.getPaperEventLock(order.eventId);
    }

    if (eventLock?.state === "LEGACY_CONFLICT") {
      throw new Error("Event has unresolved legacy conflicting positions");
    }
    if (
      eventLock === null ||
      eventLock.activeTokenId !== order.tokenId ||
      eventLock.marketId !== order.marketId ||
      eventLock.conditionId !== order.conditionId
    ) {
      throw new Error("Event is locked to another token");
    }
    const position = this.database
      .prepare(
        `SELECT cycle_spend_micros, first_sell_at, cycle_closed_at
        FROM paper_positions WHERE token_id = ?`,
      )
      .get(order.tokenId) as
      | {
          cycle_spend_micros: number;
          first_sell_at: string | null;
          cycle_closed_at: string | null;
        }
      | undefined;
    if (position?.first_sell_at !== null && position?.first_sell_at !== undefined) {
      throw new Error("Event cannot buy again after its first sell");
    }
    if (position?.cycle_closed_at !== null && position?.cycle_closed_at !== undefined) {
      throw new Error("Event cycle is already closed");
    }
    if (
      (position?.cycle_spend_micros ?? 0) + incrementalCostMicros >
      eventLock.cycleBudgetMicros
    ) {
      throw new Error("Event cycle budget would be exceeded");
    }
    this.cancelActiveBuysForEventExceptToken(
      order.eventId,
      order.tokenId,
      now,
      "EVENT_WINNER_LOCKED",
    );
  }

  private applySellFill(order: PaperOrder, sizeMicros: number, now: string): void {
    const position = this.database
      .prepare(
        `SELECT quantity_micros, cost_micros, realized_pnl_micros
        FROM paper_positions WHERE token_id = ?`,
      )
      .get(order.tokenId) as
      | {
          quantity_micros: number;
          cost_micros: number;
          realized_pnl_micros: number;
        }
      | undefined;
    if (position === undefined || position.quantity_micros < sizeMicros) {
      throw new Error("Paper sell fill exceeds the available position");
    }

    const releasedCostMicros = Number(
      (BigInt(position.cost_micros) * BigInt(sizeMicros)) /
        BigInt(position.quantity_micros),
    );
    const proceedsMicros = calculateOrderCostMicros(order.priceMicros, sizeMicros);
    const realizedPnlMicros = proceedsMicros - releasedCostMicros;
    const remainingQuantity = position.quantity_micros - sizeMicros;
    const remainingCost = position.cost_micros - releasedCostMicros;

    this.database
      .prepare(
        `UPDATE paper_positions
        SET quantity_micros = ?, cost_micros = ?,
            realized_pnl_micros = realized_pnl_micros + ?,
            first_sell_at = COALESCE(first_sell_at, ?),
            cycle_closed_at = CASE WHEN ? = 0 THEN ? ELSE cycle_closed_at END,
            updated_at = ? WHERE token_id = ?`,
      )
      .run(
        remainingQuantity,
        remainingCost,
        realizedPnlMicros,
        now,
        remainingQuantity,
        now,
        now,
        order.tokenId,
      );
    this.database
      .prepare(
        `UPDATE strategy_state
        SET available_cash_micros = available_cash_micros + ?,
            realized_pnl_micros = realized_pnl_micros + ?,
            updated_at = ? WHERE id = 1`,
      )
      .run(proceedsMicros, realizedPnlMicros, now);
    this.cancelActiveBuysForToken(order.tokenId, now, "FIRST_SELL");
    this.releasePaperEventLockIfClosedForToken(order.tokenId, now);
  }

  private upsertTestMarketMetadata(
    candidate: TradeCandidate,
    feeRateMicros: number,
    feeExponent: number,
    now: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO paper_market_metadata(
          token_id, event_id, event_slug, event_title, market_id,
          market_question, direction, opened_at, ends_at, result_count,
          duration_days, category, category_ids_json, category_labels_json,
          fees_enabled, fee_rate_micros,
          fee_exponent, min_order_size_micros, tick_size_micros, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_id) DO UPDATE SET
          event_id = excluded.event_id,
          event_slug = excluded.event_slug,
          event_title = excluded.event_title,
          market_id = excluded.market_id,
          market_question = excluded.market_question,
          direction = excluded.direction,
          opened_at = excluded.opened_at,
          ends_at = excluded.ends_at,
          result_count = excluded.result_count,
          duration_days = excluded.duration_days,
          category = excluded.category,
          category_ids_json = excluded.category_ids_json,
          category_labels_json = excluded.category_labels_json,
          fees_enabled = excluded.fees_enabled,
          fee_rate_micros = excluded.fee_rate_micros,
          fee_exponent = excluded.fee_exponent,
          min_order_size_micros = excluded.min_order_size_micros,
          tick_size_micros = excluded.tick_size_micros,
          updated_at = excluded.updated_at`,
      )
      .run(
        candidate.tokenId,
        candidate.eventId,
        candidate.eventSlug,
        candidate.eventTitle,
        candidate.marketId,
        candidate.marketQuestion,
        candidate.direction,
        candidate.openedAt,
        candidate.endsAt,
        candidate.resultCount,
        candidate.durationDays,
        candidate.category,
        JSON.stringify(candidate.categoryIds),
        JSON.stringify(candidate.categoryLabels),
        feeRateMicros > 0 ? 1 : 0,
        feeRateMicros,
        feeExponent,
        candidate.minOrderSizeMicros,
        candidate.tickSizeMicros,
        now,
      );
  }

  private planTestFakBuy(
    input: ImmediateBuyIntent,
    requireRunning: boolean,
  ): TestFakBuyPlanningResult {
    const { candidate, book } = input;
    const state = this.getStrategyState();
    const eventLock = this.getPaperEventLock(candidate.eventId);
    const position = this.database
      .prepare(
        `SELECT quantity_micros, cost_micros, first_sell_at,
          cycle_closed_at, cycle_spend_micros, updated_at
        FROM paper_positions WHERE token_id = ?`,
      )
      .get(candidate.tokenId) as
      | {
          quantity_micros: number;
          cost_micros: number;
          first_sell_at: string | null;
          cycle_closed_at: string | null;
          cycle_spend_micros: number;
          updated_at: string;
        }
      | undefined;
    const eventStateVersion = JSON.stringify({
      strategyUpdatedAt: state.updatedAt,
      availableCashMicros: state.availableCashMicros,
      eventLock,
      position: position ?? null,
    });
    const result = (
      outcome: TestFakBuyPreviewResult["outcome"],
      preview: FakBuyPreview | null = null,
      options: {
        availableBids?: BookLevel[];
        availableAsks?: BookLevel[];
        startingNewCycle?: boolean;
        maxSpendMicros?: number;
      } = {},
    ): TestFakBuyPlanningResult => ({
      outcome,
      preview,
      eventLock,
      eventStateVersion,
      availableBids: options.availableBids ?? [],
      availableAsks: options.availableAsks ?? [],
      startingNewCycle: options.startingNewCycle ?? false,
      maxSpendMicros: options.maxSpendMicros ?? 0,
    });

    if (
      (requireRunning && state.status !== "RUNNING") ||
      candidate.tokenId !== book.tokenId ||
      candidate.conditionId !== book.conditionId ||
      candidate.isNegativeRisk !== book.isNegativeRisk ||
      book.bookVersion.trim().length === 0
    ) {
      return result("BLOCKED");
    }
    if (
      this.database
        .prepare(
          "SELECT 1 FROM paper_settlements WHERE condition_id = ? AND status = 'SETTLED'",
        )
        .get(candidate.conditionId) !== undefined
    ) {
      return result("BLOCKED");
    }
    if (
      this.listActivePaperOrders(candidate.tokenId).some(
        (order) => order.side === "BUY",
      )
    ) {
      return result("BLOCKED");
    }

    let startingNewCycle = false;
    let cycleBudgetMicros = input.orderBudgetMicros;
    let cycleSpendMicros = 0;
    if (eventLock?.state === "LEGACY_CONFLICT") {
      return result("BLOCKED");
    }
    if (eventLock?.state === "ACTIVE") {
      if (
        eventLock.activeTokenId !== candidate.tokenId ||
        eventLock.marketId !== candidate.marketId ||
        eventLock.conditionId !== candidate.conditionId ||
        position === undefined ||
        position.quantity_micros <= 0 ||
        position.cost_micros <= 0 ||
        position.first_sell_at !== null ||
        position.cycle_closed_at !== null
      ) {
        return result("BLOCKED");
      }
      cycleBudgetMicros = eventLock.cycleBudgetMicros;
      cycleSpendMicros = position.cycle_spend_micros;
    } else {
      const existingEventPosition = this.database
        .prepare(
          `SELECT pp.token_id
          FROM paper_positions pp
          JOIN paper_market_metadata pm ON pm.token_id = pp.token_id
          WHERE pm.event_id = ? AND pp.quantity_micros > 0
          LIMIT 1`,
        )
        .get(candidate.eventId);
      if (existingEventPosition !== undefined) {
        return result("BLOCKED");
      }
      if (position !== undefined) {
        if (position.quantity_micros !== 0 || position.cost_micros !== 0) {
          return result("BLOCKED");
        }
        if (position.first_sell_at !== null || position.cycle_closed_at !== null) {
          if (position.cycle_closed_at === null) {
            return result("BLOCKED");
          }
          startingNewCycle = true;
        } else if (position.cycle_spend_micros !== 0) {
          return result("BLOCKED");
        }
      }
      if (state.availableCashMicros < input.orderBudgetMicros) {
        return result("BLOCKED");
      }
    }

    const remainingCycleBudgetMicros = Math.max(
      0,
      cycleBudgetMicros - cycleSpendMicros,
    );
    const maxSpendMicros = Math.min(
      remainingCycleBudgetMicros,
      state.availableCashMicros,
    );
    if (maxSpendMicros <= 0) {
      return result("NO_FILL", null, { startingNewCycle, maxSpendMicros });
    }
    const availableBids = this.availableTestBookLevels(
      candidate.tokenId,
      book.bookVersion,
      "BID",
      book.bids,
    );
    const availableAsks = this.availableTestBookLevels(
      candidate.tokenId,
      book.bookVersion,
      "ASK",
      book.asks,
    );
    const currentBestBid = bestBidLevel(availableBids)?.priceMicros ?? null;
    const currentBestAsk = bestAskLevel(availableAsks)?.priceMicros ?? null;
    if (
      !isMarketEligible(
        {
          ...candidate,
          bookReady: true,
          bestBidMicros: currentBestBid,
          bestAskMicros: currentBestAsk,
          minOrderSizeMicros: book.minOrderSizeMicros,
          tickSizeMicros: book.tickSizeMicros,
        },
        {
          ...input.eligibility,
          orderBudgetMicros: maxSpendMicros,
        },
        new Date(),
      )
    ) {
      return result("BLOCKED", null, {
        availableBids,
        availableAsks,
        startingNewCycle,
        maxSpendMicros,
      });
    }
    const preview = previewFakBuy({
      asks: availableAsks,
      bids: availableBids,
      maxPriceMicros: input.maxPriceMicros,
      maxSpendMicros,
      cycleBudgetMicros,
      minOrderSizeMicros: book.minOrderSizeMicros,
      tickSizeMicros: book.tickSizeMicros,
      feeRateMicros: input.feeRateMicros,
      feeExponent: input.feeExponent,
      ...(input.targetSellPriceSettings === undefined
        ? {}
        : { targetSellPriceSettings: input.targetSellPriceSettings }),
    });
    if (preview === null) {
      return result("NO_FILL", null, {
        availableBids,
        availableAsks,
        startingNewCycle,
        maxSpendMicros,
      });
    }
    return result("READY", preview, {
      availableBids,
      availableAsks,
      startingNewCycle,
      maxSpendMicros,
    });
  }

  private availableTestBookLevels(
    tokenId: string,
    bookVersion: string,
    side: "ASK" | "BID",
    levels: readonly BookLevel[],
  ): BookLevel[] {
    const consumedRows = this.database
      .prepare(
        `SELECT price_micros, size_micros
        FROM test_order_book_consumption
        WHERE token_id = ? AND book_version = ? AND side = ?`,
      )
      .all(tokenId, bookVersion, side) as Array<{
      price_micros: number;
      size_micros: number;
    }>;
    const consumedByPrice = new Map(
      consumedRows.map((row) => [row.price_micros, row.size_micros]),
    );
    return levels
      .map((level) => ({
        ...level,
        sizeMicros: Math.max(
          0,
          level.sizeMicros - (consumedByPrice.get(level.priceMicros) ?? 0),
        ),
      }))
      .filter((level) => level.sizeMicros > 0);
  }

  private recordTestBookConsumption(
    tokenId: string,
    bookVersion: string,
    side: "ASK" | "BID",
    consumed: readonly ConsumedBookLevel[],
    now: string,
  ): void {
    const totals = new Map<number, number>();
    for (const level of consumed) {
      if (level.sizeMicros <= 0) continue;
      totals.set(
        level.priceMicros,
        (totals.get(level.priceMicros) ?? 0) + level.sizeMicros,
      );
    }
    const statement = this.database.prepare(
      `INSERT INTO test_order_book_consumption(
        token_id, book_version, side, price_micros, size_micros, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_id, book_version, side, price_micros) DO UPDATE SET
        size_micros = size_micros + excluded.size_micros,
        updated_at = excluded.updated_at`,
    );
    for (const [priceMicros, sizeMicros] of totals) {
      statement.run(
        tokenId,
        bookVersion,
        side,
        priceMicros,
        sizeMicros,
        now,
      );
    }
  }

  private applyTestFakSellAccounting(
    tokenId: string,
    sizeMicros: number,
    netProceedsMicros: number,
    now: string,
  ): void {
    const position = this.database
      .prepare(
        `SELECT quantity_micros, cost_micros
        FROM paper_positions WHERE token_id = ?`,
      )
      .get(tokenId) as
      | { quantity_micros: number; cost_micros: number }
      | undefined;
    if (position === undefined || position.quantity_micros < sizeMicros) {
      throw new Error("TEST FAK sell exceeds the available position");
    }

    const releasedCostMicros =
      sizeMicros === position.quantity_micros
        ? position.cost_micros
        : Number(
            (BigInt(position.cost_micros) * BigInt(sizeMicros)) /
              BigInt(position.quantity_micros),
          );
    const realizedPnlMicros = netProceedsMicros - releasedCostMicros;
    const remainingQuantityMicros = position.quantity_micros - sizeMicros;
    const remainingCostMicros = position.cost_micros - releasedCostMicros;
    this.database
      .prepare(
        `UPDATE paper_positions
        SET quantity_micros = ?, cost_micros = ?,
            realized_pnl_micros = realized_pnl_micros + ?,
            first_sell_at = COALESCE(first_sell_at, ?),
            cycle_closed_at = CASE WHEN ? = 0 THEN ? ELSE cycle_closed_at END,
            updated_at = ? WHERE token_id = ?`,
      )
      .run(
        remainingQuantityMicros,
        remainingCostMicros,
        realizedPnlMicros,
        now,
        remainingQuantityMicros,
        now,
        now,
        tokenId,
      );
    this.database
      .prepare(
        `UPDATE strategy_state
        SET available_cash_micros = available_cash_micros + ?,
            realized_pnl_micros = realized_pnl_micros + ?,
            updated_at = ? WHERE id = 1`,
      )
      .run(netProceedsMicros, realizedPnlMicros, now);
  }

  private cancelActiveBuysForToken(
    tokenId: string,
    now: string,
    reason: string,
  ): number {
    if (this.paperValidationBlocked) {
      return 0;
    }
    const orders = this.listActivePaperOrders(tokenId).filter(
      (order) => order.side === "BUY",
    );
    for (const order of orders) {
      this.cancelPaperBuy(order, now, reason);
    }
    return orders.length;
  }

  private cancelActiveBuysForEventExceptToken(
    eventId: string,
    activeTokenId: string,
    now: string,
    reason: string,
  ): number {
    if (this.paperValidationBlocked) {
      return 0;
    }
    const orders = this.listActivePaperOrders().filter(
      (order) =>
        order.side === "BUY" &&
        order.eventId === eventId &&
        order.tokenId !== activeTokenId,
    );
    for (const order of orders) {
      this.cancelPaperBuy(order, now, reason);
    }
    return orders.length;
  }

  private releasePaperEventLockIfClosedForToken(
    tokenId: string,
    now: string,
  ): boolean {
    const row = this.database
      .prepare(
        `SELECT pel.event_id
        FROM paper_event_locks pel
        LEFT JOIN paper_market_metadata pm ON pm.event_id = pel.event_id
        WHERE pel.active_token_id = ? OR pm.token_id = ?
        ORDER BY pel.event_id
        LIMIT 1`,
      )
      .get(tokenId, tokenId) as { event_id: string } | undefined;
    return row === undefined
      ? false
      : this.releasePaperEventLockIfClosed(row.event_id, now);
  }

  private releasePaperEventLockIfClosed(eventId: string, now: string): boolean {
    const eventLock = this.getPaperEventLockRow(eventId);
    if (eventLock === undefined) {
      return false;
    }
    const position = this.database
      .prepare(
        `SELECT 1
        FROM paper_positions pp
        JOIN paper_market_metadata pm ON pm.token_id = pp.token_id
        WHERE pm.event_id = ? AND pp.quantity_micros > 0
        LIMIT 1`,
      )
      .get(eventId);
    const target = this.database
      .prepare(
        `SELECT 1 FROM paper_orders
        WHERE event_id = ? AND side = 'SELL'
          AND status IN ('OPEN', 'PARTIALLY_FILLED')
        LIMIT 1`,
      )
      .get(eventId);
    if (position !== undefined || target !== undefined) {
      return false;
    }
    this.database.prepare("DELETE FROM paper_event_locks WHERE event_id = ?").run(
      eventId,
    );
    this.writeAudit("TEST_EVENT_LOCK_RELEASED", "event", eventId, {
      previousState: eventLock.state,
      releasedAt: now,
    });
    return true;
  }

  private cancelClosedCycleBuys(now: string, reason: string): number {
    const closedTokens = this.database
      .prepare(
        `SELECT token_id FROM paper_positions
        WHERE first_sell_at IS NOT NULL OR cycle_closed_at IS NOT NULL`,
      )
      .all() as unknown as Array<{ token_id: string }>;
    return closedTokens.reduce(
      (count, row) =>
        count + this.cancelActiveBuysForToken(row.token_id, now, reason),
      0,
    );
  }

  private cancelPaperBuy(order: PaperOrder, now: string, reason: string): void {
    this.assertPaperAccountingMutationAllowed();
    const remainingSize = order.originalSizeMicros - order.filledSizeMicros;
    const releasedCash = calculateOrderCostMicros(
      order.priceMicros,
      remainingSize,
    );
    this.database
      .prepare(
        "UPDATE paper_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ?",
      )
      .run(now, order.id);
    this.database
      .prepare(
        `UPDATE strategy_state
        SET available_cash_micros = available_cash_micros + ?,
            reserved_cash_micros = reserved_cash_micros - ?,
            updated_at = ? WHERE id = 1`,
      )
      .run(releasedCash, releasedCash, now);
    this.writeAudit("PAPER_BUY_CANCELLED", "paper_order", order.id, {
      reason,
      releasedCash,
    });
  }

  private cancelPaperSell(order: PaperOrder, now: string, reason: string): void {
    this.assertPaperAccountingMutationAllowed();
    this.database
      .prepare(
        "UPDATE paper_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ?",
      )
      .run(now, order.id);
    this.writeAudit("PAPER_SELL_CANCELLED", "paper_order", order.id, { reason });
  }

  private getPaperTradingPreferencesRow():
    | {
        binary_enabled: number;
        ternary_enabled: number;
        multi_enabled: number;
        min_buy_price_micros: number;
        max_buy_price_micros: number;
        target_sell_price_increase_micros: number;
        target_sell_price_multiplier_micros: number;
        min_market_duration_days: number;
        max_market_duration_days: number;
        max_market_progress_percent: number;
        min_bid_ask_ratio_percent: number;
        candidates_selected_by_default: number;
        all_categories_enabled: number;
        selected_categories_json: string;
        candidate_sort_direction: "ASC" | "DESC";
        order_budget_micros: number;
        updated_at: string;
      }
    | undefined {
    return this.database
      .prepare(
        `SELECT binary_enabled, ternary_enabled, multi_enabled,
          min_buy_price_micros, max_buy_price_micros,
          target_sell_price_increase_micros,
          target_sell_price_multiplier_micros,
          min_market_duration_days, max_market_duration_days,
          max_market_progress_percent,
          min_bid_ask_ratio_percent,
          candidates_selected_by_default, all_categories_enabled,
          selected_categories_json, candidate_sort_direction,
          order_budget_micros, updated_at
        FROM paper_trading_preferences WHERE id = 1`,
      )
      .get() as
      | {
          binary_enabled: number;
          ternary_enabled: number;
          multi_enabled: number;
          min_buy_price_micros: number;
          max_buy_price_micros: number;
          target_sell_price_increase_micros: number;
          target_sell_price_multiplier_micros: number;
          min_market_duration_days: number;
          max_market_duration_days: number;
          max_market_progress_percent: number;
          min_bid_ask_ratio_percent: number;
          candidates_selected_by_default: number;
          all_categories_enabled: number;
          selected_categories_json: string;
          candidate_sort_direction: "ASC" | "DESC";
          order_budget_micros: number;
          updated_at: string;
        }
      | undefined;
  }

  private getPaperEventLockRow(eventId: string): PaperEventLockRow | undefined {
    return this.database
      .prepare(
        `SELECT event_id, active_token_id, market_id, condition_id,
          cycle_budget_micros, state, locked_at, updated_at
        FROM paper_event_locks WHERE event_id = ?`,
      )
      .get(eventId) as PaperEventLockRow | undefined;
  }

  private getPaperSettlementRow(
    conditionId: string,
  ): PaperSettlementRow | undefined {
    return this.database
      .prepare(
        `SELECT condition_id, market_id, event_id, status,
          resolution_status, winning_token_id, winning_outcome, outcome,
          redemption_status, position_cost_micros, payout_micros,
          realized_pnl_micros, attempt_count, last_error, settled_at,
          redeemed_at, created_at, updated_at
        FROM paper_settlements WHERE condition_id = ?`,
      )
      .get(conditionId) as PaperSettlementRow | undefined;
  }

  private ensurePaperSettlementWithoutTransaction(
    target: PaperSettlementTarget,
    now: Date,
  ): void {
    const existing = this.getPaperSettlementRow(target.conditionId);
    if (existing !== undefined) {
      this.assertSettlementTargetMatches(existing, target);
      return;
    }

    const nowIso = now.toISOString();
    this.database
      .prepare(
        `INSERT INTO paper_settlements(
          condition_id, market_id, event_id, status, resolution_status,
          winning_token_id, winning_outcome, outcome, redemption_status,
          position_cost_micros, payout_micros, realized_pnl_micros,
          attempt_count, last_error, settled_at, redeemed_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'PENDING', NULL, NULL, NULL, NULL, 'PENDING',
          0, 0, 0, 0, NULL, NULL, NULL, ?, ?)`,
      )
      .run(target.conditionId, target.marketId, target.eventId, nowIso, nowIso);
    this.writeAudit("PAPER_SETTLEMENT_TRACKED", "paper_settlement", target.conditionId, {
      marketId: target.marketId,
      eventId: target.eventId,
    });
  }

  private assertSettlementTargetMatches(
    row: PaperSettlementRow,
    target: PaperSettlementTarget,
  ): void {
    if (row.market_id !== target.marketId || row.event_id !== target.eventId) {
      throw new Error(
        `Paper settlement target metadata changed: ${target.conditionId}`,
      );
    }
  }

  private getRecordedPaperSettlementPayouts(
    conditionId: string,
  ): PaperSettlementPayout[] | null {
    const row = this.database
      .prepare(
        `SELECT payload_json FROM audit_log
        WHERE event_type = 'PAPER_MARKET_SETTLED'
          AND entity_type = 'paper_settlement' AND entity_id = ?
        ORDER BY id DESC LIMIT 1`,
      )
      .get(conditionId) as { payload_json: string } | undefined;
    if (row === undefined) {
      return null;
    }
    try {
      const payload = JSON.parse(row.payload_json) as { payouts?: unknown };
      if (!Array.isArray(payload.payouts)) {
        return null;
      }
      const payouts: PaperSettlementPayout[] = [];
      const tokenIds = new Set<string>();
      for (const value of payload.payouts) {
        if (typeof value !== "object" || value === null) {
          return null;
        }
        const payout = value as Record<string, unknown>;
        const tokenId =
          typeof payout.tokenId === "string" ? payout.tokenId.trim() : "";
        if (
          tokenId.length === 0 ||
          tokenIds.has(tokenId) ||
          !Number.isSafeInteger(payout.priceMicros) ||
          (payout.priceMicros as number) < 0 ||
          (payout.priceMicros as number) > 1_000_000
        ) {
          return null;
        }
        tokenIds.add(tokenId);
        payouts.push({
          tokenId,
          priceMicros: payout.priceMicros as number,
        });
      }
      return payouts.sort((left, right) =>
        left.tokenId.localeCompare(right.tokenId),
      );
    } catch {
      return null;
    }
  }

  public getPaperOrder(id: string): PaperOrder {
    const row = this.database
      .prepare(
        `SELECT id, token_id, condition_id, event_id, market_id, game_starts_at,
          market_opened_at, market_ends_at, side,
          price_micros, target_sell_price_micros, linked_buy_order_id,
          original_size_micros, filled_size_micros,
          queue_ahead_size_micros, queue_baseline_filled_size_micros,
          observed_trade_size_micros, status, execution_kind,
          cash_limit_micros, fee_micros,
          created_at, updated_at FROM paper_orders WHERE id = ?`,
      )
      .get(id) as PaperOrderRow | undefined;
    if (row === undefined) {
      throw new Error(`Paper order not found: ${id}`);
    }
    return rowToPaperOrder(row);
  }

  private writeAudit(
    eventType: string,
    entityType: string,
    entityId: string,
    payload: Record<string, unknown>,
  ): void {
    this.database
      .prepare(
        `INSERT INTO audit_log(
          event_type, entity_type, entity_id, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        eventType,
        entityType,
        entityId,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
  }
}

function emptyTestFakBuy(
  outcome: Extract<ImmediateBuyOutcome, "NO_FILL" | "BLOCKED">,
): ImmediateBuyExecution {
  return {
    outcome,
    order: null,
    createdSellOrders: [],
    spentMicros: 0,
    feeMicros: 0,
    consumedAsks: [],
  };
}

function emptyTestFakSell(): TargetSellExecution {
  return {
    filledSizeMicros: 0,
    grossProceedsMicros: 0,
    netProceedsMicros: 0,
    feeMicros: 0,
    filledOrderCount: 0,
    consumedBids: [],
  };
}
