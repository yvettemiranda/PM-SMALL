import type { OrderBook } from "@polymarket/client";
import { describe, expect, it } from "vitest";
import { MarketScanner } from "../src/domain/market-scanner.js";
import type { MarketDataSource } from "../src/infrastructure/polymarket/market-data.js";
import { makeEvent, testConfig } from "./helpers.js";

describe("MarketScanner", () => {
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
