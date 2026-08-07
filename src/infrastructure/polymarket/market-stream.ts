import { createHash } from "node:crypto";
import { z } from "zod";
import { decimalStringToMicros } from "../../domain/price.js";
import type {
  MarketStreamEvent,
  PaperOrderSide,
} from "../../domain/types.js";

const MARKET_STREAM_URL =
  "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const CONNECT_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_STALE_MS = 30_000;
const HEARTBEAT_WATCHDOG_INTERVAL_MS = 5_000;
const SUBSCRIPTION_BATCH_SIZE = 500;

const timestampSchema = z.union([z.string(), z.number()]).nullish();
const levelSchema = z.object({
  price: z.string(),
  size: z.string(),
});
const rawMarketEventSchema = z.discriminatedUnion("event_type", [
  z.object({
    event_type: z.literal("book"),
    asset_id: z.string(),
    bids: z.array(levelSchema),
    asks: z.array(levelSchema),
    timestamp: timestampSchema,
  }),
  z.object({
    event_type: z.literal("price_change"),
    price_changes: z.array(
      z.object({
        asset_id: z.string(),
        side: z.enum(["BUY", "SELL"]),
        price: z.string(),
        size: z.string(),
      }),
    ),
    timestamp: timestampSchema,
  }),
  z.object({
    event_type: z.literal("last_trade_price"),
    asset_id: z.string(),
    side: z.enum(["BUY", "SELL"]),
    price: z.string(),
    size: z.string().nullish(),
    timestamp: timestampSchema,
    transaction_hash: z.string().nullish(),
  }),
]);

export interface MarketStreamHandle extends AsyncIterable<MarketStreamEvent> {
  updateSubscriptions(update: MarketStreamSubscriptionUpdate): Promise<void>;
  close(): Promise<void>;
}

export type MarketStreamSubscriptionUpdate = {
  subscribe: readonly string[];
  unsubscribe: readonly string[];
};

export interface MarketStreamSource {
  subscribe(tokenIds: readonly string[]): Promise<MarketStreamHandle>;
}

export class PolymarketMarketStreamSource implements MarketStreamSource {
  public async subscribe(
    tokenIds: readonly string[],
  ): Promise<MarketStreamHandle> {
    if (tokenIds.length === 0) {
      throw new Error("At least one token is required for a market subscription");
    }

    const queue = new AsyncEventQueue<MarketStreamEvent>();
    const socket = new WebSocket(MARKET_STREAM_URL);
    let closing = false;
    let heartbeat: NodeJS.Timeout | null = null;
    let heartbeatWatchdog: NodeJS.Timeout | null = null;
    let lastPongAt = 0;
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const clearHeartbeatTimers = (): void => {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (heartbeatWatchdog !== null) {
        clearInterval(heartbeatWatchdog);
        heartbeatWatchdog = null;
      }
    };

    const opened = new Promise<void>((resolve, reject) => {
      socket.addEventListener(
        "open",
        () => {
          try {
            // The documented default has not been reliable for large public
            // subscriptions, so request the initial order-book dump explicitly.
            const [initialTokenIds, ...additionalTokenIdBatches] =
              chunkTokenIds(tokenIds);
            socket.send(
              JSON.stringify({
                type: "market",
                assets_ids: initialTokenIds,
                initial_dump: true,
              }),
            );
            for (const additionalTokenIds of additionalTokenIdBatches) {
              sendSubscriptionOperation(
                socket,
                "subscribe",
                additionalTokenIds,
              );
            }
            lastPongAt = Date.now();
            heartbeat = setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) {
                try {
                  socket.send("PING");
                } catch {
                  closeSocket(socket);
                }
              }
            }, HEARTBEAT_INTERVAL_MS);
            heartbeat.unref();
            heartbeatWatchdog = setInterval(() => {
              if (Date.now() - lastPongAt > HEARTBEAT_STALE_MS) {
                closeSocket(socket);
              }
            }, HEARTBEAT_WATCHDOG_INTERVAL_MS);
            heartbeatWatchdog.unref();
            resolve();
          } catch (error) {
            reject(error);
          }
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => reject(new Error("Polymarket market WebSocket connection failed")),
        { once: true },
      );
    });

    socket.addEventListener("message", (message) => {
      if (message.data === "PONG") {
        lastPongAt = Date.now();
        return;
      }
      if (typeof message.data !== "string") {
        return;
      }
      try {
        const payload: unknown = JSON.parse(message.data);
        const rawEvents = Array.isArray(payload) ? payload : [payload];
        for (const rawEvent of rawEvents) {
          const parsed = rawMarketEventSchema.safeParse(rawEvent);
          if (!parsed.success) {
            continue;
          }
          for (const event of toMarketStreamEvents(parsed.data)) {
            queue.push(event);
          }
        }
      } catch {
        // Ignore malformed and unsupported public frames. A missing initial
        // snapshot remains visible through dataCompleteTokenCount upstream.
      }
    });
    socket.addEventListener("close", (event) => {
      clearHeartbeatTimers();
      resolveClosed();
      if (closing) {
        queue.end();
      } else {
        const reason = event.reason ?? "";
        queue.end(
          new Error(
            `Polymarket market WebSocket closed (${event.code}${
              reason.length === 0 ? "" : `: ${reason}`
            })`,
          ),
        );
      }
    });

    try {
      await withTimeout(
        opened,
        CONNECT_TIMEOUT_MS,
        `Polymarket market WebSocket did not open within ${CONNECT_TIMEOUT_MS}ms`,
      );
    } catch (error) {
      closing = true;
      closeSocket(socket);
      queue.end(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }

    let closePromise: Promise<void> | null = null;
    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        closing = true;
        clearHeartbeatTimers();
        closeSocket(socket);
        await Promise.race([closed, delay(CLOSE_TIMEOUT_MS)]);
        queue.end();
      })();
      return closePromise;
    };
    const updateSubscriptions = async (
      update: MarketStreamSubscriptionUpdate,
    ): Promise<void> => {
      if (closing || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Polymarket market WebSocket is not connected");
      }
      if (update.unsubscribe.length > 0) {
        for (const tokenIdBatch of chunkTokenIds(update.unsubscribe)) {
          sendSubscriptionOperation(socket, "unsubscribe", tokenIdBatch);
        }
      }
      if (update.subscribe.length > 0) {
        for (const tokenIdBatch of chunkTokenIds(update.subscribe)) {
          sendSubscriptionOperation(socket, "subscribe", tokenIdBatch);
        }
      }
    };

    return {
      updateSubscriptions,
      close,
      [Symbol.asyncIterator]() {
        return queue;
      },
    };
  }
}

function chunkTokenIds(tokenIds: readonly string[]): string[][] {
  return Array.from(
    { length: Math.ceil(tokenIds.length / SUBSCRIPTION_BATCH_SIZE) },
    (_, index) =>
      tokenIds.slice(
        index * SUBSCRIPTION_BATCH_SIZE,
        index * SUBSCRIPTION_BATCH_SIZE + SUBSCRIPTION_BATCH_SIZE,
      ),
  );
}

function sendSubscriptionOperation(
  socket: WebSocket,
  operation: "subscribe" | "unsubscribe",
  tokenIds: readonly string[],
): void {
  socket.send(
    JSON.stringify({
      operation,
      assets_ids: [...tokenIds],
    }),
  );
}

type RawMarketEvent = z.infer<typeof rawMarketEventSchema>;

function toMarketStreamEvents(event: RawMarketEvent): MarketStreamEvent[] {
  if (event.event_type === "book") {
    return [
      {
        type: "book",
        tokenId: event.asset_id,
        bids: event.bids.map((level) => ({
          priceMicros: decimalStringToMicros(level.price),
          sizeMicros: decimalStringToMicros(level.size),
        })),
        asks: event.asks.map((level) => ({
          priceMicros: decimalStringToMicros(level.price),
          sizeMicros: decimalStringToMicros(level.size),
        })),
        timestampMs: toTimestamp(event.timestamp),
      },
    ];
  }

  if (event.event_type === "price_change") {
    const timestampMs = toTimestamp(event.timestamp);
    return event.price_changes.map((change) => ({
      type: "price_change",
      tokenId: change.asset_id,
      side: toPaperSide(change.side),
      priceMicros: decimalStringToMicros(change.price),
      sizeMicros: decimalStringToMicros(change.size),
      timestampMs,
    }));
  }

  if (event.size === undefined || event.size === null) {
    return [];
  }
  const sizeMicros = decimalStringToMicros(event.size);
  if (sizeMicros <= 0) {
    return [];
  }
  const takerSide = toPaperSide(event.side);
  const priceMicros = decimalStringToMicros(event.price);
  const timestampMs = toTimestamp(event.timestamp);
  return [
    {
      type: "trade",
      sourceTradeId: createTradeId({
        transactionHash: event.transaction_hash ?? null,
        tokenId: event.asset_id,
        takerSide,
        priceMicros,
        sizeMicros,
        timestampMs,
      }),
      tokenId: event.asset_id,
      takerSide,
      priceMicros,
      sizeMicros,
      timestampMs,
    },
  ];
}

class AsyncEventQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  private ended = false;
  private error: Error | null = null;

  public push(value: T): void {
    if (this.ended) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.values.push(value);
    } else {
      waiter.resolve({ done: false, value });
    }
  }

  public end(error: Error | null = null): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) {
      if (error === null) {
        waiter.resolve({ done: true, value: undefined });
      } else {
        waiter.reject(error);
      }
    }
  }

  public next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.ended) {
      return this.error === null
        ? Promise.resolve({ done: true, value: undefined })
        : Promise.reject(this.error);
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  public return(): Promise<IteratorResult<T>> {
    this.end();
    return Promise.resolve({ done: true, value: undefined });
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function closeSocket(socket: WebSocket): void {
  if (socket.readyState >= WebSocket.CLOSING) {
    return;
  }
  try {
    socket.close();
  } catch {
    // The process-level deadline remains the final bound for a connecting
    // socket that the runtime refuses to close synchronously.
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
