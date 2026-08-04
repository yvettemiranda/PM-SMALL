import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { makeCandidate } from "./helpers.js";

describe("paper ledger validation", () => {
  it("detects a reserved-cash mismatch without changing strategy state", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-validation-"));
    const databasePath = join(directory, "paper.db");
    const database = new PaperDatabase(databasePath, 100_000_000);

    try {
      database.setStrategyStatus("RUNNING");
      database.placePaperBuy(makeCandidate(), 100_000_000);
      updateReservedCash(databasePath, 0);

      const result = database.validatePaperState();

      expect(result.passed).toBe(false);
      expect(result.errors).toContain(
        "Reserved paper cash does not match active buy orders",
      );
      expect(database.getStrategyState().status).toBe("RUNNING");
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not resume a paused strategy while validation still fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-validation-"));
    const databasePath = join(directory, "paper.db");
    const database = new PaperDatabase(databasePath, 100_000_000);

    try {
      database.setStrategyStatus("RUNNING");
      database.placePaperBuy(makeCandidate(), 100_000_000);
      updateReservedCash(databasePath, 0);
      const validation = database.validatePaperState();
      database.pausePaperStrategyForValidationFailure(validation.errors);

      expect(() => database.setStrategyStatus("RUNNING")).toThrow(
        /Paper validation failed/,
      );
      expect(database.getStrategyState().status).toBe("PAUSED");
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks existing buys when a start check detects an inconsistent ledger", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-validation-"));
    const databasePath = join(directory, "paper.db");
    const database = new PaperDatabase(databasePath, 100_000_000);

    try {
      database.setStrategyStatus("RUNNING");
      const buy = database.placePaperBuy(makeCandidate(), 100_000_000);
      updateReservedCash(databasePath, 0);

      expect(() => database.setStrategyStatus("RUNNING")).toThrow(
        /Paper validation failed/,
      );
      const fill = database.applyPaperTrade({
        orderId: buy.id,
        sourceTradeId: "blocked-after-start-validation",
        tradePriceMicros: 20_000,
        tradeSizeMicros: 12_000_000,
        dataComplete: true,
      });

      expect(database.getStrategyState().status).toBe("PAUSED");
      expect(fill.incrementalFillSizeMicros).toBe(0);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("detects when active sells no longer cover an open position", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-validation-"));
    const databasePath = join(directory, "paper.db");
    const database = new PaperDatabase(databasePath, 100_000_000);

    try {
      database.setStrategyStatus("RUNNING");
      const buy = database.placePaperBuy(makeCandidate(), 100_000_000);
      database.applyPaperTrade({
        orderId: buy.id,
        sourceTradeId: "validation-buy-fill",
        tradePriceMicros: 20_000,
        tradeSizeMicros: 12_000_000,
        dataComplete: true,
      });
      cancelActiveSells(databasePath);

      const result = database.validatePaperState();

      expect(result.passed).toBe(false);
      expect(result.errors).toContain(
        "Active paper sells do not cover position: yes-token",
      );
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("detects a residual position on a settled condition", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-validation-"));
    const databasePath = join(directory, "paper.db");
    const database = new PaperDatabase(databasePath, 100_000_000);
    const candidate = makeCandidate();
    const target = {
      conditionId: candidate.conditionId,
      marketId: candidate.marketId,
      eventId: candidate.eventId,
    };

    try {
      database.applyPaperSettlement({
        target,
        closed: true,
        resolutionStatus: "resolved",
        winningTokenId: candidate.tokenId,
        winningOutcome: "Yes",
      });
      insertResidualPosition(databasePath, candidate.tokenId, candidate.conditionId);

      const result = database.validatePaperState();

      expect(result.passed).toBe(false);
      expect(result.errors).toContain(
        `Settled market still has an open paper position: ${candidate.conditionId}`,
      );
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("detects invalid position rows even when their costs cancel out", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-validation-"));
    const databasePath = join(directory, "paper.db");
    const database = new PaperDatabase(databasePath, 100_000_000);

    try {
      insertCancellingInvalidPositions(databasePath);

      const result = database.validatePaperState();

      expect(result.passed).toBe(false);
      expect(result.errors).toContain(
        "Paper position has invalid quantity or cost: negative-token",
      );
      expect(result.openPositionCount).toBe(2);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("detects an invalid fill range on an otherwise balanced closed order", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-validation-"));
    const databasePath = join(directory, "paper.db");
    const database = new PaperDatabase(databasePath, 100_000_000);

    try {
      database.setStrategyStatus("RUNNING");
      const buy = database.placePaperBuy(makeCandidate(), 100_000_000);
      corruptClosedOrderFillRange(databasePath, buy.id);

      const result = database.validatePaperState();

      expect(result.passed).toBe(false);
      expect(result.errors).toContain(
        `Paper order has an invalid fill range: ${buy.id}`,
      );
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("freezes automatic accounting mutations after validation fails", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    const candidate = makeCandidate();

    try {
      database.setStrategyStatus("RUNNING");
      const buy = database.placePaperBuy(candidate, 100_000_000);
      database.pausePaperStrategyForValidationFailure(["Injected validation fault"]);

      expect(
        database.cancelProgressedMarketBuys(
          90,
          new Date("2026-01-10T00:00:00.000Z"),
        ),
      ).toBe(0);
      database.rebaseActivePaperOrderQueues(
        candidate.tokenId,
        [{ priceMicros: buy.priceMicros, sizeMicros: 99_000_000 }],
        [],
      );
      expect(
        database.listPaperOrders().find((order) => order.id === buy.id),
      ).toMatchObject({
        status: "OPEN",
        queueAheadSizeMicros: candidate.queueAheadSizeMicros,
      });
      expect(() =>
        database.applyPaperSettlement({
          target: {
            conditionId: candidate.conditionId,
            marketId: candidate.marketId,
            eventId: candidate.eventId,
          },
          closed: true,
          resolutionStatus: "resolved",
          winningTokenId: candidate.tokenId,
          winningOutcome: "Yes",
        }),
      ).toThrow(/blocked by failed validation/);
      expect(database.listActivePaperOrders()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("preserves an inconsistent ledger when startup recovery runs", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-validation-"));
    const databasePath = join(directory, "paper.db");
    const database = new PaperDatabase(databasePath, 100_000_000);

    try {
      database.setStrategyStatus("RUNNING");
      const buy = database.placePaperBuy(makeCandidate(), 100_000_000);
      injectClosedMarkerAndMismatch(databasePath);

      const recovery = database.recoverPaperState();

      expect(recovery).toMatchObject({
        passed: false,
        cancelledBuyCount: 0,
        activeOrderCount: 1,
      });
      expect(database.listPaperOrders()).toContainEqual(
        expect.objectContaining({ id: buy.id, status: "OPEN" }),
      );
      expect(database.getStrategyState().status).toBe("PAUSED");
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function updateReservedCash(databasePath: string, reservedCashMicros: number): void {
  const database = new Database(databasePath);
  try {
    database
      .prepare("UPDATE strategy_state SET reserved_cash_micros = ? WHERE id = 1")
      .run(reservedCashMicros);
  } finally {
    database.close();
  }
}

function cancelActiveSells(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database
      .prepare(
        "UPDATE paper_orders SET status = 'CANCELLED' WHERE side = 'SELL'",
      )
      .run();
  } finally {
    database.close();
  }
}

function insertResidualPosition(
  databasePath: string,
  tokenId: string,
  conditionId: string,
): void {
  const database = new Database(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO paper_positions(
          token_id, condition_id, quantity_micros, cost_micros,
          realized_pnl_micros, first_sell_at, cycle_closed_at, updated_at
        ) VALUES (?, ?, 1, 0, 0, NULL, NULL, ?)`,
      )
      .run(tokenId, conditionId, new Date().toISOString());
  } finally {
    database.close();
  }
}

function insertCancellingInvalidPositions(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    const insert = database.prepare(
      `INSERT INTO paper_positions(
        token_id, condition_id, quantity_micros, cost_micros,
        realized_pnl_micros, first_sell_at, cycle_closed_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)`,
    );
    const now = new Date().toISOString();
    insert.run("negative-token", "negative-condition", -1, -100, now);
    insert.run("positive-token", "positive-condition", 1, 100, now);
  } finally {
    database.close();
  }
}

function corruptClosedOrderFillRange(
  databasePath: string,
  orderId: string,
): void {
  const database = new Database(databasePath);
  try {
    database
      .prepare(
        `UPDATE paper_orders
        SET status = 'FILLED', filled_size_micros = original_size_micros + 1
        WHERE id = ?`,
      )
      .run(orderId);
    database
      .prepare(
        `UPDATE strategy_state
        SET available_cash_micros = initial_capital_micros,
            reserved_cash_micros = 0
        WHERE id = 1`,
      )
      .run();
  } finally {
    database.close();
  }
}

function injectClosedMarkerAndMismatch(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database
      .prepare("UPDATE strategy_state SET reserved_cash_micros = 0 WHERE id = 1")
      .run();
    database
      .prepare(
        `INSERT INTO paper_positions(
          token_id, condition_id, quantity_micros, cost_micros,
          realized_pnl_micros, first_sell_at, cycle_closed_at, updated_at
        ) VALUES ('yes-token', '0xcondition', 0, 0, 0, ?, NULL, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());
  } finally {
    database.close();
  }
}
