import { describe, expect, it, vi } from "vitest";
import {
  RateLimitError,
  RequestRejectedError,
  type PublicClient,
} from "@polymarket/client";
import { PolymarketMarketDataSource } from "../src/infrastructure/polymarket/market-data.js";
import { makeEvent } from "./helpers.js";

describe("PolymarketMarketDataSource", () => {
  it("mirrors and caches the current Polymarket homepage category navigation", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes("/api/tags/filtered?")
        ? [
            { id: "2", label: "Politics", slug: "politics" },
            { id: "21", label: "Crypto", slug: "crypto" },
          ]
        : url.endsWith("/tags/slug/esports?include_template=false")
          ? { id: "64", label: "Esports", slug: "esports" }
          : { id: "1422", label: "Art", slug: "art" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const source = new PolymarketMarketDataSource(
      {} as PublicClient,
      [],
      fetcher as typeof fetch,
    );

    await expect(source.listHomepageCategories()).resolves.toEqual([
      { id: "2", label: "Politics" },
      { id: "21", label: "Crypto" },
      { id: "64", label: "Esports" },
      { id: "1422", label: "Art" },
    ]);
    await source.listHomepageCategories();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("falls back when homepage category sync exceeds its short timeout", async () => {
    vi.useFakeTimers();
    try {
      let observedAbort = false;
      const fetcher = vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      );
      const source = new PolymarketMarketDataSource(
        {} as PublicClient,
        [],
        fetcher as typeof fetch,
      );

      const pending = source.listHomepageCategories();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(pending).resolves.toEqual(
        expect.arrayContaining([
          { id: "2", label: "Politics" },
          { id: "1422", label: "Art" },
        ]),
      );
      expect(await pending).toHaveLength(14);
      expect(observedAbort).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("walks every page of open events", async () => {
    const firstEvent = makeEvent({ id: "event-page-1" });
    const secondEvent = makeEvent({ id: "event-page-2" });
    const requests: unknown[] = [];
    const secondPage = { items: [secondEvent], hasMore: false };
    const paginator = {
      firstPage: async () => ({
        items: [firstEvent],
        hasMore: true,
        nextCursor: "cursor-2" as never,
      }),
      from: () => ({ firstPage: async () => secondPage }),
      async *[Symbol.asyncIterator]() {
        yield { items: [firstEvent], hasMore: true, nextCursor: "cursor-2" };
        yield secondPage;
      },
    };
    const source = new PolymarketMarketDataSource({
      listEvents: (request: unknown) => {
        requests.push(request);
        return paginator;
      },
    } as unknown as PublicClient);
    const progress: unknown[] = [];

    const scanWindow = makeScanWindow();

    await expect(
      source.listOpenEvents(scanWindow, (update) => progress.push(update)),
    ).resolves.toEqual([firstEvent, secondEvent]);
    expect(requests).toEqual([{ closed: false, ...scanWindow }]);
    expect(progress).toEqual([
      {
        pageCount: 1,
        eventCount: 1,
        requestCount: 1,
        retryCount: 0,
        rateLimitCount: 0,
        transientErrorCount: 0,
      },
      {
        pageCount: 2,
        eventCount: 2,
        requestCount: 2,
        retryCount: 0,
        rateLimitCount: 0,
        transientErrorCount: 0,
      },
    ]);
  });

  it("retries a rate-limited event page without restarting earlier pages", async () => {
    const firstEvent = makeEvent({ id: "event-page-1" });
    const secondEvent = makeEvent({ id: "event-page-2" });
    let firstPageAttempts = 0;
    let secondPageAttempts = 0;
    const cursors: string[] = [];
    const firstPage = {
      items: [firstEvent],
      hasMore: true,
      nextCursor: "cursor-2" as never,
    };
    const secondPaginator = {
      firstPage: async () => {
        secondPageAttempts += 1;
        if (secondPageAttempts === 1) {
          throw new RateLimitError("temporary Gamma rate limit");
        }
        return { items: [secondEvent], hasMore: false };
      },
    };
    const paginator = {
      firstPage: async () => {
        firstPageAttempts += 1;
        return firstPage;
      },
      from: (cursor: unknown) => {
        cursors.push(String(cursor));
        return secondPaginator;
      },
      async *[Symbol.asyncIterator]() {
        yield firstPage;
        throw new RateLimitError("temporary Gamma rate limit");
      },
    };
    const source = new PolymarketMarketDataSource(
      { listEvents: () => paginator } as unknown as PublicClient,
      [0, 0],
    );
    const progress: Array<Record<string, number>> = [];

    await expect(
      source.listOpenEvents(
        makeScanWindow(),
        (update) => progress.push(update),
      ),
    ).resolves.toEqual([firstEvent, secondEvent]);
    expect(firstPageAttempts).toBe(1);
    expect(secondPageAttempts).toBe(2);
    expect(cursors).toEqual(["cursor-2", "cursor-2"]);
    expect(progress.at(-1)).toMatchObject({
      pageCount: 2,
      eventCount: 2,
      requestCount: 3,
      retryCount: 1,
      rateLimitCount: 1,
      transientErrorCount: 1,
    });
  });

  it("retries a transient order-book batch and reports the recovery", async () => {
    let attempts = 0;
    const source = new PolymarketMarketDataSource(
      {
        fetchOrderBooks: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new RequestRejectedError("temporary CLOB failure", {
              status: 503,
            });
          }
          return [{ tokenId: "token-1" }] as never;
        },
      } as unknown as PublicClient,
      [0, 0],
    );
    const progress: Array<Record<string, number>> = [];

    await expect(
      source.fetchOrderBooks(["token-1"], (update) => progress.push(update)),
    ).resolves.toEqual([{ tokenId: "token-1" }]);
    expect(attempts).toBe(2);
    expect(progress.at(-1)).toMatchObject({
      batchCount: 1,
      orderBookCount: 1,
      requestCount: 2,
      retryCount: 1,
      rateLimitCount: 0,
      transientErrorCount: 1,
    });
  });

  it("fetches every order-book batch with bounded concurrency", async () => {
    const calls: string[][] = [];
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const source = new PolymarketMarketDataSource(
      {
        fetchOrderBooks: async (requests: Array<{ tokenId: string }>) => {
          const tokenIds = requests.map((request) => request.tokenId);
          calls.push(tokenIds);
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((resolve) => releases.push(resolve));
          active -= 1;
          return tokenIds.map((tokenId) => ({ tokenId })) as never;
        },
      } as unknown as PublicClient,
      [],
      globalThis.fetch,
      2,
    );
    const tokenIds = Array.from(
      { length: 151 },
      (_, index) => `token-${index}`,
    );

    const pending = source.fetchOrderBooks(tokenIds);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(maxActive).toBe(2);
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    releases.splice(0).forEach((release) => release());

    await expect(pending).resolves.toHaveLength(151);
    expect(calls.flat()).toEqual(tokenIds);
    expect(maxActive).toBe(2);
  });

  it("cancels sibling order-book workers after one batch fails", async () => {
    const calls: string[] = [];
    let releaseSecond: () => void = () => {};
    let markTwoStarted: () => void = () => {};
    const twoStarted = new Promise<void>((resolve) => {
      markTwoStarted = resolve;
    });
    const secondPending = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const source = new PolymarketMarketDataSource(
      {
        fetchOrderBooks: async (requests: Array<{ tokenId: string }>) => {
          const firstTokenId = requests[0]?.tokenId ?? "missing";
          calls.push(firstTokenId);
          if (calls.length === 2) markTwoStarted();
          if (firstTokenId === "token-0") {
            await twoStarted;
            throw new RequestRejectedError("invalid first batch", {
              status: 400,
            });
          }
          await secondPending;
          return [] as never;
        },
      } as unknown as PublicClient,
      [],
      globalThis.fetch,
      2,
    );
    const pending = source.fetchOrderBooks(
      Array.from({ length: 151 }, (_, index) => `token-${index}`),
    );

    await expect(pending).rejects.toThrow("invalid first batch");
    releaseSecond();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls).toEqual(["token-0", "token-50"]);
  });

  it("does not retry a permanent order-book rejection", async () => {
    let attempts = 0;
    const progress: Array<Record<string, number>> = [];
    const source = new PolymarketMarketDataSource(
      {
        fetchOrderBooks: async () => {
          attempts += 1;
          throw new RequestRejectedError("invalid order-book request", {
            status: 400,
          });
        },
      } as unknown as PublicClient,
      [0, 0],
    );

    await expect(
      source.fetchOrderBooks(["token-1"], (update) => progress.push(update)),
    ).rejects.toThrow("invalid order-book request");
    expect(attempts).toBe(1);
    expect(progress.at(-1)).toMatchObject({
      requestCount: 1,
      retryCount: 0,
      rateLimitCount: 0,
      transientErrorCount: 0,
    });
  });

  it("stops after the bounded matching-engine retry budget", async () => {
    let attempts = 0;
    const progress: Array<Record<string, number>> = [];
    const source = new PolymarketMarketDataSource(
      {
        fetchOrderBooks: async () => {
          attempts += 1;
          throw new RequestRejectedError("matching engine restarting", {
            status: 425,
          });
        },
      } as unknown as PublicClient,
      [0, 0],
    );

    await expect(
      source.fetchOrderBooks(["token-1"], (update) => progress.push(update)),
    ).rejects.toThrow("matching engine restarting");
    expect(attempts).toBe(3);
    expect(progress.at(-1)).toMatchObject({
      requestCount: 3,
      retryCount: 2,
      rateLimitCount: 0,
      transientErrorCount: 3,
    });
  });

  it("stops a retry backoff when the scan is aborted", async () => {
    let attempts = 0;
    let markAttempted: () => void = () => {};
    const attempted = new Promise<void>((resolve) => {
      markAttempted = resolve;
    });
    const source = new PolymarketMarketDataSource(
      {
        fetchOrderBooks: async () => {
          attempts += 1;
          markAttempted();
          throw new RateLimitError("temporary CLOB rate limit");
        },
      } as unknown as PublicClient,
      [10_000],
    );
    const controller = new AbortController();
    const pending = source.fetchOrderBooks(
      ["token-1"],
      undefined,
      controller.signal,
    );
    const rejection = expect(pending).rejects.toThrow("scan stopped");

    await attempted;
    controller.abort(new Error("scan stopped"));

    await rejection;
    expect(attempts).toBe(1);
  });

  it("stops waiting for an event page when the scan is aborted", async () => {
    const paginator = {
      firstPage: () => new Promise<never>(() => {}),
      from: () => paginator,
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => new Promise<IteratorResult<never>>(() => {}),
    };
    const source = new PolymarketMarketDataSource({
      listEvents: () => paginator,
    } as unknown as PublicClient);
    const controller = new AbortController();
    const pending = source.listOpenEvents(
      makeScanWindow(),
      undefined,
      controller.signal,
    );

    controller.abort(new Error("scan stopped"));

    await expect(pending).rejects.toThrow("scan stopped");
  });

  it("stops waiting for an order-book batch when the scan is aborted", async () => {
    const source = new PolymarketMarketDataSource({
      fetchOrderBooks: () => new Promise(() => {}),
    } as unknown as PublicClient);
    const controller = new AbortController();
    const pending = source.fetchOrderBooks(
      ["token-1"],
      undefined,
      controller.signal,
    );

    controller.abort(new Error("scan stopped"));

    await expect(pending).rejects.toThrow("scan stopped");
  });

  it("normalizes the official market resolution fields without a wallet", async () => {
    const source = new PolymarketMarketDataSource({
      fetchMarket: async () =>
        ({
          id: "market-1",
          conditionId: "0xcondition",
          state: { closed: true },
          resolution: { umaResolutionStatus: "resolved" },
          outcomes: {
            yes: { label: "Yes", tokenId: "yes-token", price: "1" },
            no: { label: "No", tokenId: "no-token", price: "0" },
          },
        }) as never,
    } as unknown as PublicClient);

    await expect(source.fetchMarketResolution("market-1")).resolves.toEqual({
      marketId: "market-1",
      conditionId: "0xcondition",
      closed: true,
      resolutionStatus: "resolved",
      outcomes: [
        { tokenId: "yes-token", label: "Yes", priceMicros: 1_000_000 },
        { tokenId: "no-token", label: "No", priceMicros: 0 },
      ],
    });
  });

  it("does not round a near-final transient price into a settlement result", async () => {
    const source = new PolymarketMarketDataSource({
      fetchMarket: async () =>
        ({
          id: "market-1",
          conditionId: "0xcondition",
          state: { closed: true },
          resolution: { umaResolutionStatus: "resolved" },
          outcomes: {
            yes: { label: "Yes", tokenId: "yes-token", price: "0.9999996" },
            no: { label: "No", tokenId: "no-token", price: "0" },
          },
        }) as never,
    } as unknown as PublicClient);

    await expect(source.fetchMarketResolution("market-1")).resolves.toMatchObject({
      outcomes: [
        { tokenId: "yes-token", priceMicros: null },
        { tokenId: "no-token", priceMicros: 0 },
      ],
    });
  });
});

function makeScanWindow() {
  return {
    pageSize: 100,
    startDateMin: "2026-01-01T00:00:00.000Z",
    startDateMax: "2026-01-31T00:00:00.000Z",
    endDateMin: "2026-01-31T00:00:00.000Z",
    endDateMax: "2026-03-02T00:00:00.000Z",
  };
}
