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

class ControllableDisconnectSource implements MarketStreamSource {
  public calls: string[][] = [];
  private releaseCurrent: (() => void) | null = null;

  public async subscribe(tokenIds: readonly string[]): Promise<MarketStreamHandle> {
    this.calls.push([...tokenIds]);
    let release: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.releaseCurrent = release;
    return {
      close: async () => release(),
      async *[Symbol.asyncIterator]() {
        yield makeBookEvent(tokenIds[0]);
        await closed;
      },
    };
  }

  public disconnectCurrent(): void {
    if (this.releaseCurrent === null) {
      throw new Error("Expected an active market stream");
    }
    this.releaseCurrent();
    this.releaseCurrent = null;
  }
}

class HangingCloseSource implements MarketStreamSource {
  public closeStarted = false;
  private releaseClose: () => void = () => {};
  private readonly closed = new Promise<void>((resolve) => {
    this.releaseClose = resolve;
  });

  public async subscribe(): Promise<MarketStreamHandle> {
    const source = this;
    return {
      close: async () => {
        source.closeStarted = true;
        await source.closed;
      },
      async *[Symbol.asyncIterator]() {
        await source.closed;
      },
    };
  }

  public release(): void {
    this.releaseClose();
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
    const source = new ControllableDisconnectSource();
    const service = new MarketStreamService(
      source,
      candidates,
      database,
      new PaperMarketProcessor(database),
      5,
    );
    resources.push(database, service);

    service.start();
    await waitFor(() => service.getStatus().fullSnapshotCount === 1);
    source.disconnectCurrent();
    await waitFor(() => service.getStatus().recoveryCount === 1);

    expect(source.calls).toEqual([["yes-token"], ["yes-token"]]);
    expect(service.getStatus()).toMatchObject({
      running: true,
      connected: true,
      subscribedTokenCount: 1,
      dataCompleteTokenCount: 1,
      connectionCount: 2,
      fullSnapshotCount: 2,
      unexpectedDisconnectCount: 1,
      recoveryCount: 1,
      lastFullSnapshotDurationMs: expect.any(Number),
      lastRecoveryDurationMs: expect.any(Number),
    });
  });

  it("restores a full snapshot after each repeated disconnect", async () => {
    const candidates = new CandidateService(
      { scan: async () => [makeCandidate()] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    const source = new ControllableDisconnectSource();
    const service = new MarketStreamService(
      source,
      candidates,
      database,
      new PaperMarketProcessor(database),
      25,
    );
    resources.push(database, service);

    service.start();
    await waitFor(() => service.getStatus().fullSnapshotCount === 1);

    for (let disconnectCount = 1; disconnectCount <= 3; disconnectCount += 1) {
      source.disconnectCurrent();
      await waitFor(
        () =>
          service.getStatus().unexpectedDisconnectCount === disconnectCount,
      );
      expect(service.getStatus()).toMatchObject({
        connected: false,
        dataCompleteTokenCount: 0,
      });
      await waitFor(() => service.getStatus().recoveryCount === disconnectCount);
      expect(service.getStatus()).toMatchObject({
        connected: true,
        subscribedTokenCount: 1,
        dataCompleteTokenCount: 1,
      });
    }

    expect(source.calls).toEqual([
      ["yes-token"],
      ["yes-token"],
      ["yes-token"],
      ["yes-token"],
    ]);
    expect(service.getStatus()).toMatchObject({
      connectionCount: 4,
      fullSnapshotCount: 4,
      unexpectedDisconnectCount: 3,
      recoveryCount: 3,
      lastRecoveryDurationMs: expect.any(Number),
    });
  });

  it("stops within a bounded time when the stream handle does not close", async () => {
    const candidates = new CandidateService(
      { scan: async () => [makeCandidate()] },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    const source = new HangingCloseSource();
    const service = new MarketStreamService(
      source,
      candidates,
      database,
      new PaperMarketProcessor(database),
      5,
      10,
    );
    resources.push(database);

    service.start();
    await waitFor(() => service.getStatus().connected);

    const stopPromise = service.stop();
    const outcome = await Promise.race([
      stopPromise.then(() => "stopped" as const),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 50),
      ),
    ]);

    source.release();
    await stopPromise;

    expect(source.closeStarted).toBe(true);
    expect(outcome).toBe("stopped");
    expect(service.getStatus().lastError).toContain("timed out after 10ms");
  });
});

function makeBookEvent(tokenId: string | undefined) {
  if (tokenId === undefined) {
    throw new Error("Expected a subscribed token");
  }
  return {
    type: "book" as const,
    tokenId,
    bids: [],
    asks: [],
    timestampMs: Date.now(),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
