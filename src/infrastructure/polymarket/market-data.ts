import {
  createPublicClient,
  type Event,
  type OrderBook,
  type PublicClient,
} from "@polymarket/client";

export interface MarketDataSource {
  listOpenEvents(pageSize: number): Promise<Event[]>;
  fetchOrderBooks(tokenIds: string[]): Promise<OrderBook[]>;
}

export class PolymarketMarketDataSource implements MarketDataSource {
  private readonly client: PublicClient;

  public constructor(client: PublicClient = createPublicClient()) {
    this.client = client;
  }

  public async listOpenEvents(pageSize: number): Promise<Event[]> {
    const page = await this.client
      .listEvents({
        closed: false,
        pageSize,
      })
      .firstPage();
    return page.items;
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
}
