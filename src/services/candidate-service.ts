import type {
  CandidateScanner,
  MarketScanDiagnostics,
} from "../domain/market-scanner.js";
import type { TradeCandidate } from "../domain/types.js";
import { calculateFixedSellPriceMicros } from "../domain/price.js";

export type CandidateSnapshot = {
  candidates: TradeCandidate[];
  lastScanAt: string | null;
  lastError: string | null;
  scanning: boolean;
  diagnostics: MarketScanDiagnostics | null;
};

export class CandidateService {
  private candidates: TradeCandidate[] = [];
  private lastScanAt: string | null = null;
  private lastError: string | null = null;
  private diagnostics: MarketScanDiagnostics | null = null;
  private activeScan: Promise<CandidateSnapshot> | null = null;
  private activeScanController: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private readonly listeners = new Set<(snapshot: CandidateSnapshot) => void>();
  private readonly quoteListeners = new Set<(tokenId: string) => void>();

  public constructor(
    private readonly scanner: CandidateScanner,
    private readonly intervalMs: number,
  ) {}

  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.runScheduledRefresh();
  }

  public stop(): void {
    this.started = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.activeScanController?.abort(
      new Error("Candidate market scan stopped"),
    );
  }

  private async runScheduledRefresh(): Promise<void> {
    await this.refresh();
    if (!this.started) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runScheduledRefresh();
    }, this.intervalMs);
    this.timer.unref();
  }

  public getSnapshot(): CandidateSnapshot {
    const currentDiagnostics =
      this.scanner.getLastDiagnostics?.() ?? this.diagnostics;
    return {
      candidates: this.candidates,
      lastScanAt: this.lastScanAt,
      lastError: this.lastError,
      scanning: this.activeScan !== null,
      diagnostics:
        currentDiagnostics === null ? null : { ...currentDiagnostics },
    };
  }

  public getCandidate(candidateId: string): TradeCandidate | null {
    return (
      this.candidates.find((candidate) => candidate.candidateId === candidateId) ??
      null
    );
  }

  public updateQuote(
    tokenId: string,
    bestBidMicros: number | null,
    bestAskMicros: number | null,
    bookReady = true,
  ): void {
    const candidate = this.candidates.find((item) => item.tokenId === tokenId);
    if (candidate === undefined) {
      return;
    }
    candidate.bookReady = bookReady;
    candidate.bestBidMicros = bestBidMicros;
    candidate.bestAskMicros = bestAskMicros;
    if (bestAskMicros !== null) {
      candidate.executableBuyPriceMicros = bestAskMicros;
      candidate.makerBuyPriceMicros = bestAskMicros;
      candidate.fixedSellPriceMicros = calculateFixedSellPriceMicros(
        bestAskMicros,
        candidate.tickSizeMicros,
      );
    } else {
      candidate.executableBuyPriceMicros = 0;
      candidate.makerBuyPriceMicros = 0;
      candidate.fixedSellPriceMicros = 0;
    }
    for (const listener of this.quoteListeners) {
      listener(tokenId);
    }
  }

  public subscribe(listener: (snapshot: CandidateSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  public subscribeQuotes(listener: (tokenId: string) => void): () => void {
    this.quoteListeners.add(listener);
    return () => this.quoteListeners.delete(listener);
  }

  public refresh(): Promise<CandidateSnapshot> {
    if (this.activeScan !== null) {
      return this.activeScan;
    }

    const controller = new AbortController();
    this.activeScanController = controller;
    const scan = this.scanner
      .scan(undefined, controller.signal)
      .then((candidates) => {
        this.candidates = candidates;
        this.lastScanAt = new Date().toISOString();
        this.lastError = null;
        this.diagnostics = this.scanner.getLastDiagnostics?.() ?? null;
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          this.lastError = error instanceof Error ? error.message : String(error);
        }
      });
    this.activeScan = scan
      .finally(() => {
        if (this.activeScanController === controller) {
          this.activeScanController = null;
        }
        this.activeScan = null;
        this.notifyListeners();
      })
      .then(() => this.getSnapshot());

    return this.activeScan;
  }

  private notifyListeners(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
