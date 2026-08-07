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
import type { MarketCategory } from "../../domain/types.js";

const HOMEPAGE_TAGS_URL =
  "https://polymarket.com/api/tags/filtered?tag=102982&status=active";
const GAMMA_TAG_BY_SLUG_URL =
  "https://gamma-api.polymarket.com/tags/slug";
const HOMEPAGE_CATEGORY_CACHE_MS = 5 * 60_000;
const HOMEPAGE_CATEGORY_TIMEOUT_MS = 5_000;
const FALLBACK_HOMEPAGE_CATEGORIES: readonly (MarketCategory & {
  slug: string;
})[] = [
  { id: "2", label: "Politics", slug: "politics" },
  { id: "1", label: "Sports", slug: "sports" },
  { id: "21", label: "Crypto", slug: "crypto" },
  { id: "64", label: "Esports", slug: "esports" },
  { id: "78", label: "Iran", slug: "iran" },
  { id: "120", label: "Finance", slug: "finance" },
  { id: "100265", label: "Geopolitics", slug: "geopolitics" },
  { id: "1401", label: "Tech", slug: "tech" },
  { id: "596", label: "Culture", slug: "pop-culture" },
  { id: "100328", label: "Economy", slug: "economy" },
  { id: "84", label: "Weather", slug: "weather" },
  { id: "100343", label: "Mentions", slug: "mention-markets" },
  { id: "144", label: "Elections", slug: "elections" },
  { id: "1422", label: "Art", slug: "art" },
];

export interface MarketDataSource {
  /** Mirrors the category row shown in the current Polymarket homepage nav. */
  listHomepageCategories?(signal?: AbortSignal): Promise<MarketCategory[]>;
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
  private homepageCategoriesCache: MarketCategory[] | null = null;
  private homepageCategoriesCachedAtMs = 0;

  public constructor(
    client: PublicClient = createPublicClient(),
    private readonly retryDelaysMs: readonly number[] = [1_000, 2_000],
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {
    this.client = client;
  }

  public async listHomepageCategories(
    signal?: AbortSignal,
  ): Promise<MarketCategory[]> {
    if (
      this.homepageCategoriesCache !== null &&
      Date.now() - this.homepageCategoriesCachedAtMs <
        HOMEPAGE_CATEGORY_CACHE_MS
    ) {
      return cloneCategories(this.homepageCategoriesCache);
    }

    signal?.throwIfAborted();
    const requestController = new AbortController();
    const abortFromCaller = () => requestController.abort(signal?.reason);
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      requestController.abort(
        new Error("Polymarket homepage category sync timed out"),
      );
    }, HOMEPAGE_CATEGORY_TIMEOUT_MS);

    try {
      const coreTags = normalizeHomepageTags(
        await this.fetchJson(HOMEPAGE_TAGS_URL, requestController.signal),
      );
      if (coreTags.length === 0) {
        throw new Error("Polymarket homepage returned no core categories");
      }
      const [esports, art] = await Promise.all([
        this.fetchJson(
          `${GAMMA_TAG_BY_SLUG_URL}/esports?include_template=false`,
          requestController.signal,
        ).then(normalizeHomepageTag),
        this.fetchJson(
          `${GAMMA_TAG_BY_SLUG_URL}/art?include_template=false`,
          requestController.signal,
        ).then(normalizeHomepageTag),
      ]);
      const categories = buildHomepageCategoryNavigation(
        coreTags,
        esports,
        art,
      );
      if (categories.length === 0) {
        throw new Error("Polymarket homepage returned no categories");
      }
      this.homepageCategoriesCache = categories.map(({ id, label }) => ({
        id,
        label,
      }));
      this.homepageCategoriesCachedAtMs = Date.now();
      return cloneCategories(this.homepageCategoriesCache);
    } catch (error) {
      if (signal?.aborted) {
        throw abortReason(signal);
      }
      if (this.homepageCategoriesCache !== null) {
        return cloneCategories(this.homepageCategoriesCache);
      }
      return FALLBACK_HOMEPAGE_CATEGORIES.map(({ id, label }) => ({
        id,
        label,
      }));
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private async fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetcher(url, {
      headers: { accept: "application/json" },
      signal: signal ?? null,
    });
    if (!response.ok) {
      throw new Error(
        `Polymarket homepage category request failed (${response.status})`,
      );
    }
    return response.json();
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

type HomepageTag = MarketCategory & { slug: string };

function normalizeHomepageTags(value: unknown): HomepageTag[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const tag = normalizeHomepageTag(item);
    return tag === null ? [] : [tag];
  });
}

function normalizeHomepageTag(value: unknown): HomepageTag | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const item = value as Record<string, unknown>;
  const id = String(item.id ?? "").trim();
  const label = typeof item.label === "string" ? item.label.trim() : "";
  const slug = typeof item.slug === "string" ? item.slug.trim() : "";
  return id.length > 0 && label.length > 0 && slug.length > 0
    ? { id, label, slug }
    : null;
}

function buildHomepageCategoryNavigation(
  coreTags: readonly HomepageTag[],
  esportsTag: HomepageTag | null,
  artTag: HomepageTag | null,
): HomepageTag[] {
  const categories = coreTags
    .filter((tag) => tag.slug !== "all" && tag.slug !== "perps")
    .filter((tag) => tag.slug !== "art")
    .map((tag) => ({ ...tag }));
  if (!categories.some((tag) => tag.slug === "esports")) {
    const esports = esportsTag ?? fallbackHomepageTag("esports");
    const cryptoIndex = categories.findIndex((tag) => tag.slug === "crypto");
    const sportsIndex = categories.findIndex((tag) => tag.slug === "sports");
    const insertionIndex =
      cryptoIndex >= 0
        ? cryptoIndex + 1
        : sportsIndex >= 0
          ? sportsIndex + 1
          : categories.length;
    categories.splice(insertionIndex, 0, esports);
  }
  categories.push(artTag ?? fallbackHomepageTag("art"));
  return Array.from(
    new Map(categories.map((category) => [category.id, category])).values(),
  );
}

function fallbackHomepageTag(slug: "esports" | "art"): HomepageTag {
  const tag = FALLBACK_HOMEPAGE_CATEGORIES.find(
    (category) => category.slug === slug,
  );
  if (tag === undefined) {
    throw new Error(`Missing fallback homepage category: ${slug}`);
  }
  return { ...tag };
}

function cloneCategories(categories: readonly MarketCategory[]): MarketCategory[] {
  return categories.map((category) => ({ ...category }));
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
