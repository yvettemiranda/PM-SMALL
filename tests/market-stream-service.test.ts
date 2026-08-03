import { afterEach, describe, expect, it } from "vitest";
import type {
  MarketStreamHandle,
  MarketStreamSource,
} from "../src/infrastructure/polymarket/market-stream.js";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { CandidateService } from "../src/services/candidate-service.js";
import { MarketStreamService } from "../src/services/market-stream-service.js";
import { PaperMarketProcessor } from "../src/services/paper-market-processor.js";
import { makeCandidate } from "./helpers.js";

class ReconnectingSource implements MarketStreamSource {
  public calls: string[][] = [];

  public async subscribe(tokenIds: readonly string[]): Promise<MarketStreamHandle> {
    this.calls.push([...tokenIds]);
    if (this.calls.length === 1) {
      return {
        close: async () => undefined,
        async *[Symbol.asyncIterator]() {
          throw new Error("test disconnect");
        },
      };
    }

    let release: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      close: async () => release(),
      async *[Symbol.asyncIterator]() {
        await closed;
      },
    };
  }
}

describe("MarketStreamService", () => {
  const resources: Array<{ close?: () => void; stop?: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const resource of resources.splice(0).reverse()) {
      await resource.stop?.();
      resource.close?.();
    }
  });

  it("reconnects after the market stream ends", async () => {
    const candidates = new CandidateService(
      { scan: async () => [makeCandidate()] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    const source = new ReconnectingSource();
    const service = new MarketStreamService(
      source,
      candidates,
      database,
      new PaperMarketProcessor(database),
      5,
    );
    resources.push(database, service);

    service.start();
    await waitFor(() => source.calls.length >= 2);

    expect(source.calls).toEqual([["yes-token"], ["yes-token"]]);
    expect(service.getStatus()).toMatchObject({
      running: true,
      connected: true,
      subscribedTokenCount: 1,
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
