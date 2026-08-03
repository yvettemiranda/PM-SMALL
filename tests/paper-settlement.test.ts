import { describe, expect, it } from "vitest";
import {
  classifyPaperMarketResolution,
  type PaperMarketResolution,
  PaperResolutionValidationError,
} from "../src/domain/paper-settlement.js";

function makeResolution(
  overrides: Partial<PaperMarketResolution> = {},
): PaperMarketResolution {
  return {
    marketId: "market-1",
    conditionId: "0xcondition",
    closed: true,
    resolutionStatus: "resolved",
    outcomes: [
      { tokenId: "yes-token", label: "Yes", priceMicros: 1_000_000 },
      { tokenId: "no-token", label: "No", priceMicros: 0 },
    ],
    ...overrides,
  };
}

describe("paper settlement resolution", () => {
  it("accepts only a closed market with an official binary result", () => {
    expect(
      classifyPaperMarketResolution(makeResolution(), "0xcondition"),
    ).toEqual({
      kind: "READY",
      resolutionStatus: "resolved",
      winningTokenId: "yes-token",
      winningOutcome: "Yes",
    });
  });

  it("waits while the market is closed but resolution is proposed", () => {
    expect(
      classifyPaperMarketResolution(
        makeResolution({ resolutionStatus: "proposed" }),
        "0xcondition",
      ),
    ).toMatchObject({ kind: "WAITING", reason: "RESOLUTION_NOT_FINAL" });
  });

  it("waits for a final price vector instead of guessing from a status", () => {
    expect(
      classifyPaperMarketResolution(
        makeResolution({
          outcomes: [
            { tokenId: "yes-token", label: "Yes", priceMicros: 250_000 },
            { tokenId: "no-token", label: "No", priceMicros: 750_000 },
          ],
        }),
        "0xcondition",
      ),
    ).toMatchObject({ kind: "WAITING", reason: "OUTCOME_PRICES_NOT_FINAL" });
  });

  it("waits when a market is not closed even if prices look final", () => {
    expect(
      classifyPaperMarketResolution(
        makeResolution({ closed: false }),
        "0xcondition",
      ),
    ).toMatchObject({ kind: "WAITING", reason: "MARKET_NOT_CLOSED" });
  });

  it("rejects a response for a different condition", () => {
    expect(() =>
      classifyPaperMarketResolution(
        makeResolution({ conditionId: "0xother" }),
        "0xcondition",
      ),
    ).toThrow(PaperResolutionValidationError);
  });

  it("accepts the official 50/50 final result with proportional payouts", () => {
    expect(
      classifyPaperMarketResolution(
        makeResolution({
          outcomes: [
            { tokenId: "yes-token", label: "Yes", priceMicros: 500_000 },
            { tokenId: "no-token", label: "No", priceMicros: 500_000 },
          ],
        }),
        "0xcondition",
      ),
    ).toEqual({
      kind: "READY",
      resolutionStatus: "resolved",
      winningTokenId: null,
      winningOutcome: "50/50",
      payouts: [
        { tokenId: "yes-token", priceMicros: 500_000 },
        { tokenId: "no-token", priceMicros: 500_000 },
      ],
    });

    expect(
      classifyPaperMarketResolution(
        makeResolution({
          outcomes: [
            { tokenId: "yes-token", label: "Yes", priceMicros: 250_000 },
            { tokenId: "no-token", label: "No", priceMicros: 750_000 },
          ],
        }),
        "0xcondition",
      ),
    ).toMatchObject({ kind: "WAITING", reason: "OUTCOME_PRICES_NOT_FINAL" });
  });
});
