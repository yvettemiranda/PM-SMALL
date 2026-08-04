import {
  createPublicClient,
  type Event,
  type OrderBook,
  type PublicClient,
} from "@polymarket/client";
import { decimalStringToMicros } from "../../domain/price.js";
import type { PaperMarketResolution } from "../../domain/paper-settlement.js";

export interface MarketDataSource {
  /** Returns every page of currently open events; filtering happens downstream. */
  listOpenEvents(pageSize: number): Promise<Event[]>;
  fetchOrderBooks(tokenIds: string[]): Promise<OrderBook[]>;
}

export interface MarketResolutionSource {
  fetchMarketResolution(marketId: string): Promise<PaperMarketResolution>;
}

export class PolymarketMarketDataSource
  implements MarketDataSource, MarketResolutionSource
{
  private readonly client: PublicClient;

  public constructor(client: PublicClient = createPublicClient()) {
    this.client = client;
  }

  public async listOpenEvents(pageSize: number): Promise<Event[]> {
    // Do not impose a local page or token cap: the configured duration/progress
    // filters decide eligibility after the complete public event set is read.
    const events: Event[] = [];
    const pages = this.client.listEvents({
      closed: false,
      pageSize,
    });

    for await (const page of pages) {
      events.push(...page.items);
    }

    return events;
  }

  public async fetchOrderBooks(tokenIds: string[]): Promise<OrderBook[]> {
    const books: OrderBook[] = [];

    for (let offset = 0; offset < tokenIds.length; offset += 50) {
      const batch = tokenIds.slice(offset, offset + 50);
      const result = await this.client.fetchOrderBooks(
        batch.map((tokenId) => ({ tokenId })),
      );
      books.push(...result);
    }

    return books;
  }

  public async fetchMarketResolution(
    marketId: string,
  ): Promise<PaperMarketResolution> {
    const market = await this.client.fetchMarket({ id: marketId });
    return {
      marketId: String(market.id),
      conditionId:
        market.conditionId === null ? null : String(market.conditionId),
      closed: market.state.closed === true,
      resolutionStatus:
        market.resolution.umaResolutionStatus === null
          ? null
          : String(market.resolution.umaResolutionStatus),
      outcomes: [market.outcomes.yes, market.outcomes.no].map((outcome) => ({
        tokenId: outcome.tokenId === null ? null : String(outcome.tokenId),
        label: outcome.label,
        priceMicros: normalizeResolutionPrice(outcome.price),
      })),
    };
  }
}

function normalizeResolutionPrice(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const numeric = Number(value);
  const micros = decimalStringToMicros(value);
  // Do not let the six-decimal accounting conversion turn a transient value
  // such as 0.9999996 into an official 1/0 result.
  if (
    (micros === 0 || micros === 500_000 || micros === 1_000_000) &&
    numeric !== 0 &&
    numeric !== 0.5 &&
    numeric !== 1
  ) {
    return null;
  }
  return micros;
}
