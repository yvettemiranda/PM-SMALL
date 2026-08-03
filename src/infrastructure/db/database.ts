import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { calculateConservativePaperFill } from "../../domain/paper-fill-model.js";
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

export class PaperDatabase {
  private readonly database: Database.Database;

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

  public close(): void {
    this.database.close();
  }

  public setStrategyStatus(status: StrategyStatus): StrategyState {
    return this.transaction(() => {
      const now = new Date().toISOString();
      this.database
        .prepare("UPDATE strategy_state SET status = ?, updated_at = ? WHERE id = 1")
        .run(status, now);
      if (status !== "RUNNING") {
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
      const orders = this.listActivePaperOrders(tokenId);
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

  public recoverPaperState(): PaperRecoveryResult {
    return this.transaction(() => {
      const recoveredAt = new Date().toISOString();
      const closedTokens = this.database
        .prepare(
          "SELECT token_id FROM paper_positions WHERE first_sell_at IS NOT NULL",
        )
        .all() as unknown as Array<{ token_id: string }>;
      let cancelledBuyCount = 0;
      for (const row of closedTokens) {
        cancelledBuyCount += this.cancelActiveBuysForToken(
          row.token_id,
          recoveredAt,
          "RECOVERY_FIRST_SELL",
        );
      }

      const activeOrders = this.listActivePaperOrders();
      const state = this.getStrategyState();
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
      const positionRows = this.database
        .prepare(
          "SELECT token_id, quantity_micros FROM paper_positions WHERE quantity_micros > 0",
        )
        .all() as unknown as Array<{
        token_id: string;
        quantity_micros: number;
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

      const errors: string[] = [];
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
      for (const position of positionRows) {
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

      if (errors.length > 0) {
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
          "SELECT first_sell_at FROM paper_positions WHERE token_id = ?",
        )
        .get(candidate.tokenId) as { first_sell_at: string | null } | undefined;
      if (closedCycle?.first_sell_at) {
        throw new Error("This token already recorded its first sell in this strategy cycle");
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
    const orders = this.listActivePaperOrders(tokenId).filter(
      (order) => order.side === "BUY",
    );
    for (const order of orders) {
      this.cancelPaperBuy(order, now, reason);
    }
    return orders.length;
  }

  private cancelPaperBuy(order: PaperOrder, now: string, reason: string): void {
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
