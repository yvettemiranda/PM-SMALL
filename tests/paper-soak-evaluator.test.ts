import { describe, expect, it } from "vitest";
import {
  evaluateAvailablePaperSoakSafety,
  evaluatePaperSoakSample,
} from "../src/services/paper-soak-evaluator.js";

describe("evaluatePaperSoakSample", () => {
  it("compacts a healthy PAPER snapshot without warnings", () => {
    const sample = evaluatePaperSoakSample({
      sampledAt: "2026-08-04T00:00:00.000Z",
      requestDurationMs: 25,
      statusHttpStatus: 200,
      validationHttpStatus: 200,
      statusPayload: makeStatus(),
      validationPayload: makeValidation(),
      requireRunning: true,
    });

    expect(sample).toMatchObject({
      type: "sample",
      sampledAt: "2026-08-04T00:00:00.000Z",
      http: {
        requestDurationMs: 25,
        statusCode: 200,
        validationStatusCode: 200,
      },
      safety: {
        executionMode: "PAPER",
        liveExecutionEnabled: false,
        strategyMode: "PAPER",
        strategyStatus: "RUNNING",
      },
      strategy: {
        initialCapitalMicros: 100_000_000,
        availableCashMicros: 99_000_000,
        reservedCashMicros: 1_000_000,
        realizedPnlMicros: 0,
        positionCostMicros: 0,
      },
      scan: {
        candidateCount: 2,
        diagnostics: {
          phase: "COMPLETE",
          eventPageCount: 3,
          orderBookBatchCount: 1,
          eventCount: 120,
          eligibleTokenCount: 40,
          orderBookCount: 40,
          candidateCount: 2,
          durationMs: 800,
        },
      },
      ledgerValidation: { passed: true, sqliteIntegrity: "ok" },
      warnings: [],
      criticalErrors: [],
    });
  });

  it("treats temporary component errors as warnings", () => {
    const status = makeStatus();
    status.marketScan.lastError = "HTTP 429";
    status.marketStream.connected = false;
    status.marketStream.lastError = "socket closed";
    status.paperSettlement.lastError = "temporary HTTP 503";

    const sample = evaluatePaperSoakSample({
      sampledAt: "2026-08-04T00:00:00.000Z",
      requestDurationMs: 25,
      statusHttpStatus: 200,
      validationHttpStatus: 200,
      statusPayload: status,
      validationPayload: makeValidation(),
      requireRunning: true,
    });

    expect(sample.criticalErrors).toEqual([]);
    expect(sample.warnings).toEqual(
      expect.arrayContaining([
        "Market scan error: HTTP 429",
        "Market stream is disconnected with active subscriptions",
        "Market stream error: socket closed",
        "Paper settlement error: temporary HTTP 503",
      ]),
    );
  });

  it("stops on LIVE, paused strategy, or failed ledger validation", () => {
    const status = makeStatus();
    status.executionMode = "LIVE";
    status.liveExecutionEnabled = true;
    status.strategy.status = "PAUSED";
    status.paperValidation.failedValidationCount = 1;
    status.paperValidation.lastResult = {
      ...status.paperValidation.lastResult,
      passed: false,
      errors: ["periodic mismatch"],
    };
    const validation = makeValidation();
    validation.validation = {
      ...validation.validation,
      passed: false,
      errors: ["ledger mismatch"],
      sqliteIntegrity: "malformed",
    };

    const sample = evaluatePaperSoakSample({
      sampledAt: "2026-08-04T00:00:00.000Z",
      requestDurationMs: 25,
      statusHttpStatus: 200,
      validationHttpStatus: 503,
      statusPayload: status,
      validationPayload: validation,
      requireRunning: true,
    });

    expect(sample.criticalErrors).toEqual(
      expect.arrayContaining([
        "Execution mode is not PAPER: LIVE",
        "Live execution is enabled",
        "Paper strategy is not RUNNING: PAUSED",
        "Paper ledger validation failed: ledger mismatch",
        "SQLite integrity check failed: malformed",
        "Periodic paper validation failed: periodic mismatch",
        "Periodic paper validation recorded 1 failed run",
      ]),
    );
  });

  it("retains a status safety failure when validation is unavailable", () => {
    const status = makeStatus();
    status.executionMode = "LIVE";
    status.liveExecutionEnabled = true;

    expect(
      evaluateAvailablePaperSoakSafety({
        status: { httpStatus: 200, payload: status },
        requireRunning: true,
      }),
    ).toEqual(
      expect.arrayContaining([
        "Execution mode is not PAPER: LIVE",
        "Live execution is enabled",
      ]),
    );
  });

  it("retains a ledger failure when status is unavailable", () => {
    const validation = makeValidation();
    validation.validation = {
      ...validation.validation,
      passed: false,
      errors: ["ledger mismatch"],
    };

    expect(
      evaluateAvailablePaperSoakSafety({
        validation: { httpStatus: 503, payload: validation },
        requireRunning: true,
      }),
    ).toEqual(
      expect.arrayContaining([
        "Validation endpoint returned HTTP 503",
        "Paper ledger validation failed: ledger mismatch",
      ]),
    );
  });
});

function makeStatus() {
  return {
    version: "0.4.0",
    executionMode: "PAPER",
    liveExecutionEnabled: false,
    strategy: {
      mode: "PAPER",
      status: "RUNNING",
      initialCapitalMicros: 100_000_000,
      availableCashMicros: 99_000_000,
      reservedCashMicros: 1_000_000,
      realizedPnlMicros: 0,
      positionCostMicros: 0,
      updatedAt: "2026-08-04T00:00:00.000Z",
    },
    configuration: { maxMarketDurationDays: 30 },
    marketScan: {
      candidateCount: 2,
      candidates: [{ id: "candidate-1" }, { id: "candidate-2" }],
      lastScanAt: "2026-08-04T00:00:00.000Z",
      lastError: null as string | null,
      scanning: false,
      diagnostics: {
        phase: "COMPLETE" as const,
        startedAt: "2026-08-03T23:59:59.200Z",
        completedAt: "2026-08-04T00:00:00.000Z",
        durationMs: 800,
        eventPageCount: 3,
        eventCount: 120,
        eligibleTokenCount: 40,
        orderBookBatchCount: 1,
        orderBookCount: 40,
        candidateCount: 2,
      },
    },
    marketStream: {
      running: true,
      connected: true,
      subscribedTokenCount: 2,
      dataCompleteTokenCount: 2,
      lastEventAt: "2026-08-04T00:00:00.000Z",
      processedTradeEvents: 10,
      ignoredTradeEvents: 1,
      lastError: null as string | null,
    },
    paperAutomation: {
      running: true,
      lastRunAt: "2026-08-04T00:00:00.000Z",
      lastError: null as string | null,
      placedBuyCount: 1,
      cancelledStartedBuyCount: 0,
      cancelledProgressedBuyCount: 0,
    },
    paperSettlement: {
      running: true,
      lastRunAt: "2026-08-04T00:00:00.000Z",
      lastError: null as string | null,
      checkedMarketCount: 1,
      waitingMarketCount: 1,
      settledMarketCount: 0,
    },
    paperValidation: {
      running: true,
      validationCount: 5,
      failedValidationCount: 0,
      lastRunAt: "2026-08-04T00:00:00.000Z",
      lastError: null as string | null,
      lastResult: {
        passed: true,
        errors: [] as string[],
        sqliteIntegrity: "ok",
        activeOrderCount: 1,
        openPositionCount: 0,
        pendingSettlementCount: 1,
        checkedAt: "2026-08-04T00:00:00.000Z",
      },
    },
  };
}

function makeValidation() {
  return {
    validation: {
      passed: true,
      errors: [] as string[],
      sqliteIntegrity: "ok",
      activeOrderCount: 1,
      openPositionCount: 0,
      pendingSettlementCount: 1,
      checkedAt: "2026-08-04T00:00:00.000Z",
    },
  };
}
