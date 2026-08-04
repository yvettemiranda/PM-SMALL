import type { OrderBook } from "@polymarket/client";
import type { AppConfig } from "../config.js";
import type { MarketDataSource } from "../infrastructure/polymarket/market-data.js";
import { extractEligibleTokens, filterEligibleEvent } from "./event-filter.js";
import { buildTradeCandidate, decimalStringToMicros } from "./price.js";
import type { TokenOrderBook, TradeCandidate } from "./types.js";

function normalizeOrderBook(book: OrderBook): TokenOrderBook {
  return {
    tokenId: String(book.tokenId),
    conditionId: String(book.conditionId),
    bids: book.bids.map((level) => ({
      priceMicros: decimalStringToMicros(level.price),
      sizeMicros: decimalStringToMicros(level.size),
    })),
    asks: book.asks.map((level) => ({
      priceMicros: decimalStringToMicros(level.price),
      sizeMicros: decimalStringToMicros(level.size),
    })),
    minOrderSizeMicros: decimalStringToMicros(book.minOrderSize),
    tickSizeMicros: decimalStringToMicros(book.tickSize),
    isNegativeRisk: book.negRisk,
  };
}

export interface CandidateScanner {
  scan(now?: Date): Promise<TradeCandidate[]>;
}

export class MarketScanner implements CandidateScanner {
  public constructor(
    private readonly marketData: MarketDataSource,
    private readonly config: AppConfig,
  ) {}

  public async scan(now: Date = new Date()): Promise<TradeCandidate[]> {
    // The data source has already traversed every open-event page. Keep all
    // eligible tokens here; only domain filters and order-book rules may reject.
    const events = await this.marketData.listOpenEvents(
      this.config.scanEventPageSize,
    );
    const tokens = events
      .flatMap((event) => {
        const eligibleEvent = filterEligibleEvent(event, this.config, now);
        return eligibleEvent === null
          ? []
          : extractEligibleTokens(event, eligibleEvent, now);
      });

    if (tokens.length === 0) {
      return [];
    }

    const books = await this.marketData.fetchOrderBooks(
      tokens.map((token) => token.tokenId),
    );
    const bookByToken = new Map(
      books.map((book) => {
        const normalized = normalizeOrderBook(book);
        return [normalized.tokenId, normalized] as const;
      }),
    );

    return tokens.flatMap((token) => {
      const book = bookByToken.get(token.tokenId);
      if (book === undefined || book.isNegativeRisk !== token.isNegativeRisk) {
        return [];
      }

      const candidate = buildTradeCandidate(
        token,
        book,
        this.config.orderBudgetMicros,
        this.config.minBuyPriceMicros,
        this.config.maxBuyPriceMicros,
      );
      return candidate === null ? [] : [candidate];
    });
  }
}
