import { createHash } from "node:crypto";
import {
  createPublicClient,
  type PublicClient,
} from "@polymarket/client";
import { decimalStringToMicros } from "../../domain/price.js";
import type {
  MarketStreamEvent,
  PaperOrderSide,
} from "../../domain/types.js";

export interface MarketStreamHandle extends AsyncIterable<MarketStreamEvent> {
  close(): Promise<void>;
}

export interface MarketStreamSource {
  subscribe(tokenIds: readonly string[]): Promise<MarketStreamHandle>;
}

export class PolymarketMarketStreamSource implements MarketStreamSource {
  private readonly client: PublicClient;

  public constructor(client: PublicClient = createPublicClient()) {
    this.client = client;
  }

  public async subscribe(
    tokenIds: readonly string[],
  ): Promise<MarketStreamHandle> {
    if (tokenIds.length === 0) {
      throw new Error("At least one token is required for a market subscription");
    }

    const sdkHandle = await this.client.subscribe([
      { topic: "market", tokenIds },
    ]);

    return {
      close: () => sdkHandle.close(),
      async *[Symbol.asyncIterator]() {
        for await (const event of sdkHandle) {
          if (event.type === "book") {
            yield {
              type: "book",
              tokenId: event.payload.tokenId,
              bids: event.payload.bids.map((level) => ({
                priceMicros: decimalStringToMicros(level.price),
                sizeMicros: decimalStringToMicros(level.size),
              })),
              asks: event.payload.asks.map((level) => ({
                priceMicros: decimalStringToMicros(level.price),
                sizeMicros: decimalStringToMicros(level.size),
              })),
              timestampMs: toTimestamp(event.payload.timestamp),
            } satisfies MarketStreamEvent;
          } else if (event.type === "price_change") {
            const timestampMs = toTimestamp(event.payload.timestamp);
            for (const change of event.payload.priceChanges) {
              yield {
                type: "price_change",
                tokenId: change.tokenId,
                side: toPaperSide(change.side),
                priceMicros: decimalStringToMicros(change.price),
                sizeMicros: decimalStringToMicros(change.size),
                timestampMs,
              } satisfies MarketStreamEvent;
            }
          } else if (
            event.type === "last_trade_price" &&
            event.payload.size !== undefined &&
            event.payload.size !== null
          ) {
            const timestampMs = toTimestamp(event.payload.timestamp);
            const sizeMicros = decimalStringToMicros(event.payload.size);
            if (sizeMicros <= 0) {
              continue;
            }

            const takerSide = toPaperSide(event.payload.side);
            const priceMicros = decimalStringToMicros(event.payload.price);
            yield {
              type: "trade",
              sourceTradeId: createTradeId({
                transactionHash: event.payload.transactionHash ?? null,
                tokenId: event.payload.tokenId,
                takerSide,
                priceMicros,
                sizeMicros,
                timestampMs,
              }),
              tokenId: event.payload.tokenId,
              takerSide,
              priceMicros,
              sizeMicros,
              timestampMs,
            } satisfies MarketStreamEvent;
          }
        }
      },
    };
  }
}

function toPaperSide(side: string): PaperOrderSide {
  if (side !== "BUY" && side !== "SELL") {
    throw new Error(`Unsupported market side: ${side}`);
  }
  return side;
}

function toTimestamp(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function createTradeId(input: {
  transactionHash: string | null;
  tokenId: string;
  takerSide: PaperOrderSide;
  priceMicros: number;
  sizeMicros: number;
  timestampMs: number | null;
}): string {
  return createHash("sha256")
    .update(
      [
        input.transactionHash ?? "",
        input.tokenId,
        input.takerSide,
        input.priceMicros,
        input.sizeMicros,
        input.timestampMs ?? "",
      ].join(":"),
    )
    .digest("hex");
}
