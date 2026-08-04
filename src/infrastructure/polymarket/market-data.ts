import {
  createPublicClient,
  type Event,
  type OrderBook,
  type PublicClient,
} from "@polymarket/client";
import { decimalStringToMicros } from "../../domain/price.js";
import type { PaperMarketResolution } from "../../domain/paper-settlement.js";

export interface MarketDataSource {
  /** Returns every page inside a scan window; exact filtering happens downstream. */
  listOpenEvents(
    request: OpenEventScanRequest,
    reportProgress?: (progress: OpenEventScanProgress) => void,
  ): Promise<Event[]>;
  fetchOrderBooks(
    tokenIds: string[],
    reportProgress?: (progress: OrderBookFetchProgress) => void,
  ): Promise<OrderBook[]>;
}

export type OpenEventScanRequest = {
  pageSize: number;
  startDateMin: string;
  startDateMax: string;
  endDateMin: string;
  endDateMax: string;
};

export type OpenEventScanProgress = {
  pageCount: number;
  eventCount: number;
};

export type OrderBookFetchProgress = {
  batchCount: number;
  orderBookCount: number;
};

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

  public async listOpenEvents(
    request: OpenEventScanRequest,
    reportProgress?: (progress: OpenEventScanProgress) => void,
  ): Promise<Event[]> {
    // Do not impose a local page or token cap. The date bounds are a safe
    // superset of the configured duration rule; exact checks remain downstream.
    const events: Event[] = [];
    const pages = this.client.listEvents({
      closed: false,
      ...request,
    });

    let pageCount = 0;
    for await (const page of pages) {
      events.push(...page.items);
      pageCount += 1;
      reportProgress?.({ pageCount, eventCount: events.length });
    }

    return events;
  }

  public async fetchOrderBooks(
    tokenIds: string[],
    reportProgress?: (progress: OrderBookFetchProgress) => void,
  ): Promise<OrderBook[]> {
    const books: OrderBook[] = [];
    let batchCount = 0;

    for (let offset = 0; offset < tokenIds.length; offset += 50) {
      const batch = tokenIds.slice(offset, offset + 50);
      const result = await this.client.fetchOrderBooks(
        batch.map((tokenId) => ({ tokenId })),
      );
      books.push(...result);
      batchCount += 1;
      reportProgress?.({ batchCount, orderBookCount: books.length });
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
