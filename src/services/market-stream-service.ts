import type { PaperDatabase } from "../infrastructure/db/database.js";
import type {
  MarketStreamHandle,
  MarketStreamSource,
} from "../infrastructure/polymarket/market-stream.js";
import type { CandidateService } from "./candidate-service.js";
import type { PaperMarketProcessor } from "./paper-market-processor.js";

export type MarketStreamStatus = {
  running: boolean;
  connected: boolean;
  subscribedTokenCount: number;
  dataCompleteTokenCount: number;
  lastEventAt: string | null;
  processedTradeEvents: number;
  ignoredTradeEvents: number;
  paperBuyFillCount: number;
  paperSellFillCount: number;
  createdPaperSellCount: number;
  connectionCount: number;
  fullSnapshotCount: number;
  unexpectedDisconnectCount: number;
  recoveryCount: number;
  lastFullSnapshotDurationMs: number | null;
  lastRecoveryDurationMs: number | null;
  lastError: string | null;
};

export interface PaperMarketRuntime {
  getStatus(): MarketStreamStatus;
  refreshSubscriptions(): void;
  isTokenReady(tokenId: string): boolean;
  getBestBidMicros?(tokenId: string): number | null;
}

export class MarketStreamService implements PaperMarketRuntime {
  private started = false;
  private connected = false;
  private desiredTokenIds: string[] = [];
  private currentTokenIds: string[] = [];
  private handle: MarketStreamHandle | null = null;
  private candidateUnsubscribe: (() => void) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private restartRequested = false;
  private restartLoop: Promise<void> | null = null;
  private generation = 0;
  private lastError: string | null = null;
  private connectionCount = 0;
  private fullSnapshotCount = 0;
  private unexpectedDisconnectCount = 0;
  private recoveryCount = 0;
  private currentConnectionStartedAtMs: number | null = null;
  private currentConnectionDataComplete = false;
  private recoveryStartedAtMs: number | null = null;
  private lastFullSnapshotDurationMs: number | null = null;
  private lastRecoveryDurationMs: number | null = null;

  public constructor(
    private readonly source: MarketStreamSource,
    private readonly candidates: CandidateService,
    private readonly database: PaperDatabase,
    private readonly processor: PaperMarketProcessor,
    private readonly reconnectDelayMs: number,
    private readonly shutdownWaitMs: number = 1_000,
  ) {}

  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.candidateUnsubscribe = this.candidates.subscribe(() =>
      this.refreshSubscriptions(),
    );
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.candidateUnsubscribe?.();
    this.candidateUnsubscribe = null;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.generation += 1;
    const handle = this.handle;
    const tokenIds = this.currentTokenIds;
    this.handle = null;
    this.currentTokenIds = [];
    this.connected = false;
    this.currentConnectionStartedAtMs = null;
    this.currentConnectionDataComplete = false;
    this.recoveryStartedAtMs = null;
    this.processor.markDisconnected(tokenIds);
    await Promise.all([
      handle === null
        ? Promise.resolve()
        : this.closeHandle(handle, "active stream close"),
      this.restartLoop === null
        ? Promise.resolve()
        : this.waitBounded(this.restartLoop, "stream restart loop"),
    ]);
  }

  public refreshSubscriptions(): void {
    if (!this.started) {
      return;
    }

    this.desiredTokenIds = Array.from(
      new Set([
        ...this.candidates
          .getSnapshot()
          .candidates.map((candidate) => candidate.tokenId),
        ...this.database
          .listActivePaperOrders()
          .map((order) => order.tokenId),
      ]),
    ).sort();

    if (
      this.handle !== null &&
      sameTokenIds(this.desiredTokenIds, this.currentTokenIds)
    ) {
      return;
    }
    this.requestRestart();
  }

  public getStatus(): MarketStreamStatus {
    return {
      running: this.started,
      connected: this.connected,
      subscribedTokenCount: this.currentTokenIds.length,
      ...this.processor.getStatus(),
      connectionCount: this.connectionCount,
      fullSnapshotCount: this.fullSnapshotCount,
      unexpectedDisconnectCount: this.unexpectedDisconnectCount,
      recoveryCount: this.recoveryCount,
      lastFullSnapshotDurationMs: this.lastFullSnapshotDurationMs,
      lastRecoveryDurationMs: this.lastRecoveryDurationMs,
      lastError: this.lastError,
    };
  }

  public isTokenReady(tokenId: string): boolean {
    return this.connected && this.processor.isTokenReady(tokenId);
  }

  public getBestBidMicros(tokenId: string): number | null {
    return this.connected ? this.processor.getBestBidMicros(tokenId) : null;
  }

  private requestRestart(): void {
    this.restartRequested = true;
    if (this.restartLoop !== null) {
      return;
    }

    this.restartLoop = this.drainRestarts().finally(() => {
      this.restartLoop = null;
      if (this.restartRequested && this.started) {
        this.requestRestart();
      }
    });
  }

  private async drainRestarts(): Promise<void> {
    while (this.restartRequested && this.started) {
      this.restartRequested = false;
      await this.restartOnce();
    }
  }

  private async restartOnce(): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    const previousHandle = this.handle;
    const previousTokenIds = this.currentTokenIds;
    this.handle = null;
    this.currentTokenIds = [];
    this.connected = false;
    this.currentConnectionStartedAtMs = null;
    this.currentConnectionDataComplete = false;
    this.processor.markDisconnected(previousTokenIds);

    if (previousHandle !== null) {
      await this.closeHandle(previousHandle, "previous stream close");
    }

    const tokenIds = [...this.desiredTokenIds];
    if (!this.started || tokenIds.length === 0) {
      return;
    }

    try {
      const handle = await this.source.subscribe(tokenIds);
      if (!this.started || generation !== this.generation) {
        await this.closeHandle(handle, "stale stream close");
        return;
      }
      this.handle = handle;
      this.currentTokenIds = tokenIds;
      this.connected = true;
      this.connectionCount += 1;
      this.currentConnectionStartedAtMs = Date.now();
      this.currentConnectionDataComplete = false;
      this.lastError = null;
      void this.consume(handle, tokenIds, generation);
    } catch (error) {
      this.currentConnectionStartedAtMs = null;
      this.currentConnectionDataComplete = false;
      this.lastError = errorMessage(error);
      this.scheduleReconnect();
    }
  }

  private async consume(
    handle: MarketStreamHandle,
    tokenIds: string[],
    generation: number,
  ): Promise<void> {
    try {
      for await (const event of handle) {
        if (!this.started || generation !== this.generation) {
          return;
        }
        this.processor.handle(event);
        this.recordFullSnapshotIfReady(tokenIds);
      }
    } catch (error) {
      if (generation === this.generation) {
        this.lastError = errorMessage(error);
      }
    } finally {
      if (this.started && generation === this.generation) {
        const disconnectedAtMs = Date.now();
        this.unexpectedDisconnectCount += 1;
        this.recoveryStartedAtMs ??= disconnectedAtMs;
        this.handle = null;
        this.currentTokenIds = [];
        this.connected = false;
        this.currentConnectionStartedAtMs = null;
        this.currentConnectionDataComplete = false;
        this.processor.markDisconnected(tokenIds);
        this.scheduleReconnect();
      }
    }
  }

  private recordFullSnapshotIfReady(tokenIds: readonly string[]): void {
    if (
      this.currentConnectionDataComplete ||
      tokenIds.length === 0 ||
      !tokenIds.every((tokenId) => this.processor.isTokenReady(tokenId))
    ) {
      return;
    }

    const completedAtMs = Date.now();
    this.currentConnectionDataComplete = true;
    this.fullSnapshotCount += 1;
    this.lastFullSnapshotDurationMs = Math.max(
      0,
      completedAtMs - (this.currentConnectionStartedAtMs ?? completedAtMs),
    );
    if (this.recoveryStartedAtMs !== null) {
      this.recoveryCount += 1;
      this.lastRecoveryDurationMs = Math.max(
        0,
        completedAtMs - this.recoveryStartedAtMs,
      );
      this.recoveryStartedAtMs = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer !== null) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.requestRestart();
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref();
  }

  private closeHandle(
    handle: MarketStreamHandle,
    operation: string,
  ): Promise<void> {
    return this.waitBounded(
      Promise.resolve().then(() => handle.close()),
      operation,
    );
  }

  private async waitBounded(
    task: Promise<unknown>,
    operation: string,
  ): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        task,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `${operation} timed out after ${this.shutdownWaitMs}ms`,
                ),
              ),
            this.shutdownWaitMs,
          );
        }),
      ]);
    } catch (error) {
      this.lastError = errorMessage(error);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }
}

function sameTokenIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
