import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { makeCandidate } from "./helpers.js";

describe("PaperDatabase paper settlement", () => {
  let database: PaperDatabase;

  beforeEach(() => {
    database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
  });

  afterEach(() => database.close());

  it("waits for an official result without changing paper balances", () => {
    const candidate = makeCandidate({
      openedAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-02T00:00:00.000Z",
    });
    const buy = database.placePaperBuy(candidate, 100_000_000);
    database.applyPaperTrade({
      orderId: buy.id,
      sourceTradeId: "buy-trade",
      tradePriceMicros: buy.priceMicros,
      tradeSizeMicros: 12_000_000,
      dataComplete: true,
    });

    const target = {
      conditionId: candidate.conditionId,
      marketId: candidate.marketId,
      eventId: candidate.eventId,
    };
    database.ensurePaperSettlement(target);
    const before = database.getStrategyState();
    const pending = database.recordPaperSettlementCheck({
      target,
      resolutionStatus: "disputed",
      reason: "RESOLUTION_NOT_FINAL",
    });

    expect(pending).toMatchObject({
      status: "PENDING",
      resolutionStatus: "disputed",
      attemptCount: 1,
    });
    expect(database.getStrategyState()).toEqual(before);
    expect(database.listActivePaperOrders(candidate.tokenId)).toHaveLength(2);
  });

  it("enforces the closed and final-result gates at the accounting boundary", () => {
    const candidate = makeCandidate();
    const target = {
      conditionId: candidate.conditionId,
      marketId: candidate.marketId,
      eventId: candidate.eventId,
    };

    expect(() =>
      database.applyPaperSettlement({
        target,
        closed: false,
        resolutionStatus: "resolved",
        winningTokenId: candidate.tokenId,
        winningOutcome: "Yes",
      }),
    ).toThrow(/closed market/);
    expect(() =>
      database.applyPaperSettlement({
        target,
        closed: true,
        resolutionStatus: "proposed",
        winningTokenId: candidate.tokenId,
        winningOutcome: "Yes",
      }),
    ).toThrow(/final resolved or settled/);
    expect(database.getPaperSettlement(target.conditionId)).toBeNull();
  });

  it("rejects a fractional payout other than an official 50/50 result", () => {
    const candidate = makeCandidate();
    const target = {
      conditionId: candidate.conditionId,
      marketId: candidate.marketId,
      eventId: candidate.eventId,
    };

    expect(() =>
      database.applyPaperSettlement({
        target,
        closed: true,
        resolutionStatus: "resolved",
        winningTokenId: null,
        winningOutcome: "50/50",
        payouts: [
          { tokenId: candidate.tokenId, priceMicros: 750_000 },
          { tokenId: "no-token", priceMicros: 250_000 },
        ],
      }),
    ).toThrow(/1\/0 or 50\/50/);
    expect(database.getPaperSettlement(target.conditionId)).toBeNull();
  });

  it("pauses and audits a fractional replay after an official settlement", () => {
    const candidate = makeCandidate();
    const target = {
      conditionId: candidate.conditionId,
      marketId: candidate.marketId,
      eventId: candidate.eventId,
    };
    database.applyPaperSettlement({
      target,
      closed: true,
      resolutionStatus: "resolved",
      winningTokenId: candidate.tokenId,
      winningOutcome: "Yes",
    });

    expect(() =>
      database.applyPaperSettlement({
        target,
        closed: true,
        resolutionStatus: "settled",
        winningTokenId: null,
        winningOutcome: "50/50",
        payouts: [
          { tokenId: candidate.tokenId, priceMicros: 750_000 },
          { tokenId: "no-token", priceMicros: 250_000 },
        ],
      }),
    ).toThrow(/Conflicting paper settlement/);
    expect(database.getStrategyState().status).toBe("PAUSED");
  });

  it.each([
    "OPEN_MARKET",
    "NON_FINAL_STATUS",
    "TARGET_IDENTITY",
  ] as const)(
    "pauses and audits an invalid settled replay: %s",
    (conflictKind) => {
      const directory = mkdtempSync(join(tmpdir(), "pm-small-conflict-"));
      const databasePath = join(directory, "paper.db");
      const persistedDatabase = new PaperDatabase(databasePath, 100_000_000);
      try {
        persistedDatabase.setStrategyStatus("RUNNING");
        const candidate = makeCandidate();
        const target = {
          conditionId: candidate.conditionId,
          marketId: candidate.marketId,
          eventId: candidate.eventId,
        };
        persistedDatabase.applyPaperSettlement({
          target,
          closed: true,
          resolutionStatus: "resolved",
          winningTokenId: candidate.tokenId,
          winningOutcome: "Yes",
        });
        const replay = {
          target,
          closed: true,
          resolutionStatus: "settled",
          winningTokenId: candidate.tokenId,
          winningOutcome: "Yes",
        };
        if (conflictKind === "OPEN_MARKET") {
          replay.closed = false;
        } else if (conflictKind === "NON_FINAL_STATUS") {
          replay.resolutionStatus = "proposed";
        } else {
          replay.target = {
            ...target,
            marketId: `${target.marketId}-changed`,
          };
        }

        expect(
          () => persistedDatabase.applyPaperSettlement(replay),
          conflictKind,
        ).toThrow(/Conflicting paper settlement/);
        expect(
          persistedDatabase.getStrategyState().status,
          conflictKind,
        ).toBe("PAUSED");

        const auditDatabase = new Database(databasePath, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          const row = auditDatabase
            .prepare(
              `SELECT COUNT(*) AS count FROM audit_log
              WHERE event_type = 'PAPER_SETTLEMENT_CONFLICT'
                AND entity_id = ?`,
            )
            .get(target.conditionId) as { count: number };
          expect(row.count, conflictKind).toBe(1);
        } finally {
          auditDatabase.close();
        }
      } finally {
        persistedDatabase.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects padded payout token identity before writing a settlement", () => {
    const candidate = makeCandidate();
    const target = {
      conditionId: candidate.conditionId,
      marketId: candidate.marketId,
      eventId: candidate.eventId,
    };

    expect(() =>
      database.applyPaperSettlement({
        target,
        closed: true,
        resolutionStatus: "resolved",
        winningTokenId: null,
        winningOutcome: "50/50",
        payouts: [
          { tokenId: ` ${candidate.tokenId}`, priceMicros: 500_000 },
          { tokenId: "no-token", priceMicros: 500_000 },
        ],
      }),
    ).toThrow(/1\/0 or 50\/50/);
    expect(database.getPaperSettlement(target.conditionId)).toBeNull();
  });

  it("rejects reusing a locked Token identity for another condition", () => {
    const sharedToken = "shared-token";
    const first = makeCandidate({
      tokenId: sharedToken,
      candidateId: `${sharedToken}:20000:first`,
      conditionId: "condition-a",
      marketId: "market-a",
      endsAt: "2099-01-11T00:00:00.000Z",
    });
    const firstBuy = database.placePaperBuy(first, 100_000_000);
    database.applyPaperTrade({
      orderId: firstBuy.id,
      sourceTradeId: "first-fill",
      tradePriceMicros: firstBuy.priceMicros,
      tradeSizeMicros: 12_000_000,
      dataComplete: true,
    });

    const second = makeCandidate({
      tokenId: sharedToken,
      candidateId: `${sharedToken}:20000:second`,
      conditionId: "condition-b",
      marketId: "market-b",
      endsAt: "2099-01-11T00:00:00.000Z",
    });
    database.setStrategyStatus("STOPPED");
    database.setStrategyStatus("RUNNING");
    expect(() => database.placePaperBuy(second, 100_000_000)).toThrow(
      /Event is locked to another token/,
    );
  });

  it("simulates winning redemption, cancels remaining orders, and is idempotent", () => {
    const candidate = makeCandidate({
      openedAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-02T00:00:00.000Z",
    });
    const buy = database.placePaperBuy(candidate, 100_000_000);
    database.applyPaperTrade({
      orderId: buy.id,
      sourceTradeId: "buy-trade",
      tradePriceMicros: buy.priceMicros,
      tradeSizeMicros: 12_000_000,
      dataComplete: true,
    });
    const target = {
      conditionId: candidate.conditionId,
      marketId: candidate.marketId,
      eventId: candidate.eventId,
    };
    database.ensurePaperSettlement(target);

    const first = database.applyPaperSettlement({
      target,
      closed: true,
      resolutionStatus: "resolved",
      winningTokenId: candidate.tokenId,
      winningOutcome: "Yes",
      now: new Date("2026-01-03T00:00:00.000Z"),
    });
    const afterFirst = database.getStrategyState();
    const second = database.applyPaperSettlement({
      target,
      closed: true,
      resolutionStatus: "settled",
      winningTokenId: candidate.tokenId,
      winningOutcome: "Yes",
      now: new Date("2026-01-04T00:00:00.000Z"),
    });

    expect(first).toMatchObject({
      duplicate: false,
      positionCount: 1,
      cancelledBuyCount: 1,
      cancelledSellCount: 1,
      settlement: {
        status: "SETTLED",
        outcome: "WIN",
        redemptionStatus: "SIMULATED",
        payoutMicros: 2_000_000,
        realizedPnlMicros: 1_960_000,
      },
    });
    expect(database.listActivePaperOrders(candidate.tokenId)).toHaveLength(0);
    expect(database.listPaperPositions()[0]).toMatchObject({
      tokenId: candidate.tokenId,
      quantityMicros: 0,
      costMicros: 0,
      cycleClosedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(afterFirst).toMatchObject({
      availableCashMicros: 101_960_000,
      reservedCashMicros: 0,
      positionCostMicros: 0,
      realizedPnlMicros: 1_960_000,
    });
    expect(second.duplicate).toBe(true);
    expect(database.getStrategyState()).toEqual(afterFirst);
    expect(database.recoverPaperState()).toMatchObject({ passed: true });
  });

  it("preserves a settled paper cycle across a database restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-settlement-"));
    const databasePath = join(directory, "paper.db");

    const firstDatabase = new PaperDatabase(databasePath, 100_000_000);
    firstDatabase.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      openedAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-02T00:00:00.000Z",
    });
    const buy = firstDatabase.placePaperBuy(candidate, 100_000_000);
    firstDatabase.applyPaperTrade({
      orderId: buy.id,
      sourceTradeId: "restart-buy",
      tradePriceMicros: buy.priceMicros,
      tradeSizeMicros: 12_000_000,
      dataComplete: true,
    });
    const target = {
      conditionId: candidate.conditionId,
      marketId: candidate.marketId,
      eventId: candidate.eventId,
    };
    firstDatabase.applyPaperSettlement({
      target,
      closed: true,
      resolutionStatus: "resolved",
      winningTokenId: candidate.tokenId,
      winningOutcome: "Yes",
    });
    firstDatabase.close();

    const restartedDatabase = new PaperDatabase(databasePath, 100_000_000);
    expect(restartedDatabase.getPaperSettlement(candidate.conditionId)).toMatchObject({
      status: "SETTLED",
      redemptionStatus: "SIMULATED",
    });
    expect(restartedDatabase.recoverPaperState()).toMatchObject({ passed: true });
    restartedDatabase.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("zeros losing positions while preserving conservation", () => {
    const candidate = makeCandidate({
      openedAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-02T00:00:00.000Z",
    });
    const buy = database.placePaperBuy(candidate, 100_000_000);
    database.applyPaperTrade({
      orderId: buy.id,
      sourceTradeId: "buy-trade",
      tradePriceMicros: buy.priceMicros,
      tradeSizeMicros: 12_000_000,
      dataComplete: true,
    });
    const target = {
      conditionId: candidate.conditionId,
      marketId: candidate.marketId,
      eventId: candidate.eventId,
    };
    database.ensurePaperSettlement(target);

    const result = database.applyPaperSettlement({
      target,
      closed: true,
      resolutionStatus: "resolved",
      winningTokenId: "no-token",
      winningOutcome: "No",
    });

    expect(result.settlement).toMatchObject({
      status: "SETTLED",
      outcome: "LOSS",
      redemptionStatus: "NOT_APPLICABLE",
      payoutMicros: 0,
      realizedPnlMicros: -40_000,
    });
    expect(database.getStrategyState()).toMatchObject({
      availableCashMicros: 99_960_000,
      reservedCashMicros: 0,
      positionCostMicros: 0,
      realizedPnlMicros: -40_000,
    });
    expect(database.recoverPaperState()).toMatchObject({ passed: true });
  });

  it("releases only the settled Condition cycle so an open sibling can start later", () => {
    const active = makeCandidate({
      eventId: "multi-result-event",
      tokenId: "settled-token",
      candidateId: "settled-token:20000",
      conditionId: "settled-condition",
      marketId: "settled-market",
      queueAheadSizeMicros: 0,
    });
    const buy = database.placePaperBuy(active, 100_000_000);
    database.applyPaperTrade({
      orderId: buy.id,
      sourceTradeId: "settled-condition-fill",
      tradePriceMicros: buy.priceMicros,
      tradeSizeMicros: buy.originalSizeMicros,
      dataComplete: true,
    });
    database.applyPaperSettlement({
      target: {
        conditionId: active.conditionId,
        marketId: active.marketId,
        eventId: active.eventId,
      },
      closed: true,
      resolutionStatus: "resolved",
      winningTokenId: "losing-opposite-token",
      winningOutcome: "No",
    });

    expect(database.getPaperEventLock(active.eventId)).toBeNull();
    const sibling = makeCandidate({
      eventId: active.eventId,
      tokenId: "open-sibling-token",
      candidateId: "open-sibling-token:20000",
      conditionId: "open-sibling-condition",
      marketId: "open-sibling-market",
    });
    expect(database.placePaperBuy(sibling, 100_000_000)).toMatchObject({
      eventId: active.eventId,
      tokenId: sibling.tokenId,
      conditionId: sibling.conditionId,
      status: "OPEN",
    });
  });

  it("simulates proportional recovery for an official 50/50 result", () => {
    const yesCandidate = makeCandidate({
      openedAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-02T00:00:00.000Z",
    });
    const noCandidate = makeCandidate({
      tokenId: "no-token",
      candidateId: "no-token:20000",
      direction: "NO",
      openedAt: yesCandidate.openedAt,
      endsAt: yesCandidate.endsAt,
    });
    const yesBuy = database.placePaperBuy(yesCandidate, 100_000_000);
    const noBuy = database.placePaperBuy(noCandidate, 100_000_000);
    database.applyPaperTrade({
      orderId: yesBuy.id,
      sourceTradeId: "yes-trade",
      tradePriceMicros: yesBuy.priceMicros,
      tradeSizeMicros: 12_000_000,
      dataComplete: true,
    });
    database.applyPaperTrade({
      orderId: noBuy.id,
      sourceTradeId: "no-trade",
      tradePriceMicros: noBuy.priceMicros,
      tradeSizeMicros: 12_000_000,
      dataComplete: true,
    });

    const target = {
      conditionId: yesCandidate.conditionId,
      marketId: yesCandidate.marketId,
      eventId: yesCandidate.eventId,
    };
    const result = database.applyPaperSettlement({
      target,
      closed: true,
      resolutionStatus: "resolved",
      winningTokenId: null,
      winningOutcome: "50/50",
      payouts: [
        { tokenId: yesCandidate.tokenId, priceMicros: 500_000 },
        { tokenId: noCandidate.tokenId, priceMicros: 500_000 },
      ],
    });

    expect(result.settlement).toMatchObject({
      outcome: "WIN",
      redemptionStatus: "SIMULATED",
      payoutMicros: 1_000_000,
      realizedPnlMicros: 960_000,
    });
    expect(database.getStrategyState()).toMatchObject({
      availableCashMicros: 100_960_000,
      reservedCashMicros: 0,
      positionCostMicros: 0,
      realizedPnlMicros: 960_000,
    });
    expect(database.recoverPaperState()).toMatchObject({ passed: true });
  });

  it("pauses when a repeated 50/50 result changes its payout token identity", () => {
    const candidate = makeCandidate();
    const target = {
      conditionId: candidate.conditionId,
      marketId: candidate.marketId,
      eventId: candidate.eventId,
    };
    database.applyPaperSettlement({
      target,
      closed: true,
      resolutionStatus: "resolved",
      winningTokenId: null,
      winningOutcome: "50/50",
      payouts: [
        { tokenId: candidate.tokenId, priceMicros: 500_000 },
        { tokenId: "no-token", priceMicros: 500_000 },
      ],
    });

    expect(() =>
      database.applyPaperSettlement({
        target,
        closed: true,
        resolutionStatus: "settled",
        winningTokenId: null,
        winningOutcome: "50/50",
        payouts: [
          { tokenId: candidate.tokenId, priceMicros: 500_000 },
          { tokenId: "different-no-token", priceMicros: 500_000 },
        ],
      }),
    ).toThrow(/Conflicting paper settlement/);
    expect(database.getStrategyState().status).toBe("PAUSED");
  });

  it("pauses and refuses a conflicting result after settlement", () => {
    const candidate = makeCandidate({
      openedAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-02T00:00:00.000Z",
    });
    const buy = database.placePaperBuy(candidate, 100_000_000);
    database.applyPaperTrade({
      orderId: buy.id,
      sourceTradeId: "buy-trade",
      tradePriceMicros: buy.priceMicros,
      tradeSizeMicros: 12_000_000,
      dataComplete: true,
    });
    const target = {
      conditionId: candidate.conditionId,
      marketId: candidate.marketId,
      eventId: candidate.eventId,
    };
    database.ensurePaperSettlement(target);
    database.applyPaperSettlement({
      target,
      closed: true,
      resolutionStatus: "resolved",
      winningTokenId: candidate.tokenId,
      winningOutcome: "Yes",
    });

    expect(() =>
      database.applyPaperSettlement({
        target,
        closed: true,
        resolutionStatus: "resolved",
        winningTokenId: "no-token",
        winningOutcome: "No",
      }),
    ).toThrow(/Conflicting paper settlement/);
    expect(database.getStrategyState().status).toBe("PAUSED");
  });
});
