import type {
  BookLevel,
  MarketBookSnapshot,
  MarketPriceChange,
  MarketStreamEvent,
  MarketTrade,
  PaperOrderSide,
} from "../domain/types.js";
import type { PaperDatabase } from "../infrastructure/db/database.js";

type BookState = {
  bids: Map<number, number>;
  asks: Map<number, number>;
  snapshotTimestampMs: number | null;
};

export type PaperMarketProcessorStatus = {
  dataCompleteTokenCount: number;
  lastEventAt: string | null;
  processedTradeEvents: number;
  ignoredTradeEvents: number;
  paperBuyFillCount: number;
  paperSellFillCount: number;
  createdPaperSellCount: number;
};

function levelsToMap(levels: BookLevel[]): Map<number, number> {
  return new Map(levels.map((level) => [level.priceMicros, level.sizeMicros]));
}

export class PaperMarketProcessor {
  private readonly books = new Map<string, BookState>();
  private readonly readyTokens = new Set<string>();
  private lastEventAt: string | null = null;
  private processedTradeEvents = 0;
  private ignoredTradeEvents = 0;
  private paperBuyFillCount = 0;
  private paperSellFillCount = 0;
  private createdPaperSellCount = 0;

  public constructor(private readonly database: PaperDatabase) {}

  public handle(event: MarketStreamEvent): void {
    this.lastEventAt = new Date().toISOString();
    if (event.type === "book") {
      this.handleBook(event);
    } else if (event.type === "price_change") {
      this.handlePriceChange(event);
    } else {
      this.handleTrade(event);
    }
  }

  public markDisconnected(tokenIds: readonly string[]): void {
    for (const tokenId of tokenIds) {
      this.readyTokens.delete(tokenId);
      this.books.delete(tokenId);
    }
  }

  public isTokenReady(tokenId: string): boolean {
    return this.readyTokens.has(tokenId);
  }

  public getBestBidMicros(tokenId: string): number | null {
    if (!this.readyTokens.has(tokenId)) {
      return null;
    }
    const book = this.books.get(tokenId);
    if (book === undefined) {
      return null;
    }
    let bestBid: number | null = null;
    for (const [priceMicros, sizeMicros] of book.bids) {
      if (sizeMicros > 0 && (bestBid === null || priceMicros > bestBid)) {
        bestBid = priceMicros;
      }
    }
    return bestBid;
  }

  public getStatus(): PaperMarketProcessorStatus {
    return {
      dataCompleteTokenCount: this.readyTokens.size,
      lastEventAt: this.lastEventAt,
      processedTradeEvents: this.processedTradeEvents,
      ignoredTradeEvents: this.ignoredTradeEvents,
      paperBuyFillCount: this.paperBuyFillCount,
      paperSellFillCount: this.paperSellFillCount,
      createdPaperSellCount: this.createdPaperSellCount,
    };
  }

  private handleBook(event: MarketBookSnapshot): void {
    const requiresRebase = !this.readyTokens.has(event.tokenId);
    this.books.set(event.tokenId, {
      bids: levelsToMap(event.bids),
      asks: levelsToMap(event.asks),
      snapshotTimestampMs: event.timestampMs,
    });
    if (requiresRebase) {
      this.database.rebaseActivePaperOrderQueues(
        event.tokenId,
        event.bids,
        event.asks,
      );
    }
    this.readyTokens.add(event.tokenId);
  }

  private handlePriceChange(event: MarketPriceChange): void {
    const book = this.books.get(event.tokenId);
    if (book === undefined || !this.readyTokens.has(event.tokenId)) {
      return;
    }

    const levels = event.side === "BUY" ? book.bids : book.asks;
    if (event.sizeMicros === 0) {
      levels.delete(event.priceMicros);
    } else {
      levels.set(event.priceMicros, event.sizeMicros);
    }
  }

  private handleTrade(event: MarketTrade): void {
    const book = this.books.get(event.tokenId);
    if (
      book === undefined ||
      !this.readyTokens.has(event.tokenId) ||
      this.isIncludedInSnapshot(event, book)
    ) {
      this.ignoredTradeEvents += 1;
      return;
    }

    const orders = this.database
      .listActivePaperOrders(event.tokenId)
      .filter(
        (order) =>
          order.side === oppositeSide(event.takerSide) &&
          order.priceMicros === event.priceMicros,
      );

    for (const order of orders) {
      const targetSellPrice = order.targetSellPriceMicros;
      const sellRealQueueAheadSizeMicros =
        targetSellPrice === null ? 0 : (book.asks.get(targetSellPrice) ?? 0);
      const applied = this.database.applyPaperTrade({
        orderId: order.id,
        sourceTradeId: event.sourceTradeId,
        tradePriceMicros: event.priceMicros,
        tradeSizeMicros: event.sizeMicros,
        dataComplete: true,
        sellRealQueueAheadSizeMicros,
      });
      if (applied.incrementalFillSizeMicros > 0) {
        if (order.side === "BUY") {
          this.paperBuyFillCount += 1;
          if (applied.createdSellOrder !== null) {
            this.createdPaperSellCount += 1;
          }
        } else {
          this.paperSellFillCount += 1;
        }
      }
    }
    this.processedTradeEvents += 1;
  }

  private isIncludedInSnapshot(event: MarketTrade, book: BookState): boolean {
    return (
      event.timestampMs !== null &&
      book.snapshotTimestampMs !== null &&
      event.timestampMs <= book.snapshotTimestampMs
    );
  }
}

function oppositeSide(side: PaperOrderSide): PaperOrderSide {
  return side === "BUY" ? "SELL" : "BUY";
}
