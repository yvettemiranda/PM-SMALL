import { describe, expect, it } from "vitest";
import { calculateConservativePaperFill } from "../src/domain/paper-fill-model.js";

describe("conservative paper fill", () => {
  it("waits for visible queue volume before filling", () => {
    const result = calculateConservativePaperFill({
      queueAheadSizeMicros: 1_000_000_000,
      observedTradeSizeMicros: 0,
      originalSizeMicros: 50_000_000,
      filledSizeMicros: 0,
      incomingTradeSizeMicros: 1_020_000_000,
    });

    expect(result.incrementalFillSizeMicros).toBe(20_000_000);
    expect(result.nextFilledSizeMicros).toBe(20_000_000);
  });

  it("never fills beyond the virtual order size", () => {
    const result = calculateConservativePaperFill({
      queueAheadSizeMicros: 1_000_000_000,
      observedTradeSizeMicros: 1_020_000_000,
      originalSizeMicros: 50_000_000,
      filledSizeMicros: 20_000_000,
      incomingTradeSizeMicros: 100_000_000,
    });

    expect(result.nextFilledSizeMicros).toBe(50_000_000);
    expect(result.incrementalFillSizeMicros).toBe(30_000_000);
  });
});
