import { afterEach, describe, expect, it, vi } from "vitest";
import { PolymarketMarketStreamSource } from "../src/infrastructure/polymarket/market-stream.js";

class FakeWebSocket extends EventTarget {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;
  public static latest: FakeWebSocket | null = null;

  public readonly sent: string[] = [];
  public readyState = FakeWebSocket.CONNECTING;

  public constructor(public readonly url: string) {
    super();
    FakeWebSocket.latest = this;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    const event = new Event("close");
    Object.assign(event, { code: 1000, reason: "" });
    this.dispatchEvent(event);
  }

  public emitMessage(data: string): void {
    const event = new Event("message");
    Object.assign(event, { data });
    this.dispatchEvent(event);
  }
}

describe("PolymarketMarketStreamSource", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeWebSocket.latest = null;
  });

  it("explicitly requests the initial order-book dump", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const source = new PolymarketMarketStreamSource();

    const handle = await source.subscribe(["token-1", "token-2"]);
    const socket = FakeWebSocket.latest;

    expect(socket).not.toBeNull();
    expect(socket?.url).toBe(
      "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    );
    expect(socket?.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "market",
      assets_ids: ["token-1", "token-2"],
      initial_dump: true,
    });

    await handle.close();
  });

  it("maps public book, price, and trade frames", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const source = new PolymarketMarketStreamSource();
    const handle = await source.subscribe(["token-1"]);
    const socket = FakeWebSocket.latest;
    const iterator = handle[Symbol.asyncIterator]();

    socket?.emitMessage(
      JSON.stringify([
        {
          event_type: "book",
          asset_id: "token-1",
          bids: [{ price: "0.02", size: "10" }],
          asks: [{ price: "0.03", size: "8" }],
          timestamp: "100",
        },
        {
          event_type: "price_change",
          price_changes: [
            {
              asset_id: "token-1",
              side: "BUY",
              price: "0.02",
              size: "9",
            },
          ],
          timestamp: "101",
        },
        {
          event_type: "last_trade_price",
          asset_id: "token-1",
          side: "SELL",
          price: "0.02",
          size: "3",
          timestamp: "102",
          transaction_hash: "0xtrade",
        },
      ]),
    );

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: "book",
        tokenId: "token-1",
        bids: [{ priceMicros: 20_000, sizeMicros: 10_000_000 }],
        asks: [{ priceMicros: 30_000, sizeMicros: 8_000_000 }],
        timestampMs: 100,
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: "price_change",
        tokenId: "token-1",
        side: "BUY",
        priceMicros: 20_000,
        sizeMicros: 9_000_000,
        timestampMs: 101,
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "trade",
        tokenId: "token-1",
        takerSide: "SELL",
        priceMicros: 20_000,
        sizeMicros: 3_000_000,
        timestampMs: 102,
        sourceTradeId: expect.any(String),
      },
    });

    await handle.close();
  });

  it("closes a connection that stops acknowledging heartbeats", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const source = new PolymarketMarketStreamSource();
    const handle = await source.subscribe(["token-1"]);
    const socket = FakeWebSocket.latest;

    await vi.advanceTimersByTimeAsync(35_001);

    expect(socket?.sent).toContain("PING");
    expect(socket?.readyState).toBe(FakeWebSocket.CLOSED);
    await handle.close();
  });
});
