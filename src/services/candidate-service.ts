import type {
  CandidateScanner,
  MarketScanDiagnostics,
} from "../domain/market-scanner.js";
import type { TradeCandidate } from "../domain/types.js";

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
  private readonly listeners = new Set<(snapshot: CandidateSnapshot) => void>();

  public constructor(
    private readonly scanner: CandidateScanner,
    private readonly intervalMs: number,
  ) {}

  public start(): void {
    if (this.timer !== null) {
      return;
    }

    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.activeScanController?.abort(
      new Error("Candidate market scan stopped"),
    );
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

  public subscribe(listener: (snapshot: CandidateSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  public refresh(): Promise<CandidateSnapshot> {
    if (this.activeScan !== null) {
      return this.activeScan;
    }

    const controller = new AbortController();
    this.activeScanController = controller;
    this.activeScan = this.scanner
      .scan(undefined, controller.signal)
      .then((candidates) => {
        this.candidates = candidates;
        this.lastScanAt = new Date().toISOString();
        this.lastError = null;
        this.diagnostics = this.scanner.getLastDiagnostics?.() ?? null;
        return this.getSnapshot();
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          this.lastError = error instanceof Error ? error.message : String(error);
        }
        return this.getSnapshot();
      })
      .finally(() => {
        if (this.activeScanController === controller) {
          this.activeScanController = null;
        }
        this.activeScan = null;
        this.notifyListeners();
      });

    return this.activeScan;
  }

  private notifyListeners(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
