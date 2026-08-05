import { describe, expect, it } from "vitest";
import type { CandidateScanner } from "../src/domain/market-scanner.js";
import {
  CandidateService,
  type CandidateSnapshot,
} from "../src/services/candidate-service.js";
import { makeCandidate } from "./helpers.js";

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
});
