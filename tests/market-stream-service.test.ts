import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MarketStreamHandle,
  MarketStreamSource,
  MarketStreamSubscriptionUpdate,
} from "../src/infrastructure/polymarket/market-stream.js";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import { CandidateService } from "../src/services/candidate-service.js";
import { MarketStreamService } from "../src/services/market-stream-service.js";
import { PaperMarketProcessor } from "../src/services/paper-market-processor.js";
import { makeCandidate } from "./helpers.js";

class ControllableDisconnectSource implements MarketStreamSource {
  public calls: string[][] = [];
  public updates: MarketStreamSubscriptionUpdate[] = [];
  private endCurrent: ((error?: Error) => void) | null = null;

  public async subscribe(tokenIds: readonly string[]): Promise<MarketStreamHandle> {
    this.calls.push([...tokenIds]);
    let release: () => void = () => {};
    let reject: (error: Error) => void = () => {};
    const closed = new Promise<void>((resolve, rejectPromise) => {
      release = resolve;
      reject = rejectPromise;
    });
    this.endCurrent = (error) =>
      error === undefined ? release() : reject(error);
    const source = this;
    return {
      updateSubscriptions: async (update) => {
        source.updates.push({
          subscribe: [...update.subscribe],
          unsubscribe: [...update.unsubscribe],
        });
      },
      close: async () => release(),
      async *[Symbol.asyncIterator]() {
        yield makeBookEvent(tokenIds[0]);
        await closed;
      },
    };
  }

  public disconnectCurrent(error?: Error): void {
    if (this.endCurrent === null) {
      throw new Error("Expected an active market stream");
    }
    this.endCurrent(error);
    this.endCurrent = null;
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
      updateSubscriptions: async () => {},
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

class BurstSnapshotSource implements MarketStreamSource {
  private release: () => void = () => {};
  private readonly closed = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  public async subscribe(tokenIds: readonly string[]): Promise<MarketStreamHandle> {
    const source = this;
    return {
      updateSubscriptions: async () => {},
      close: async () => source.release(),
      async *[Symbol.asyncIterator]() {
        for (const tokenId of tokenIds) {
          yield makeBookEvent(tokenId);
        }
        await source.closed;
      },
    };
  }
}

class IncrementalDisconnectSource implements MarketStreamSource {
  public calls: string[][] = [];
  public updates: MarketStreamSubscriptionUpdate[] = [];
  private currentQueue: AsyncEventQueue<ReturnType<typeof makeBookEvent>> | null =
    null;

  public async subscribe(tokenIds: readonly string[]): Promise<MarketStreamHandle> {
    this.calls.push([...tokenIds]);
    const queue = new AsyncEventQueue<ReturnType<typeof makeBookEvent>>();
    this.currentQueue = queue;
    queue.push(
      makeBookEvent(
        tokenIds.includes("yes-token") ? "yes-token" : tokenIds[0],
      ),
    );
    const source = this;
    return {
      updateSubscriptions: async (update) => {
        source.updates.push({
          subscribe: [...update.subscribe],
          unsubscribe: [...update.unsubscribe],
        });
      },
      close: async () => queue.end(),
      [Symbol.asyncIterator]() {
        return queue[Symbol.asyncIterator]();
      },
    };
  }

  public emitBook(tokenId: string): void {
    this.currentQueue?.push(makeBookEvent(tokenId));
  }

  public disconnectCurrent(): void {
    if (this.currentQueue === null) {
      throw new Error("Expected an active market stream");
    }
    this.currentQueue.end();
    this.currentQueue = null;
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  public push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.values.push(value);
    } else {
      waiter({ value, done: false });
    }
  }

  public end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) {
          return { value, done: false };
        }
        if (this.ended) {
          return { value: undefined, done: true };
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
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
    expect(service.getQuoteStatus("yes-token")).toBe("NO_BID");
    source.disconnectCurrent(new Error("test disconnect"));
    await waitFor(() => service.getStatus().unexpectedDisconnectCount === 1);
    expect(service.getQuoteStatus("yes-token")).toBe("RECONNECTING");
    expect(candidates.getSnapshot().candidates[0]?.bookReady).toBe(false);
    await waitFor(() => service.getStatus().recoveryCount === 1);
    expect(service.getQuoteStatus("yes-token")).toBe("NO_BID");
    expect(candidates.getSnapshot().candidates[0]?.bookReady).toBe(true);

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

  it("restores live quotes after a scan replaces candidates without changing subscriptions", async () => {
    let scannedCandidate = makeCandidate();
    const candidates = new CandidateService(
      { scan: async () => [scannedCandidate] },
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
    expect(candidates.getSnapshot().candidates[0]).toMatchObject({
      bestBidMicros: null,
      bestAskMicros: null,
      bookReady: true,
    });

    scannedCandidate = makeCandidate({
      bestBidMicros: 900_000,
      bestAskMicros: 910_000,
    });
    await candidates.refresh();

    expect(candidates.getSnapshot().candidates[0]).toMatchObject({
      bestBidMicros: null,
      bestAskMicros: null,
      bookReady: true,
    });
    expect(source.calls).toEqual([["yes-token"]]);
  });

  it("updates changed scan subscriptions without disconnecting retained candidates", async () => {
    const retainedCandidate = makeCandidate();
    const addedCandidate = makeCandidate({
      candidateId: "added-token:20000",
      tokenId: "added-token",
    });
    let scannedCandidates = [retainedCandidate];
    const candidates = new CandidateService(
      { scan: async () => scannedCandidates },
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
    scannedCandidates = [retainedCandidate, addedCandidate];
    await candidates.refresh();
    await waitFor(() => source.updates.length === 1);

    expect(source.calls).toEqual([["yes-token"]]);
    expect(source.updates).toEqual([
      { subscribe: ["added-token"], unsubscribe: [] },
    ]);
    expect(service.getStatus()).toMatchObject({
      connected: true,
      subscribedTokenCount: 2,
      connectionCount: 1,
      unexpectedDisconnectCount: 0,
    });
    expect(
      candidates
        .getSnapshot()
        .candidates.find((candidate) => candidate.tokenId === "yes-token"),
    ).toMatchObject({ bookReady: true });
  });

  it("keeps an incrementally subscribed token not ready until its reconnect book arrives", async () => {
    const retainedCandidate = makeCandidate();
    const addedCandidate = makeCandidate({
      candidateId: "added-token:20000",
      tokenId: "added-token",
    });
    let scannedCandidates = [retainedCandidate];
    const candidates = new CandidateService(
      { scan: async () => scannedCandidates },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    const source = new IncrementalDisconnectSource();
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
    scannedCandidates = [retainedCandidate, addedCandidate];
    await candidates.refresh();
    await waitFor(() => source.updates.length === 1);
    source.emitBook("added-token");
    await waitFor(() => service.isTokenReady("added-token"));

    source.disconnectCurrent();
    await waitFor(() => service.getStatus().unexpectedDisconnectCount === 1);
    await waitFor(() => service.getStatus().connectionCount === 2);

    expect(service.isTokenReady("added-token")).toBe(false);
    expect(service.getQuoteStatus("added-token")).toBe("NOT_READY");
    expect(
      candidates
        .getSnapshot()
        .candidates.find((candidate) => candidate.tokenId === "added-token"),
    ).toMatchObject({ bookReady: false });

    source.emitBook("added-token");
    await waitFor(() => service.isTokenReady("added-token"));
    expect(service.getStatus().recoveryCount).toBe(1);
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

  it("records a large initial snapshot without rescanning every subscribed token", async () => {
    const scannedCandidates = Array.from({ length: 200 }, (_value, index) =>
      makeCandidate({
        candidateId: `token-${index}:30000`,
        tokenId: `token-${index}`,
      }),
    );
    const candidates = new CandidateService(
      { scan: async () => scannedCandidates },
      15_000,
    );
    await candidates.refresh();
    const database = new PaperDatabase(":memory:", 100_000_000);
    const processor = new PaperMarketProcessor(database);
    const readinessChecks = vi.spyOn(processor, "isTokenReady");
    const service = new MarketStreamService(
      new BurstSnapshotSource(),
      candidates,
      database,
      processor,
      5,
    );
    resources.push(database, service);

    service.start();
    await waitFor(() => service.getStatus().fullSnapshotCount === 1);

    expect(service.getStatus()).toMatchObject({
      subscribedTokenCount: 200,
      dataCompleteTokenCount: 200,
    });
    expect(readinessChecks.mock.calls.length).toBeLessThanOrEqual(200);
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
