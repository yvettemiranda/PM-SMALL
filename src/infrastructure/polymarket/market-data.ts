import {
  createPublicClient,
  RateLimitError,
  RequestRejectedError,
  type Event,
  type OrderBook,
  type PublicClient,
  TransportError,
  UnexpectedResponseError,
} from "@polymarket/client";
import { setTimeout as delay } from "node:timers/promises";
import { decimalStringToMicros } from "../../domain/price.js";
import type { PaperMarketResolution } from "../../domain/paper-settlement.js";

export interface MarketDataSource {
  /** Returns every open-event page; exact market filtering happens downstream. */
  listOpenEvents(
    request: OpenEventScanRequest,
    reportProgress?: (progress: OpenEventScanProgress) => void,
    signal?: AbortSignal,
  ): Promise<Event[]>;
  fetchOrderBooks(
    tokenIds: string[],
    reportProgress?: (progress: OrderBookFetchProgress) => void,
    signal?: AbortSignal,
  ): Promise<OrderBook[]>;
}

export type OpenEventScanRequest = {
  pageSize: number;
};

export type OpenEventScanProgress = {
  pageCount: number;
  eventCount: number;
} & RequestProgress;

export type OrderBookFetchProgress = {
  batchCount: number;
  orderBookCount: number;
} & RequestProgress;

type RequestProgress = {
  requestCount: number;
  retryCount: number;
  rateLimitCount: number;
  transientErrorCount: number;
};

export interface MarketResolutionSource {
  fetchMarketResolution(marketId: string): Promise<PaperMarketResolution>;
}

export class PolymarketMarketDataSource
  implements MarketDataSource, MarketResolutionSource
{
  private readonly client: PublicClient;

  public constructor(
    client: PublicClient = createPublicClient(),
    private readonly retryDelaysMs: readonly number[] = [1_000, 2_000],
  ) {
    this.client = client;
  }

  public async listOpenEvents(
    request: OpenEventScanRequest,
    reportProgress?: (progress: OpenEventScanProgress) => void,
    signal?: AbortSignal,
  ): Promise<Event[]> {
    // Do not impose a local page, token, or event-date cap. Child-market dates
    // can differ from their event, so exact schedule checks remain downstream.
    const events: Event[] = [];
    const paginator = this.client.listEvents({
      closed: false,
      ...request,
    });
    let pageCount = 0;
    const requests = createRequestProgress();
    const report = () =>
      reportProgress?.({
        pageCount,
        eventCount: events.length,
        ...requests,
      });
    let page = await this.requestWithRetries(
      () => paginator.firstPage(),
      requests,
      report,
      signal,
    );

    while (true) {
      events.push(...page.items);
      pageCount += 1;
      report();
      if (!page.hasMore) {
        break;
      }
      if (page.nextCursor === undefined) {
        throw new Error(
          "Polymarket event pagination reported another page without a cursor",
        );
      }
      const nextCursor = page.nextCursor;
      page = await this.requestWithRetries(
        () => paginator.from(nextCursor).firstPage(),
        requests,
        report,
        signal,
      );
    }

    return events;
  }

  public async fetchOrderBooks(
    tokenIds: string[],
    reportProgress?: (progress: OrderBookFetchProgress) => void,
    signal?: AbortSignal,
  ): Promise<OrderBook[]> {
    const books: OrderBook[] = [];
    let batchCount = 0;
    const requests = createRequestProgress();
    const report = () =>
      reportProgress?.({
        batchCount,
        orderBookCount: books.length,
        ...requests,
      });

    for (let offset = 0; offset < tokenIds.length; offset += 50) {
      signal?.throwIfAborted();
      const batch = tokenIds.slice(offset, offset + 50);
      const result = await this.requestWithRetries(
        () =>
          this.client.fetchOrderBooks(
            batch.map((tokenId) => ({ tokenId })),
          ),
        requests,
        report,
        signal,
      );
      books.push(...result);
      batchCount += 1;
      report();
    }

    return books;
  }

  private async requestWithRetries<T>(
    request: () => Promise<T>,
    progress: RequestProgress,
    reportProgress: () => void,
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) {
        throw abortReason(signal);
      }
      if (attempt > 0) {
        progress.retryCount += 1;
      }
      progress.requestCount += 1;
      try {
        return await withAbort(request(), signal);
      } catch (error) {
        if (signal?.aborted) {
          throw abortReason(signal);
        }
        const retryable = classifyRetryableError(error);
        if (retryable === null) {
          reportProgress();
          throw error;
        }
        progress.transientErrorCount += 1;
        if (retryable === "RATE_LIMIT") {
          progress.rateLimitCount += 1;
        }
        reportProgress();
        const retryDelayMs = this.retryDelaysMs[attempt];
        if (retryDelayMs === undefined) {
          throw error;
        }
        await waitForRetry(retryDelayMs, signal);
      }
    }
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

function createRequestProgress(): RequestProgress {
  return {
    requestCount: 0,
    retryCount: 0,
    rateLimitCount: 0,
    transientErrorCount: 0,
  };
}

function classifyRetryableError(
  error: unknown,
): "RATE_LIMIT" | "TRANSIENT" | null {
  if (error instanceof RateLimitError) {
    return "RATE_LIMIT";
  }
  if (
    error instanceof TransportError ||
    error instanceof UnexpectedResponseError
  ) {
    return "TRANSIENT";
  }
  if (
    error instanceof RequestRejectedError &&
    (error.status === 408 ||
      error.status === 425 ||
      (error.status >= 500 && error.status <= 599))
  ) {
    return "TRANSIENT";
  }
  return null;
}

async function waitForRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) {
    await delay(delayMs);
    return;
  }
  try {
    await delay(delayMs, undefined, { signal });
  } catch (error) {
    if (signal.aborted) {
      throw abortReason(signal);
    }
    throw error;
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

function withAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}
