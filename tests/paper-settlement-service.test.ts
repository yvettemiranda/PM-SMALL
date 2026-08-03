import { afterEach, describe, expect, it } from "vitest";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import type { PaperMarketResolution } from "../src/domain/paper-settlement.js";
import type { MarketResolutionSource } from "../src/infrastructure/polymarket/market-data.js";
import { PaperSettlementService } from "../src/services/paper-settlement-service.js";
import { makeCandidate } from "./helpers.js";

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
