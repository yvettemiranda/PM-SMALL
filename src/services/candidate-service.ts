import type { CandidateScanner } from "../domain/market-scanner.js";
import type { TradeCandidate } from "../domain/types.js";

export type CandidateSnapshot = {
  candidates: TradeCandidate[];
  lastScanAt: string | null;
  lastError: string | null;
  scanning: boolean;
};

export class CandidateService {
  private candidates: TradeCandidate[] = [];
  private lastScanAt: string | null = null;
  private lastError: string | null = null;
  private activeScan: Promise<CandidateSnapshot> | null = null;
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
  }

  public getSnapshot(): CandidateSnapshot {
    return {
      candidates: this.candidates,
      lastScanAt: this.lastScanAt,
      lastError: this.lastError,
      scanning: this.activeScan !== null,
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

    this.activeScan = this.scanner
      .scan()
      .then((candidates) => {
        this.candidates = candidates;
        this.lastScanAt = new Date().toISOString();
        this.lastError = null;
        return this.getSnapshot();
      })
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        return this.getSnapshot();
      })
      .finally(() => {
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
