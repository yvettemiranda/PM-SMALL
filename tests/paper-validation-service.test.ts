import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { PaperValidationService } from "../src/services/paper-validation-service.js";
import { makeCandidate } from "./helpers.js";

describe("PaperValidationService", () => {
  const resources: Array<{ stop?: () => Promise<void>; close?: () => void }> = [];

  afterEach(async () => {
    for (const resource of resources.splice(0).reverse()) {
      await resource.stop?.();
      resource.close?.();
    }
  });

  it("runs immediately and reports a healthy paper ledger", async () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    const service = new PaperValidationService(database, 60_000);
    resources.push({ stop: () => service.stop(), close: () => database.close() });

    service.start();
    await waitFor(() => service.getStatus().validationCount >= 1);

    expect(service.getStatus()).toMatchObject({
      running: true,
      validationCount: 1,
      failedValidationCount: 0,
      lastError: null,
      lastResult: { passed: true, sqliteIntegrity: "ok" },
    });
  });

  it("pauses new buying when a validation fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-validation-"));
    const databasePath = join(directory, "paper.db");
    const database = new PaperDatabase(databasePath, 100_000_000);
    const service = new PaperValidationService(database, 60_000);

    try {
      database.setStrategyStatus("RUNNING");
      database.placePaperBuy(makeCandidate(), 100_000_000);
      updateReservedCash(databasePath, 0);

      service.start();
      await waitFor(() => service.getStatus().failedValidationCount >= 1);

      expect(database.getStrategyState().status).toBe("PAUSED");
      expect(database.listActivePaperOrders()).toHaveLength(1);
      expect(service.getStatus()).toMatchObject({
        failedValidationCount: 1,
        lastResult: { passed: false },
        lastError: expect.stringContaining("Reserved paper cash"),
      });
    } finally {
      await service.stop();
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks buy fills when persisting the validation pause fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-validation-"));
    const databasePath = join(directory, "paper.db");
    const database = new PaperDatabase(databasePath, 100_000_000);
    const service = new PaperValidationService(database, 60_000);

    try {
      database.setStrategyStatus("RUNNING");
      const buy = database.placePaperBuy(makeCandidate(), 100_000_000);
      injectMismatchAndRejectPause(databasePath);

      service.start();
      await waitFor(() => service.getStatus().failedValidationCount >= 1);

      expect(database.getStrategyState().status).toBe("RUNNING");
      const fill = database.applyPaperTrade({
        orderId: buy.id,
        sourceTradeId: "blocked-after-pause-write-failure",
        tradePriceMicros: 20_000,
        tradeSizeMicros: 12_000_000,
        dataComplete: true,
      });
      expect(fill.incrementalFillSizeMicros).toBe(0);
      expect(fill.order.filledSizeMicros).toBe(0);
    } finally {
      await service.stop();
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("clears a stale successful result when validation itself throws", async () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    const service = new PaperValidationService(database, 60_000);
    let databaseClosed = false;

    try {
      service.start();
      await waitFor(() => service.getStatus().validationCount >= 1);
      expect(service.getStatus().lastResult?.passed).toBe(true);

      database.close();
      databaseClosed = true;
      service.requestRun();
      await waitFor(() => service.getStatus().failedValidationCount >= 1);

      expect(service.getStatus()).toMatchObject({
        lastResult: null,
        lastError: expect.any(String),
      });
    } finally {
      await service.stop();
      if (!databaseClosed) database.close();
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

function injectMismatchAndRejectPause(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database
      .prepare("UPDATE strategy_state SET reserved_cash_micros = 0 WHERE id = 1")
      .run();
    database.exec(`
      CREATE TRIGGER reject_validation_pause
      BEFORE UPDATE OF status ON strategy_state
      WHEN NEW.status = 'PAUSED'
      BEGIN
        SELECT RAISE(ABORT, 'injected pause failure');
      END;
    `);
  } finally {
    database.close();
  }
}
