import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { calculateConservativePaperFill } from "../../domain/paper-fill-model.js";
import {
  PaperResolutionValidationError,
  type PaperSettlementPayout,
} from "../../domain/paper-settlement.js";
import { calculateOrderCostMicros } from "../../domain/price.js";
import type {
  BookLevel,
  PaperOrder,
  PaperOrderStatus,
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

export type PaperNewCycleResult = {
  strategy: StrategyState;
  resetTokenCount: number;
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

export type PaperTradingPreferences = {
  resultCounts: Array<2 | 3>;
  maxBuyPriceMicros: number;
  maxMarketDurationDays: number;
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
  resultCount: 2 | 3 | null;
  durationDays: number | null;
};

export type PaperCandidateSelectionOverride = {
  tokenId: string;
  selected: boolean;
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

function rowToPaperTradingPreferences(row: {
  binary_enabled: number;
  ternary_enabled: number;
  max_buy_price_micros: number;
  max_market_duration_days: number;
  candidates_selected_by_default: number;
  updated_at: string;
}): PaperTradingPreferences {
  const resultCounts: Array<2 | 3> = [];
  if (row.binary_enabled === 1) resultCounts.push(2);
  if (row.ternary_enabled === 1) resultCounts.push(3);
  return {
    resultCounts,
    maxBuyPriceMicros: row.max_buy_price_micros,
    maxMarketDurationDays: row.max_market_duration_days,
    candidatesSelectedByDefault: row.candidates_selected_by_default === 1,
    updatedAt: row.updated_at,
  };
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
    this.database.exec("PRAGMA busy_timeout = 5000;");
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
      this.database.exec(readFileSync(migrationPath, "utf8"));
      this.database
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
        )
        .run(migration.version, new Date().toISOString());
    }
  }

  private ensureStrategyState(initialCapitalMicros: number): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT OR IGNORE INTO strategy_state(
          id, mode, status, initial_capital_micros, available_cash_micros,
          reserved_cash_micros, realized_pnl_micros, updated_at
        ) VALUES (1, 'PAPER', 'STOPPED', ?, ?, 0, 0, ?)`,
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

  public startNewPaperCycle(): PaperNewCycleResult {
    if (this.getStrategyState().status === "RUNNING") {
      throw new Error("Pause TEST before starting a new paper cycle");
    }
    return this.enterRunningState((now) => {
      this.cancelClosedCycleBuys(now, "NEW_CYCLE_STARTED");
      const resetTokenCount = this.database
        .prepare(
          `UPDATE paper_positions
          SET first_sell_at = NULL, cycle_closed_at = NULL, updated_at = ?
          WHERE quantity_micros = 0 AND cost_micros = 0
            AND (first_sell_at IS NOT NULL OR cycle_closed_at IS NOT NULL)
            AND NOT EXISTS (
              SELECT 1 FROM paper_settlements ps
              WHERE ps.condition_id = paper_positions.condition_id
                AND ps.status = 'SETTLED'
            )`,
        )
        .run(now).changes;
      this.database
        .prepare(
          "UPDATE strategy_state SET status = 'RUNNING', updated_at = ? WHERE id = 1",
        )
        .run(now);
      this.writeAudit("PAPER_NEW_CYCLE_STARTED", "strategy", "1", {
        resetTokenCount,
      });
      this.writeAudit("STRATEGY_STATUS_CHANGED", "strategy", "1", {
        status: "RUNNING",
      });
      return {
        strategy: this.getStrategyState(),
        resetTokenCount,
      };
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

  public ensurePaperTradingPreferences(
    defaults: Omit<PaperTradingPreferences, "updatedAt">,
  ): PaperTradingPreferences {
    const existing = this.getPaperTradingPreferencesRow();
    if (existing === undefined) {
      const now = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO paper_trading_preferences(
            id, binary_enabled, ternary_enabled, max_buy_price_micros,
            max_market_duration_days, candidates_selected_by_default, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          defaults.resultCounts.includes(2) ? 1 : 0,
          defaults.resultCounts.includes(3) ? 1 : 0,
          defaults.maxBuyPriceMicros,
          defaults.maxMarketDurationDays,
          defaults.candidatesSelectedByDefault ? 1 : 0,
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
          SET binary_enabled = ?, ternary_enabled = ?, max_buy_price_micros = ?,
              max_market_duration_days = ?, candidates_selected_by_default = ?,
              updated_at = ?
          WHERE id = 1`,
        )
        .run(
          preferences.resultCounts.includes(2) ? 1 : 0,
          preferences.resultCounts.includes(3) ? 1 : 0,
          preferences.maxBuyPriceMicros,
          preferences.maxMarketDurationDays,
          preferences.candidatesSelectedByDefault ? 1 : 0,
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
        resultCounts: preferences.resultCounts,
        maxBuyPriceMicros: preferences.maxBuyPriceMicros,
        maxMarketDurationDays: preferences.maxMarketDurationDays,
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
        `SELECT po.token_id, po.price_micros, pm.result_count, pm.duration_days
        FROM paper_orders po
        LEFT JOIN paper_market_metadata pm ON pm.token_id = po.token_id
        WHERE po.side = 'BUY' AND po.status IN ('OPEN', 'PARTIALLY_FILLED')
        ORDER BY po.token_id`,
      )
      .all() as unknown as Array<{
      token_id: string;
      price_micros: number;
      result_count: 2 | 3 | null;
      duration_days: number | null;
    }>;
    return rows.map((row) => ({
      tokenId: row.token_id,
      makerBuyPriceMicros: row.price_micros,
      resultCount: row.result_count,
      durationDays: row.duration_days,
    }));
  }

  public listPaperCandidateSelectionOverrides(): PaperCandidateSelectionOverride[] {
    const rows = this.database
      .prepare(
        `SELECT token_id, selected
        FROM paper_candidate_selection_overrides ORDER BY token_id`,
      )
      .all() as unknown as Array<{ token_id: string; selected: number }>;
    return rows.map((row) => ({
      tokenId: row.token_id,
      selected: row.selected === 1,
    }));
  }

  public setPaperCandidateSelected(
    tokenId: string,
    selected: boolean,
    selectedByDefault: boolean,
  ): void {
    if (
      !selected &&
      this.listActivePaperOrders(tokenId).some((order) => order.side === "BUY")
    ) {
      this.assertPaperAccountingMutationAllowed();
    }
    this.transaction(() => {
      const now = new Date().toISOString();
      if (selected === selectedByDefault) {
        this.database
          .prepare(
            "DELETE FROM paper_candidate_selection_overrides WHERE token_id = ?",
          )
          .run(tokenId);
      } else {
        this.database
          .prepare(
            `INSERT INTO paper_candidate_selection_overrides(token_id, selected, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(token_id) DO UPDATE SET
              selected = excluded.selected, updated_at = excluded.updated_at`,
          )
          .run(tokenId, selected ? 1 : 0, now);
      }
      const cancelledBuyCount = selected
        ? 0
        : this.cancelActiveBuysForToken(
            tokenId,
            now,
            "CANDIDATE_SELECTION_EXCLUDED",
          );
      this.writeAudit("PAPER_CANDIDATE_SELECTION_UPDATED", "market_token", tokenId, {
        selected,
        cancelledBuyCount,
      });
    });
  }

  public setAllPaperCandidatesSelected(selected: boolean): PaperTradingPreferences {
    if (
      !selected &&
      this.listActivePaperOrders().some((order) => order.side === "BUY")
    ) {
      this.assertPaperAccountingMutationAllowed();
    }
    return this.transaction(() => {
      const now = new Date().toISOString();
      this.database
        .prepare(
          `UPDATE paper_trading_preferences
          SET candidates_selected_by_default = ?, updated_at = ? WHERE id = 1`,
        )
        .run(selected ? 1 : 0, now);
      this.database.prepare("DELETE FROM paper_candidate_selection_overrides").run();
      let cancelledBuyCount = 0;
      if (!selected) {
        for (const order of this.listActivePaperOrders().filter(
          (paperOrder) => paperOrder.side === "BUY",
        )) {
          this.cancelPaperBuy(order, now, "CANDIDATE_SELECTION_CLEARED");
          cancelledBuyCount += 1;
        }
      }
      this.writeAudit("PAPER_CANDIDATE_SELECTION_RESET", "strategy", "1", {
        selected,
        cancelledBuyCount,
      });
      return this.getPaperTradingPreferences();
    });
  }

  public listPaperPositions(limit = 100): PaperPosition[] {
    const rows = this.database
      .prepare(
        `SELECT token_id, condition_id, quantity_micros, cost_micros,
          realized_pnl_micros, first_sell_at, cycle_closed_at, updated_at
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
          pp.updated_at, pm.event_id, pm.event_slug, pm.event_title,
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
          pp.updated_at, pm.event_id, pm.event_slug, pm.event_title,
          pm.market_id, pm.market_question, pm.direction, pm.opened_at, pm.ends_at
        FROM paper_positions pp
        LEFT JOIN paper_market_metadata pm ON pm.token_id = pp.token_id
        WHERE pp.quantity_micros > 0
        ORDER BY pp.updated_at DESC, pp.token_id`,
      )
      .all() as unknown as PaperPositionViewRow[];
    return rows.map(rowToPaperPositionView);
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
    if (!input.closed) {
      throw new PaperResolutionValidationError(
        "Paper settlement requires a closed market",
      );
    }
    const resolutionStatus = normalizeFinalResolutionStatus(
      input.resolutionStatus,
    );
    let conflictError: Error | null = null;
    const result = this.transaction<AppliedPaperSettlement | null>(() => {
      const target = input.target;
      let existing = this.getPaperSettlementRow(target.conditionId);
      if (existing === undefined) {
        this.ensurePaperSettlementWithoutTransaction(target, input.now ?? new Date());
        existing = this.getPaperSettlementRow(target.conditionId);
      }
      if (existing === undefined) {
        throw new Error(`Paper settlement not found: ${target.conditionId}`);
      }
      this.assertSettlementTargetMatches(existing, target);

      if (existing.status === "SETTLED") {
        if (
          existing.winning_token_id !== input.winningTokenId ||
          existing.winning_outcome !== input.winningOutcome
        ) {
          this.database
            .prepare(
              "UPDATE strategy_state SET status = 'PAUSED', updated_at = ? WHERE id = 1",
            )
            .run((input.now ?? new Date()).toISOString());
          this.writeAudit("PAPER_SETTLEMENT_CONFLICT", "paper_settlement", target.conditionId, {
            recordedWinningTokenId: existing.winning_token_id,
            receivedWinningTokenId: input.winningTokenId,
            recordedWinningOutcome: existing.winning_outcome,
            receivedWinningOutcome: input.winningOutcome,
          });
          conflictError = new Error(
            `Conflicting paper settlement result for condition: ${target.conditionId}`,
          );
          return null;
        }
        return {
          settlement: rowToPaperSettlement(existing),
          duplicate: true,
          positionCount: 0,
          cancelledBuyCount: 0,
          cancelledSellCount: 0,
        };
      }

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

      const payoutByToken = new Map<string, number>();
      if (input.payouts === undefined) {
        if (input.winningTokenId === null) {
          throw new Error("Paper settlement is missing a winning token or payout vector");
        }
        payoutByToken.set(input.winningTokenId, 1_000_000);
      } else {
        for (const payout of input.payouts) {
          if (
            payout.tokenId.trim().length === 0 ||
            !Number.isInteger(payout.priceMicros) ||
            payout.priceMicros < 0 ||
            payout.priceMicros > 1_000_000 ||
            payoutByToken.has(payout.tokenId)
          ) {
            throw new Error("Paper settlement contains an invalid payout vector");
          }
          payoutByToken.set(payout.tokenId, payout.priceMicros);
        }
        if (payoutByToken.size !== 2) {
          throw new Error("Paper settlement payout vector must contain two outcomes");
        }
        const payoutTotal = Array.from(payoutByToken.values()).reduce(
          (sum, value) => sum + value,
          0,
        );
        if (payoutTotal !== 1_000_000) {
          throw new Error("Paper settlement payout vector must sum to one token");
        }
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
          observed_trade_size_micros, status,
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
          observed_trade_size_micros, status,
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
        (order) => !this.paperValidationBlocked || order.side === "SELL",
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
        `SELECT token_id, quantity_micros, cost_micros
        FROM paper_positions
        WHERE quantity_micros != 0 OR cost_micros != 0`,
      )
      .all() as unknown as Array<{
      token_id: string;
      quantity_micros: number;
      cost_micros: number;
    }>;
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
            duration_days, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          now,
        );
      this.database
        .prepare(
          `INSERT INTO paper_orders(
            id, token_id, condition_id, event_id, market_id, game_starts_at,
            market_opened_at, market_ends_at, side,
            price_micros, target_sell_price_micros, linked_buy_order_id,
            original_size_micros, filled_size_micros, queue_ahead_size_micros,
            observed_trade_size_micros, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'BUY', ?, ?, NULL, ?, 0, ?, 0, 'OPEN', ?, ?)`,
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
              id, order_id, source_trade_id, price_micros, size_micros, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            fillId,
            order.id,
            input.sourceTradeId,
            order.priceMicros,
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
          observed_trade_size_micros, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SELL', ?, NULL, ?, ?, 0, ?, 0, 'OPEN', ?, ?)`,
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
    this.database
      .prepare(
        `INSERT INTO paper_positions(
          token_id, condition_id, quantity_micros, cost_micros,
          realized_pnl_micros, first_sell_at, cycle_closed_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)
        ON CONFLICT(token_id) DO UPDATE SET
          quantity_micros = quantity_micros + excluded.quantity_micros,
          cost_micros = cost_micros + excluded.cost_micros,
          updated_at = excluded.updated_at`,
      )
      .run(order.tokenId, order.conditionId, sizeMicros, costMicros, now);
    this.database
      .prepare(
        `UPDATE strategy_state
        SET reserved_cash_micros = reserved_cash_micros - ?, updated_at = ?
        WHERE id = 1`,
      )
      .run(costMicros, now);
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
        max_buy_price_micros: number;
        max_market_duration_days: number;
        candidates_selected_by_default: number;
        updated_at: string;
      }
    | undefined {
    return this.database
      .prepare(
        `SELECT binary_enabled, ternary_enabled, max_buy_price_micros,
          max_market_duration_days, candidates_selected_by_default, updated_at
        FROM paper_trading_preferences WHERE id = 1`,
      )
      .get() as
      | {
          binary_enabled: number;
          ternary_enabled: number;
          max_buy_price_micros: number;
          max_market_duration_days: number;
          candidates_selected_by_default: number;
          updated_at: string;
        }
      | undefined;
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

  private getPaperOrder(id: string): PaperOrder {
    const row = this.database
      .prepare(
        `SELECT id, token_id, condition_id, event_id, market_id, game_starts_at,
          market_opened_at, market_ends_at, side,
          price_micros, target_sell_price_micros, linked_buy_order_id,
          original_size_micros, filled_size_micros,
          queue_ahead_size_micros, queue_baseline_filled_size_micros,
          observed_trade_size_micros, status,
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
