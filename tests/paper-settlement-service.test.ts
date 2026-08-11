import { afterEach, describe, expect, it } from "vitest";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import type { PaperMarketResolution } from "../src/domain/paper-settlement.js";
import type { MarketResolutionSource } from "../src/infrastructure/polymarket/market-data.js";
import { PaperSettlementService } from "../src/services/paper-settlement-service.js";
import { PaperTradingPreferencesService } from "../src/services/paper-trading-preferences-service.js";
import { makeCandidate, testConfig } from "./helpers.js";

class FakeResolutionSource implements MarketResolutionSource {
  public calls: string[] = [];
  public responses: Array<PaperMarketResolution | Error> = [];

  public async fetchMarketResolution(
    marketId: string,
  ): Promise<PaperMarketResolution> {
    this.calls.push(marketId);
    const response = this.responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    if (response === undefined) {
      throw new Error("No fake resolution response configured");
    }
    return response;
  }
}

describe("PaperSettlementService", () => {
  const resources: Array<{ stop?: () => Promise<void>; close?: () => void }> = [];

  afterEach(async () => {
    for (const resource of resources.splice(0).reverse()) {
      await resource.stop?.();
      resource.close?.();
    }
  });

  it("cancels ended buys and simulates a resolved paper redemption", async () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      openedAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-02T00:00:00.000Z",
    });
    const buy = database.placePaperBuy(candidate, 100_000_000);
    database.applyPaperTrade({
      orderId: buy.id,
      sourceTradeId: "buy-fill",
      tradePriceMicros: buy.priceMicros,
      tradeSizeMicros: 12_000_000,
      dataComplete: true,
    });

    const source = new FakeResolutionSource();
    source.responses.push({
      marketId: candidate.marketId,
      conditionId: candidate.conditionId,
      closed: true,
      resolutionStatus: "resolved",
      outcomes: [
        { tokenId: candidate.tokenId, label: "Yes", priceMicros: 1_000_000 },
        { tokenId: "no-token", label: "No", priceMicros: 0 },
      ],
    });
    const service = new PaperSettlementService(
      source,
      database,
      10,
      () => undefined,
      () => new Date("2026-01-03T00:00:00.000Z"),
    );
    resources.push({ stop: () => service.stop(), close: () => database.close() });

    service.start();
    await waitFor(() => database.getPaperSettlement(candidate.conditionId)?.status === "SETTLED");

    expect(source.calls).toEqual([candidate.marketId]);
    expect(database.listActivePaperOrders(candidate.tokenId)).toHaveLength(0);
    expect(database.getStrategyState()).toMatchObject({
      availableCashMicros: 101_960_000,
      reservedCashMicros: 0,
      positionCostMicros: 0,
    });
    expect(service.getStatus()).toMatchObject({
      running: true,
      settledMarketCount: 1,
      lastError: null,
    });
  });

  it("records an unresolved check and retries after a source failure", async () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      openedAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-02T00:00:00.000Z",
    });
    database.placePaperBuy(candidate, 100_000_000);
    const source = new FakeResolutionSource();
    source.responses.push(
      new Error("temporary resolution outage"),
      {
        marketId: candidate.marketId,
        conditionId: candidate.conditionId,
        closed: true,
        resolutionStatus: "proposed",
        outcomes: [
          { tokenId: candidate.tokenId, label: "Yes", priceMicros: 500_000 },
          { tokenId: "no-token", label: "No", priceMicros: 500_000 },
        ],
      },
    );
    const service = new PaperSettlementService(
      source,
      database,
      10,
      () => undefined,
      () => new Date("2026-01-03T00:00:00.000Z"),
    );
    resources.push({ stop: () => service.stop(), close: () => database.close() });

    service.start();
    await waitFor(() => source.calls.length >= 2);

    const settlement = database.getPaperSettlement(candidate.conditionId);
    expect(settlement).toMatchObject({
      status: "PENDING",
      attemptCount: 2,
      resolutionStatus: "proposed",
      lastError: "RESOLUTION_NOT_FINAL",
    });
    expect(database.listActivePaperOrders(candidate.tokenId)).toHaveLength(0);
    expect(database.getStrategyState().availableCashMicros).toBe(100_000_000);
    expect(database.getStrategyState().status).toBe("RUNNING");
    expect(service.getStatus().settledMarketCount).toBe(0);
  });

  it("settles a same-identity position opened in the current reset generation", async () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    const preferences = new PaperTradingPreferencesService(database, testConfig);
    const candidate = makeCandidate({
      openedAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-02T00:00:00.000Z",
    });
    database.setStrategyStatus("RUNNING");
    const oldBuy = database.placePaperBuy(candidate, 100_000_000);
    database.applyPaperTrade({
      orderId: oldBuy.id,
      sourceTradeId: "pre-reset-buy-fill",
      tradePriceMicros: oldBuy.priceMicros,
      tradeSizeMicros: 12_000_000,
      dataComplete: true,
    });
    database.setStrategyStatus("PAUSED");
    preferences.resetTestState();

    database.setStrategyStatus("RUNNING");
    const currentBuy = database.placePaperBuy(candidate, 100_000_000);
    database.applyPaperTrade({
      orderId: currentBuy.id,
      sourceTradeId: "current-generation-buy-fill",
      tradePriceMicros: currentBuy.priceMicros,
      tradeSizeMicros: 12_000_000,
      dataComplete: true,
    });
    const source = new FakeResolutionSource();
    source.responses.push({
      marketId: candidate.marketId,
      conditionId: candidate.conditionId,
      closed: true,
      resolutionStatus: "resolved",
      outcomes: [
        { tokenId: candidate.tokenId, label: "Yes", priceMicros: 1_000_000 },
        { tokenId: "no-token", label: "No", priceMicros: 0 },
      ],
    });
    const service = new PaperSettlementService(
      source,
      database,
      60_000,
      () => undefined,
      () => new Date("2026-01-03T00:00:00.000Z"),
    );
    resources.push({ stop: () => service.stop(), close: () => database.close() });

    service.start();
    await waitFor(
      () => database.getPaperSettlement(candidate.conditionId)?.status === "SETTLED",
    );

    expect(source.calls).toEqual([candidate.marketId]);
    expect(database.getStrategyState()).toMatchObject({
      status: "RUNNING",
      availableCashMicros: 101_960_000,
      reservedCashMicros: 0,
      positionCostMicros: 0,
    });
    expect(service.getStatus()).toMatchObject({
      settledMarketCount: 1,
      lastError: null,
    });
  });

  it("pauses on a resolution response for a different market identity", async () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    database.setStrategyStatus("RUNNING");
    const candidate = makeCandidate({
      openedAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-02T00:00:00.000Z",
    });
    database.placePaperBuy(candidate, 100_000_000);
    const source = new FakeResolutionSource();
    source.responses.push({
      marketId: "different-market",
      conditionId: "0xother",
      closed: true,
      resolutionStatus: "resolved",
      outcomes: [
        { tokenId: "yes-token", label: "Yes", priceMicros: 1_000_000 },
        { tokenId: "no-token", label: "No", priceMicros: 0 },
      ],
    });
    const service = new PaperSettlementService(
      source,
      database,
      10,
      () => undefined,
      () => new Date("2026-01-03T00:00:00.000Z"),
    );
    resources.push({ stop: () => service.stop(), close: () => database.close() });

    service.start();
    await waitFor(() => service.getStatus().lastError !== null);

    expect(database.getStrategyState().status).toBe("PAUSED");
    expect(database.getPaperSettlement(candidate.conditionId)).toMatchObject({
      status: "PENDING",
      lastError: expect.stringContaining("condition"),
    });
  });

  it.each([
    ["response", "empty"],
    ["failure", "empty"],
    ["identity conflict", "empty"],
    ["response", "same target reopened"],
    ["failure", "same target reopened"],
    ["identity conflict", "same target reopened"],
  ] as const)(
    "does not reuse an in-flight resolution %s after reset with %s baseline",
    async (resultKind, baselineKind) => {
      const database = new PaperDatabase(":memory:", 100_000_000);
      const preferences = new PaperTradingPreferencesService(
        database,
        testConfig,
      );
      database.setStrategyStatus("RUNNING");
      const candidate = makeCandidate({
        openedAt: "2026-01-01T00:00:00.000Z",
        endsAt: "2026-01-02T00:00:00.000Z",
      });
      const buy = database.placePaperBuy(candidate, 100_000_000);
      database.applyPaperTrade({
        orderId: buy.id,
        sourceTradeId: "reset-race-buy-fill",
        tradePriceMicros: buy.priceMicros,
        tradeSizeMicros: 12_000_000,
        dataComplete: true,
      });

      let markRequestStarted: (() => void) | null = null;
      const requestStarted = new Promise<void>((resolve) => {
        markRequestStarted = resolve;
      });
      let finishRequest: (result: PaperMarketResolution | Error) => void =
        () => {
          throw new Error("Resolution request was not initialized");
        };
      const resolution = new Promise<PaperMarketResolution>(
        (resolve, reject) => {
          finishRequest = (result) => {
            if (result instanceof Error) {
              reject(result);
            } else {
              resolve(result);
            }
          };
        },
      );
      const source: MarketResolutionSource = {
        fetchMarketResolution: async () => {
          markRequestStarted?.();
          return resolution;
        },
      };
      const service = new PaperSettlementService(
        source,
        database,
        60_000,
        () => undefined,
        () => new Date("2026-01-03T00:00:00.000Z"),
      );
      resources.push({
        stop: () => service.stop(),
        close: () => database.close(),
      });

      service.start();
      await requestStarted;
      expect(database.getPaperSettlement(candidate.conditionId)).not.toBeNull();
      database.setStrategyStatus("PAUSED");
      preferences.resetTestState();
      expect(database.listPaperSettlements()).toEqual([]);
      database.setStrategyStatus("RUNNING");
      if (baselineKind === "same target reopened") {
        const reopenedBuy = database.placePaperBuy(candidate, 100_000_000);
        database.applyPaperTrade({
          orderId: reopenedBuy.id,
          sourceTradeId: "new-generation-buy-fill",
          tradePriceMicros: reopenedBuy.priceMicros,
          tradeSizeMicros: 12_000_000,
          dataComplete: true,
        });
      }
      const expectedOrders = database.listPaperOrders();
      const expectedPositions = database.listPaperPositions();

      finishRequest(
        resultKind === "failure"
          ? new Error("resolution request finished after reset")
          : {
              marketId:
                resultKind === "identity conflict"
                  ? "stale-market-after-reset"
                  : candidate.marketId,
              conditionId:
                resultKind === "identity conflict"
                  ? "stale-condition-after-reset"
                  : candidate.conditionId,
              closed: true,
              resolutionStatus: "resolved",
              outcomes: [
                {
                  tokenId: candidate.tokenId,
                  label: "Yes",
                  priceMicros: 1_000_000,
                },
                { tokenId: "no-token", label: "No", priceMicros: 0 },
              ],
            },
      );
      await waitFor(() => service.getStatus().lastRunAt !== null);

      expect(database.listPaperOrders()).toEqual(expectedOrders);
      expect(database.listPaperPositions()).toEqual(expectedPositions);
      expect(database.listPaperSettlements()).toEqual([]);
      expect(database.getStrategyState().status).toBe("RUNNING");
      expect(service.getStatus().lastError).toBeNull();
    },
  );
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
