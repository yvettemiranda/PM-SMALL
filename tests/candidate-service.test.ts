import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandidateScanner } from "../src/domain/market-scanner.js";
import {
  CandidateService,
  type CandidateSnapshot,
} from "../src/services/candidate-service.js";
import { makeCandidate } from "./helpers.js";

describe("CandidateService", () => {
  afterEach(() => vi.useRealTimers());

  it("waits the full interval after a scan completes before starting the next one", async () => {
    vi.useFakeTimers();
    let scanCount = 0;
    const service = new CandidateService(
      {
        scan: async () => {
          scanCount += 1;
          return [];
        },
      },
      15_000,
    );

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(scanCount).toBe(1);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(scanCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(scanCount).toBe(2);
    service.stop();
  });

  it("coalesces concurrent refresh requests into one full scan", async () => {
    let scanCount = 0;
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new CandidateService(
      {
        scan: async () => {
          scanCount += 1;
          await pending;
          return [];
        },
      },
      15_000,
    );

    const first = service.refresh();
    const second = service.refresh();
    expect(first).toBe(second);
    expect(scanCount).toBe(1);

    release();
    await Promise.all([first, second]);
    expect(scanCount).toBe(1);
  });

  it("aborts an active scan when stopped", async () => {
    let receivedSignal: AbortSignal | undefined;
    let releaseScan: () => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const scanner: CandidateScanner = {
      scan: async (_now?: Date, signal?: AbortSignal) => {
        receivedSignal = signal;
        markStarted();
        await released;
        return [];
      },
    };
    const service = new CandidateService(scanner, 15_000);

    service.start();
    await started;
    service.stop();
    releaseScan();
    await service.refresh();

    expect(receivedSignal?.aborted).toBe(true);
  });

  it("retains candidates through a temporary scan failure and then recovers", async () => {
    const firstCandidate = makeCandidate();
    const recoveredCandidate = makeCandidate({
      candidateId: "recovered-token:20000",
      tokenId: "recovered-token",
    });
    const responses = [
      [firstCandidate],
      new Error("temporary Gamma failure"),
      [recoveredCandidate],
    ];
    const scanner: CandidateScanner = {
      scan: async () => {
        const response = responses.shift();
        if (response instanceof Error) {
          throw response;
        }
        if (response === undefined) {
          throw new Error("No scan response configured");
        }
        return response;
      },
    };
    const service = new CandidateService(scanner, 15_000);
    const notifications: CandidateSnapshot[] = [];
    service.subscribe((snapshot) => notifications.push(snapshot));

    const initial = await service.refresh();
    expect(initial).toMatchObject({
      candidates: [firstCandidate],
      scanning: false,
      lastError: null,
    });

    const failed = await service.refresh();
    expect(failed).toMatchObject({
      candidates: [firstCandidate],
      scanning: false,
      lastError: "temporary Gamma failure",
    });

    const recovered = await service.refresh();
    expect(recovered).toMatchObject({
      candidates: [recoveredCandidate],
      scanning: false,
      lastError: null,
    });
    expect(notifications).toHaveLength(4);
    expect(notifications[2]).toMatchObject({
      candidates: [firstCandidate],
      scanning: false,
      lastError: "temporary Gamma failure",
    });
    expect(notifications[3]).toEqual(recovered);
  });

  it("retains the last quote while marking it unavailable across disconnect and recovery", async () => {
    const service = new CandidateService(
      { scan: async () => [makeCandidate()] },
      15_000,
    );
    await service.refresh();

    service.updateQuote("yes-token", null, null, false);
    expect(service.getSnapshot().candidates[0]).toMatchObject({
      bookReady: false,
      bestBidMicros: 20_000,
      bestAskMicros: 30_000,
      executableBuyPriceMicros: 30_000,
    });

    service.updateQuote("yes-token", 10_000, 20_000, true);
    expect(service.getSnapshot().candidates[0]).toMatchObject({
      bookReady: true,
      bestBidMicros: 10_000,
      bestAskMicros: 20_000,
    });
  });

  it("looks up repeated quote updates without rescanning every candidate", async () => {
    let tokenIdReads = 0;
    const candidates = Array.from({ length: 200 }, (_value, index) => {
      const tokenId = `token-${index}`;
      const candidate = makeCandidate({
        candidateId: `${tokenId}:30000`,
        tokenId,
      });
      Object.defineProperty(candidate, "tokenId", {
        configurable: true,
        enumerable: true,
        get: () => {
          tokenIdReads += 1;
          return tokenId;
        },
      });
      return candidate;
    });
    const service = new CandidateService(
      { scan: async () => candidates },
      15_000,
    );
    await service.refresh();
    tokenIdReads = 0;

    for (let update = 0; update < 10; update += 1) {
      service.updateQuote("token-199", 10_000, 20_000);
    }

    expect(tokenIdReads).toBeLessThanOrEqual(10);
  });
});
