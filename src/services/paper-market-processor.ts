import { createHash } from "node:crypto";
import type {
  BookLevel,
  MarketBookSnapshot,
  MarketPriceChange,
  MarketStreamEvent,
  MarketTrade,
  PaperOrderSide,
  TokenOrderBook,
  TradeCandidate,
} from "../domain/types.js";
import type { TradingExecutionAdapter } from "../domain/execution.js";
import type { PaperDatabase } from "../infrastructure/db/database.js";
import { TestExecutor } from "../infrastructure/execution/test-executor.js";

type BookState = {
  bids: Map<number, number>;
  asks: Map<number, number>;
  snapshotTimestampMs: number | null;
  revision: number;
  bidExternalVersion: string;
  askExternalVersion: string;
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
  private bookRevisionCounter = 0;

  public constructor(
    private readonly database: PaperDatabase,
    private readonly executor: TradingExecutionAdapter = new TestExecutor(
      database,
    ),
  ) {
    if (!executor.enabled) {
      throw new Error("PaperMarketProcessor requires an enabled execution adapter");
    }
  }

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

  public getBestAskMicros(tokenId: string): number | null {
    if (!this.readyTokens.has(tokenId)) {
      return null;
    }
    const book = this.books.get(tokenId);
    if (book === undefined) {
      return null;
    }
    let bestAsk: number | null = null;
    for (const [priceMicros, sizeMicros] of book.asks) {
      if (sizeMicros > 0 && (bestAsk === null || priceMicros < bestAsk)) {
        bestAsk = priceMicros;
      }
    }
    return bestAsk;
  }

  public getOrderBookRevision(tokenId: string): number | null {
    return this.readyTokens.has(tokenId)
      ? (this.books.get(tokenId)?.revision ?? null)
      : null;
  }

  public consumeTestBuyLiquidity(
    _tokenId: string,
    _consumedAsks: readonly BookLevel[],
  ): void {
    // TEST depth consumption is persisted by book version in SQLite. Keep the
    // streamed book as the external source of truth for quotes and recovery.
  }

  public getOrderBook(candidate: TradeCandidate): TokenOrderBook | null {
    if (!this.readyTokens.has(candidate.tokenId)) {
      return null;
    }
    const book = this.books.get(candidate.tokenId);
    if (book === undefined) {
      return null;
    }
    return {
      tokenId: candidate.tokenId,
      conditionId: candidate.conditionId,
      bookVersion: book.askExternalVersion,
      bids: mapToLevels(book.bids),
      asks: mapToLevels(book.asks),
      minOrderSizeMicros: candidate.minOrderSizeMicros,
      tickSizeMicros: candidate.tickSizeMicros,
      isNegativeRisk: candidate.isNegativeRisk,
    };
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
    const bids = levelsToMap(event.bids);
    const asks = levelsToMap(event.asks);
    this.books.set(event.tokenId, {
      bids,
      asks,
      snapshotTimestampMs: event.timestampMs,
      revision: ++this.bookRevisionCounter,
      bidExternalVersion: snapshotVersion("BID", mapToLevels(bids)),
      askExternalVersion: snapshotVersion("ASK", mapToLevels(asks)),
    });
    if (requiresRebase) {
      this.database.rebaseActivePaperOrderQueues(
        event.tokenId,
        event.bids,
        event.asks,
      );
    }
    this.readyTokens.add(event.tokenId);
    this.executeTargetSells(event.tokenId);
  }

  private handlePriceChange(event: MarketPriceChange): void {
    const book = this.books.get(event.tokenId);
    if (book === undefined || !this.readyTokens.has(event.tokenId)) {
      return;
    }

    const levels = event.side === "BUY" ? book.bids : book.asks;
    const previousSizeMicros = levels.get(event.priceMicros) ?? 0;
    if (previousSizeMicros === event.sizeMicros) {
      this.executeTargetSells(event.tokenId);
      return;
    }
    if (event.sizeMicros === 0) {
      levels.delete(event.priceMicros);
    } else {
      levels.set(event.priceMicros, event.sizeMicros);
    }
    book.revision = ++this.bookRevisionCounter;
    if (event.side === "BUY") {
      book.bidExternalVersion = snapshotVersion(
        "BID",
        mapToLevels(book.bids),
      );
    } else {
      book.askExternalVersion = snapshotVersion(
        "ASK",
        mapToLevels(book.asks),
      );
    }
    this.executeTargetSells(event.tokenId);
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
          order.executionKind === "LEGACY_MAKER" &&
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

  public executeTargetSells(tokenId: string): void {
    const book = this.books.get(tokenId);
    const metadata = this.database.getTestMarketExecutionMetadata(tokenId);
    if (
      book === undefined ||
      metadata === null ||
      metadata.minOrderSizeMicros <= 0
    ) {
      return;
    }
    const intent = {
      tokenId,
      bookVersion: book.bidExternalVersion,
      bids: mapToLevels(book.bids),
      minOrderSizeMicros: metadata.minOrderSizeMicros,
      feeRateMicros: metadata.feeRateMicros,
      feeExponent: metadata.feeExponent,
    };
    const stopLoss = this.executor.executeStopLoss({
      ...intent,
      observedAt: new Date(),
    });
    const targets = this.executor.executeTargetSells(intent);
    this.paperSellFillCount +=
      stopLoss.filledOrderCount + targets.filledOrderCount;
  }

  private isIncludedInSnapshot(event: MarketTrade, book: BookState): boolean {
    return (
      event.timestampMs !== null &&
      book.snapshotTimestampMs !== null &&
      event.timestampMs <= book.snapshotTimestampMs
    );
  }
}

function snapshotVersion(
  side: "BID" | "ASK",
  levels: readonly BookLevel[],
): string {
  const hash = createHash("sha256");
  hash.update(side);
  hash.update(JSON.stringify(canonicalLevels(levels)));
  return `BOOK:${side}:${hash.digest("hex")}`;
}

function canonicalLevels(levels: readonly BookLevel[]): BookLevel[] {
  return levels
    .map((level) => ({ ...level }))
    .sort(
      (left, right) =>
        left.priceMicros - right.priceMicros ||
        left.sizeMicros - right.sizeMicros,
    );
}

function mapToLevels(levels: ReadonlyMap<number, number>): BookLevel[] {
  return Array.from(levels, ([priceMicros, sizeMicros]) => ({
    priceMicros,
    sizeMicros,
  }));
}

function oppositeSide(side: PaperOrderSide): PaperOrderSide {
  return side === "BUY" ? "SELL" : "BUY";
}
