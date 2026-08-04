import type { OrderBook } from "@polymarket/client";
import { describe, expect, it } from "vitest";
import { MarketScanner } from "../src/domain/market-scanner.js";
import type { MarketDataSource } from "../src/infrastructure/polymarket/market-data.js";
import { makeEvent, makeMarket, testConfig } from "./helpers.js";

describe("MarketScanner", () => {
  it("returns candidates from every eligible token", async () => {
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
        reportProgress?.({ pageCount: 3, eventCount: events.length });
        eventsProgress = scanner.getLastDiagnostics();
        return events;
      },
      fetchOrderBooks: async (tokenIds, reportProgress) => {
        reportProgress?.({ batchCount: 5, orderBookCount: tokenIds.length });
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

    expect(candidates).toHaveLength(121);
    expect(candidates[0]?.tokenId).toBe("yes-token-0");
    expect(candidates.at(-1)?.tokenId).toBe("yes-token-120");
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
    });
    expect(booksProgress).toMatchObject({
      phase: "ORDER_BOOKS",
      completedAt: null,
      orderBookBatchCount: 5,
      orderBookCount: 242,
    });
    expect(scanner.getLastDiagnostics()).toMatchObject({
      phase: "COMPLETE",
      eventPageCount: 3,
      orderBookBatchCount: 5,
      eventCount: 121,
      eligibleTokenCount: 242,
      orderBookCount: 242,
      candidateCount: 121,
      durationMs: expect.any(Number),
    });
  });

  it("retains failed-scan diagnostics", async () => {
    const source: MarketDataSource = {
      listOpenEvents: async (_request, reportProgress) => {
        reportProgress?.({ pageCount: 2, eventCount: 100 });
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

    const candidates = await new MarketScanner(source, testConfig).scan(
      new Date("2026-01-02T00:00:00.000Z"),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.direction).toBe("YES");
    expect(candidates[0]?.makerBuyPriceMicros).toBe(20_000);
    expect(candidates[0]?.fixedSellPriceMicros).toBe(30_000);
  });
});
