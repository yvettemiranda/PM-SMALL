import { describe, expect, it } from "vitest";
import type { CandidateScanner } from "../src/domain/market-scanner.js";
import { CandidateService } from "../src/services/candidate-service.js";

describe("CandidateService", () => {
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
});
