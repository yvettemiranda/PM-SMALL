import type { OrderBook } from "@polymarket/client";
import { describe, expect, it } from "vitest";
import { MarketScanner } from "../src/domain/market-scanner.js";
import type { MarketDataSource } from "../src/infrastructure/polymarket/market-data.js";
import { makeEvent, makeMarket, testConfig } from "./helpers.js";

describe("MarketScanner", () => {
  it("processes real event pages as a stream instead of retaining the full event graph", async () => {
    const first = makeEvent({ id: "streamed-event-1" });
    const second = makeEvent({
      id: "streamed-event-2",
      markets: [
        makeMarket({
          id: "streamed-market-2",
          conditionId: "streamed-condition-2",
          outcomes: {
            yes: { label: "Yes", tokenId: "streamed-yes-2", price: "0.02" },
            no: { label: "No", tokenId: "streamed-no-2", price: "0.98" },
          },
        }),
      ],
    });
    let listCalled = false;
    const source: MarketDataSource = {
      streamOpenEventPages: async function* () {
        yield [first];
        yield [second];
      },
      listOpenEvents: async () => {
        listCalled = true;
        return [];
      },
      fetchOrderBooks: async () => [],
    };
    const scanner = new MarketScanner(source, testConfig);

    const candidates = await scanner.scan(
      new Date("2026-01-02T00:00:00.000Z"),
    );

    expect(listCalled).toBe(false);
    expect(candidates).toHaveLength(4);
    expect(scanner.getLastDiagnostics()).toMatchObject({
      eventCount: 2,
      eligibleTokenCount: 4,
      monitoredTokenCount: 4,
    });
  });

  it("prefilters static rules before order books while retaining every matching token", async () => {
    const matchingMarket = makeMarket({
      id: "matching-market",
      conditionId: "matching-condition",
      outcomes: {
        yes: { label: "Yes", tokenId: "matching-yes", price: "0.99" },
        no: { label: "No", tokenId: "matching-no", price: "0.01" },
      },
    });
    const wrongCategoryMarket = makeMarket({
      id: "wrong-category-market",
      conditionId: "wrong-category-condition",
      outcomes: {
        yes: { label: "Yes", tokenId: "wrong-category-yes", price: "0.02" },
        no: { label: "No", tokenId: "wrong-category-no", price: "0.98" },
      },
    });
    const shortMarket = makeMarket({
      id: "short-market",
      conditionId: "short-condition",
      outcomes: {
        yes: { label: "Yes", tokenId: "short-yes", price: "0.02" },
        no: { label: "No", tokenId: "short-no", price: "0.98" },
      },
    });
    const events = [
      makeEvent({
        id: "matching-event",
        tags: [{ id: "2", label: "Politics", slug: "politics" }],
        markets: [matchingMarket],
      }),
      makeEvent({
        id: "wrong-category-event",
        tags: [{ id: "1", label: "Sports", slug: "sports" }],
        markets: [wrongCategoryMarket],
      }),
      makeEvent({
        id: "short-event",
        schedule: {
          startDate: "2026-01-01T00:00:00.000Z",
          endDate: "2026-01-06T00:00:00.000Z",
        },
        tags: [{ id: "2", label: "Politics", slug: "politics" }],
        markets: [shortMarket],
      }),
    ];
    let requestedTokenIds: readonly string[] = [];
    const source: MarketDataSource = {
      listOpenEvents: async () => events,
      fetchOrderBooks: async (tokenIds) => {
        requestedTokenIds = tokenIds;
        return [
          {
            tokenId: "matching-yes",
            conditionId: "matching-condition",
            bids: [{ price: "0.97", size: "30" }],
            asks: [{ price: "0.99", size: "30" }],
            minOrderSize: "5",
            tickSize: "0.01",
            negRisk: false,
            hash: "hash",
          } as unknown as OrderBook,
        ];
      },
    };
    const scanner = new MarketScanner(source, testConfig, {
      getMarketScanPreferences: () => ({
        resultCounts: [2],
        minBuyPriceMicros: 10_000,
        maxBuyPriceMicros: 30_000,
        minBidAskRatioPercent: 50,
        minMarketDurationDays: 7,
        maxMarketDurationDays: 30,
        maxMarketProgressPercent: 20,
        allCategories: false,
        selectedCategories: ["2"],
        candidateSortDirection: "ASC",
        orderBudgetMicros: 1_000_000,
      }),
    });

    const candidates = await scanner.scan(
      new Date("2026-01-02T00:00:00.000Z"),
    );

    expect(requestedTokenIds).toEqual(["matching-yes", "matching-no"]);
    expect(
      candidates.map((candidate) => candidate.tokenId).sort(),
    ).toEqual(["matching-no", "matching-yes"]);
    expect(scanner.getLastDiagnostics()).toMatchObject({
      eligibleTokenCount: 6,
      staticEligibleTokenCount: 2,
      orderBookTargetTokenCount: 2,
      monitoredTokenCount: 2,
      candidateCount: 0,
      rejectionCounts: {
        CATEGORY: 2,
        DURATION_BELOW_MIN: 2,
        ASK_ABOVE_MAX: 1,
        BOOK_NOT_READY: 1,
      },
    });
  });

  it("updates the monitored pool when static filters change", async () => {
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
              bids: [{ price: tokenId === "yes-token" ? "0.02" : "0.97", size: "30" }],
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
      minBuyPriceMicros: 10_000,
      minBidAskRatioPercent: 50,
      minMarketDurationDays: 1,
      maxMarketDurationDays: 7,
      maxMarketProgressPercent: 20,
      allCategories: true,
      selectedCategories: [] as string[],
      candidateSortDirection: "ASC" as const,
      orderBudgetMicros: 1_000_000,
    };
    const scanner = new MarketScanner(source, testConfig, {
      getMarketScanPreferences: () => filters,
    });
    const now = new Date("2026-01-02T00:00:00.000Z");

    expect(await scanner.scan(now)).toHaveLength(0);
    filters = { ...filters, maxMarketDurationDays: 14 };
    expect(await scanner.scan(now)).toHaveLength(2);
    filters = { ...filters, resultCounts: [3] };
    expect(await scanner.scan(now)).toHaveLength(0);

    expect(requestedWindows).toEqual([{ pageSize: 50 }, { pageSize: 50 }, { pageSize: 50 }]);
  });

  it("exposes only Polymarket homepage categories instead of every event tag", async () => {
    const event = makeEvent({
      tags: [
        { id: "2", label: "Politics", slug: "politics" },
        { id: "1001", label: "Abortion", slug: "abortion" },
      ],
    });
    const source = {
      listHomepageCategories: async () => [
        { id: "2", label: "Politics" },
        { id: "1", label: "Sports" },
      ],
      listOpenEvents: async () => [event],
      fetchOrderBooks: async () => [],
    } as MarketDataSource;
    const scanner = new MarketScanner(source, testConfig);

    await scanner.scan(new Date("2026-01-02T00:00:00.000Z"));

    expect(scanner.getLastDiagnostics()?.availableCategories).toEqual([
      { id: "2", label: "Politics" },
      { id: "1", label: "Sports" },
    ]);
  });

  it("publishes homepage categories while the event traversal is still running", async () => {
    let finishEvents!: () => void;
    const eventsPending = new Promise<never[]>((resolve) => {
      finishEvents = () => resolve([]);
    });
    const source: MarketDataSource = {
      listHomepageCategories: async () => [
        { id: "2", label: "Politics" },
        { id: "1", label: "Sports" },
      ],
      listOpenEvents: async () => eventsPending,
      fetchOrderBooks: async () => [],
    };
    const scanner = new MarketScanner(source, testConfig);

    const scan = scanner.scan(new Date("2026-01-02T00:00:00.000Z"));
    await Promise.resolve();
    await Promise.resolve();

    expect(scanner.getLastDiagnostics()).toMatchObject({
      phase: "EVENTS",
      availableCategories: [
        { id: "2", label: "Politics" },
        { id: "1", label: "Sports" },
      ],
    });

    finishEvents();
    await scan;
  });

  it("does not block candidate refresh when homepage category sync hangs", async () => {
    const source: MarketDataSource = {
      listHomepageCategories: async () => new Promise(() => {}),
      listOpenEvents: async () => [],
      fetchOrderBooks: async () => [],
    };
    const scanner = new MarketScanner(source, testConfig);

    const outcome = await Promise.race([
      scanner
        .scan(new Date("2026-01-02T00:00:00.000Z"))
        .then(() => "COMPLETE"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("BLOCKED"), 25);
      }),
    ]);

    expect(outcome).toBe("COMPLETE");
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
            bids: [{ price: isYes ? "0.02" : "0.97", size: "30" }],
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
    expect(requestedWindow).toEqual({ pageSize: 50 });
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

  it("keeps a structurally valid token monitored when its initial book is unavailable", async () => {
    const source: MarketDataSource = {
      listOpenEvents: async () => [makeEvent()],
      fetchOrderBooks: async () => [
        {
          tokenId: "yes-token",
          conditionId: "0xcondition",
          bids: [{ price: "0.02", size: "30" }],
          asks: [{ price: "0.03", size: "30" }],
          minOrderSize: "5",
          tickSize: "0.01",
          negRisk: false,
          hash: "hash",
        } as unknown as OrderBook,
      ],
    };

    const scanner = new MarketScanner(source, testConfig);
    const candidates = await scanner.scan(
      new Date("2026-01-02T00:00:00.000Z"),
    );

    expect(candidates).toHaveLength(2);
    expect(candidates.find((candidate) => candidate.tokenId === "yes-token")).toMatchObject({
      bookReady: true,
      bestBidMicros: 20_000,
    });
    expect(candidates.find((candidate) => candidate.tokenId === "no-token")).toMatchObject({
      bookReady: false,
      bestBidMicros: null,
      bestAskMicros: null,
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
                  ? [{ price: "0.02", size: "30" }]
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
