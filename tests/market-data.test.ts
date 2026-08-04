import { describe, expect, it } from "vitest";
import type { PublicClient } from "@polymarket/client";
import { PolymarketMarketDataSource } from "../src/infrastructure/polymarket/market-data.js";
import { makeEvent } from "./helpers.js";

describe("PolymarketMarketDataSource", () => {
  it("walks every page of open events", async () => {
    const firstEvent = makeEvent({ id: "event-page-1" });
    const secondEvent = makeEvent({ id: "event-page-2" });
    const requests: unknown[] = [];
    const paginator = {
      async *[Symbol.asyncIterator]() {
        yield { items: [firstEvent], hasMore: true, nextCursor: "cursor-2" };
        yield { items: [secondEvent], hasMore: false };
      },
    };
    const source = new PolymarketMarketDataSource({
      listEvents: (request: unknown) => {
        requests.push(request);
        return paginator;
      },
    } as unknown as PublicClient);
    const progress: unknown[] = [];

    const scanWindow = {
      pageSize: 100,
      startDateMin: "2026-01-01T00:00:00.000Z",
      startDateMax: "2026-01-31T00:00:00.000Z",
      endDateMin: "2026-01-31T00:00:00.000Z",
      endDateMax: "2026-03-02T00:00:00.000Z",
    };

    await expect(
      source.listOpenEvents(scanWindow, (update) => progress.push(update)),
    ).resolves.toEqual([firstEvent, secondEvent]);
    expect(requests).toEqual([{ closed: false, ...scanWindow }]);
    expect(progress).toEqual([
      { pageCount: 1, eventCount: 1 },
      { pageCount: 2, eventCount: 2 },
    ]);
  });

  it("stops waiting for an event page when the scan is aborted", async () => {
    let iteratorReturned = false;
    const paginator = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => new Promise<IteratorResult<never>>(() => {}),
      return: async () => {
        iteratorReturned = true;
        return { done: true as const, value: undefined };
      },
    };
    const source = new PolymarketMarketDataSource({
      listEvents: () => paginator,
    } as unknown as PublicClient);
    const controller = new AbortController();
    const pending = source.listOpenEvents(
      {
        pageSize: 100,
        startDateMin: "2026-01-01T00:00:00.000Z",
        startDateMax: "2026-01-31T00:00:00.000Z",
        endDateMin: "2026-01-31T00:00:00.000Z",
        endDateMax: "2026-03-02T00:00:00.000Z",
      },
      undefined,
      controller.signal,
    );

    controller.abort(new Error("scan stopped"));

    await expect(pending).rejects.toThrow("scan stopped");
    expect(iteratorReturned).toBe(true);
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
