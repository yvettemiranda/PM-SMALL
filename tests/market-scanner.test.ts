import type { OrderBook } from "@polymarket/client";
import { describe, expect, it } from "vitest";
import { MarketScanner } from "../src/domain/market-scanner.js";
import type { MarketDataSource } from "../src/infrastructure/polymarket/market-data.js";
import { makeEvent, makeMarket, testConfig } from "./helpers.js";

describe("MarketScanner", () => {
  it("uses current duration/type filters while ignoring progress as an eligibility cut-off", async () => {
    const requestedWindows: unknown[] = [];
    const source: MarketDataSource = {
      listOpenEvents: async (request) => {
        requestedWindows.push(request);
        return [makeEvent()];
      },
      fetchOrderBooks: async (tokenIds) =>
        tokenIds.map(
          (tokenId) =>
            ({
              tokenId,
              conditionId: "0xcondition",
              bids: [{ price: tokenId === "yes-token" ? "0.01" : "0.97", size: "30" }],
              asks: [{ price: tokenId === "yes-token" ? "0.03" : "0.99", size: "30" }],
              minOrderSize: "5",
              tickSize: "0.01",
              negRisk: false,
              hash: "hash",
            }) as unknown as OrderBook,
        ),
    };
    let filters = {
      resultCounts: [2] as Array<2 | 3>,
      maxBuyPriceMicros: 30_000,
      maxMarketDurationDays: 7,
      maxMarketProgressPercent: 5,
      allCategories: true,
      selectedCategories: [] as string[],
      candidateSortDirection: "ASC" as const,
      orderBudgetMicros: 1_000_000,
    };
    const scanner = new MarketScanner(source, testConfig, {
      getMarketScanPreferences: () => filters,
    });
    const now = new Date("2026-01-02T00:00:00.000Z");

    expect(await scanner.scan(now)).toEqual([]);
    filters = { ...filters, maxMarketDurationDays: 14 };
    expect(await scanner.scan(now)).toHaveLength(2);
    filters = { ...filters, resultCounts: [3] };
    expect(await scanner.scan(now)).toEqual([]);

    expect(requestedWindows[0]).toMatchObject({
      startDateMin: "2025-12-26T00:00:00.000Z",
      endDateMax: "2026-01-09T00:00:00.000Z",
    });
    expect(requestedWindows[1]).toMatchObject({
      startDateMin: "2025-12-19T00:00:00.000Z",
      endDateMax: "2026-01-16T00:00:00.000Z",
    });
  });

  it("passes the cancellation signal through both scan stages", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const source: MarketDataSource = {
      listOpenEvents: async (_request, _reportProgress, signal) => {
        signals.push(signal);
        return [makeEvent()];
      },
      fetchOrderBooks: async (_tokenIds, _reportProgress, signal) => {
        signals.push(signal);
        return [];
      },
    };
    const scanner = new MarketScanner(source, testConfig);

    await scanner.scan(new Date("2026-01-02T00:00:00.000Z"), controller.signal);

    expect(signals).toEqual([controller.signal, controller.signal]);
  });

  it("monitors every structurally eligible token without a local market cap", async () => {
    const events = Array.from({ length: 121 }, (_, index) =>
      makeEvent({
        id: `event-${index}`,
        markets: [
          makeMarket({
            id: `market-${index}`,
            conditionId: `condition-${index}`,
            outcomes: {
              yes: {
                label: "Yes",
                tokenId: `yes-token-${index}`,
                price: "0.02",
              },
              no: {
                label: "No",
                tokenId: `no-token-${index}`,
                price: "0.98",
              },
            },
          }),
        ],
      }),
    );
    let requestedWindow: unknown;
    let eventsProgress: unknown;
    let booksProgress: unknown;
    let scanner: MarketScanner;
    const source: MarketDataSource = {
      listOpenEvents: async (request, reportProgress) => {
        requestedWindow = request;
        reportProgress?.({
          pageCount: 3,
          eventCount: events.length,
          requestCount: 4,
          retryCount: 1,
          rateLimitCount: 1,
          transientErrorCount: 1,
        });
        eventsProgress = scanner.getLastDiagnostics();
        return events;
      },
      fetchOrderBooks: async (tokenIds, reportProgress) => {
        reportProgress?.({
          batchCount: 5,
          orderBookCount: tokenIds.length,
          requestCount: 6,
          retryCount: 1,
          rateLimitCount: 0,
          transientErrorCount: 1,
        });
        booksProgress = scanner.getLastDiagnostics();
        return tokenIds.map((tokenId) => {
          const isYes = tokenId.startsWith("yes-");
          return {
            tokenId,
            conditionId: `condition-${tokenId
              .replace("yes-token-", "")
              .replace("no-token-", "")}`,
            bids: [{ price: isYes ? "0.01" : "0.97", size: "30" }],
            asks: [{ price: isYes ? "0.03" : "0.99", size: "30" }],
            minOrderSize: "5",
            tickSize: "0.01",
            negRisk: false,
            hash: "hash",
          } as unknown as OrderBook;
        });
      },
    };

    scanner = new MarketScanner(source, testConfig);
    const candidates = await scanner.scan(
      new Date("2026-01-02T00:00:00.000Z"),
    );

    expect(candidates).toHaveLength(242);
    expect(candidates.map((candidate) => candidate.tokenId)).toContain(
      "yes-token-120",
    );
    expect(candidates.map((candidate) => candidate.tokenId)).toContain(
      "no-token-120",
    );
    expect(requestedWindow).toEqual({
      pageSize: 50,
      startDateMin: "2025-12-03T00:00:00.000Z",
      startDateMax: "2026-01-02T00:00:00.000Z",
      endDateMin: "2026-01-02T00:00:00.000Z",
      endDateMax: "2026-02-01T00:00:00.000Z",
    });
    expect(eventsProgress).toMatchObject({
      phase: "EVENTS",
      completedAt: null,
      eventPageCount: 3,
      eventCount: 121,
      eventPageRequestCount: 4,
      retryCount: 1,
      rateLimitCount: 1,
      transientErrorCount: 1,
    });
    expect(booksProgress).toMatchObject({
      phase: "ORDER_BOOKS",
      completedAt: null,
      orderBookBatchCount: 5,
      orderBookCount: 242,
      eventPageRequestCount: 4,
      orderBookRequestCount: 6,
      retryCount: 2,
      rateLimitCount: 1,
      transientErrorCount: 2,
    });
    expect(scanner.getLastDiagnostics()).toMatchObject({
      phase: "COMPLETE",
      eventPageCount: 3,
      orderBookBatchCount: 5,
      eventPageRequestCount: 4,
      orderBookRequestCount: 6,
      retryCount: 2,
      rateLimitCount: 1,
      transientErrorCount: 2,
      eventCount: 121,
      eligibleTokenCount: 242,
      orderBookCount: 242,
      candidateCount: 121,
      monitoredTokenCount: 242,
      durationMs: expect.any(Number),
    });
  });

  it("retains failed-scan diagnostics", async () => {
    const source: MarketDataSource = {
      listOpenEvents: async (_request, reportProgress) => {
        reportProgress?.({
          pageCount: 2,
          eventCount: 100,
          requestCount: 3,
          retryCount: 2,
          rateLimitCount: 2,
          transientErrorCount: 3,
        });
        throw new Error("temporary Gamma failure");
      },
      fetchOrderBooks: async () => [],
    };
    const scanner = new MarketScanner(source, testConfig);

    await expect(scanner.scan()).rejects.toThrow("temporary Gamma failure");
    expect(scanner.getLastDiagnostics()).toMatchObject({
      phase: "FAILED",
      completedAt: expect.any(String),
      eventPageCount: 2,
      eventCount: 100,
      eventPageRequestCount: 3,
      retryCount: 2,
      rateLimitCount: 2,
      transientErrorCount: 3,
    });
  });

  it("builds low-price YES candidates from official data shapes", async () => {
    const event = makeEvent();
    const source: MarketDataSource = {
      listOpenEvents: async () => [event],
      fetchOrderBooks: async (tokenIds) =>
        tokenIds.map(
          (tokenId) =>
            ({
              tokenId,
              conditionId: "0xcondition",
              bids:
                tokenId === "yes-token"
                  ? [{ price: "0.01", size: "30" }]
                  : [{ price: "0.97", size: "30" }],
              asks:
                tokenId === "yes-token"
                  ? [{ price: "0.03", size: "30" }]
                  : [{ price: "0.99", size: "30" }],
              minOrderSize: "5",
              tickSize: "0.01",
              negRisk: false,
              hash: "hash",
            }) as unknown as OrderBook,
        ),
    };

    const scanner = new MarketScanner(source, testConfig);
    const candidates = await scanner.scan(
      new Date("2026-01-02T00:00:00.000Z"),
    );

    expect(candidates).toHaveLength(2);
    const yes = candidates.find((candidate) => candidate.direction === "YES");
    const no = candidates.find((candidate) => candidate.direction === "NO");
    expect(yes?.executableBuyPriceMicros).toBe(30_000);
    expect(yes?.fixedSellPriceMicros).toBe(50_000);
    expect(no?.executableBuyPriceMicros).toBe(990_000);
    expect(scanner.getLastDiagnostics()).toMatchObject({
      candidateCount: 1,
      monitoredTokenCount: 2,
    });
  });
});
