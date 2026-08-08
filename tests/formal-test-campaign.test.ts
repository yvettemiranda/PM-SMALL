import { describe, expect, it } from "vitest";
import {
  createFormalTestCampaign,
  decideFormalTestSegment,
  observeFormalTestCampaign,
  renderFormalTestReport,
  type FormalTestConfiguration,
} from "../src/services/formal-test-campaign.js";

const baseConfiguration: FormalTestConfiguration = {
  marketTypes: ["BINARY", "TERNARY"],
  allCategories: true,
  selectedCategoryIds: [],
  candidateSortDirection: "ASC",
  minMarketDurationDays: 1,
  maxMarketDurationDays: 30,
  maxBuyPriceCents: 3,
  minBidAskRatioPercent: 50,
  maxMarketProgressPercent: 20,
  orderAmount: "1",
  initialCapitalMicros: 100_000_000,
};

describe("formal TEST campaign", () => {
  it("creates a pending segment at every four-hour checkpoint", () => {
    let campaign = createFormalTestCampaign({
      runId: "formal-001",
      startedAt: "2026-08-08T00:00:00.000Z",
      targetAcceptedSeconds: 72 * 60 * 60,
      checkpointSeconds: 4 * 60 * 60,
    });

    campaign = observeFormalTestCampaign(campaign, {
      sampledAt: "2026-08-08T00:00:00.000Z",
      configuration: baseConfiguration,
      warningCount: 0,
      criticalErrors: [],
      transportError: false,
    });
    campaign = observeFormalTestCampaign(campaign, {
      sampledAt: "2026-08-08T04:00:00.000Z",
      configuration: baseConfiguration,
      warningCount: 1,
      criticalErrors: [],
      transportError: false,
    });

    expect(campaign.segments).toEqual([
      expect.objectContaining({
        id: "segment-0001",
        startedAt: "2026-08-08T00:00:00.000Z",
        finishedAt: "2026-08-08T04:00:00.000Z",
        durationSeconds: 14_400,
        boundaryReason: "CHECKPOINT",
        eligibility: "ELIGIBLE",
        decision: "PENDING",
        sampleCount: 1,
        warningSampleCount: 0,
      }),
    ]);
    expect(campaign.currentSegment).toMatchObject({
      id: "segment-0002",
      startedAt: "2026-08-08T04:00:00.000Z",
      sampleCount: 1,
      warningSampleCount: 1,
    });
    expect(campaign.pendingSeconds).toBe(14_400);
    expect(campaign.acceptedSeconds).toBe(0);
  });

  it("splits a segment when trading configuration changes", () => {
    let campaign = createFormalTestCampaign({
      runId: "formal-002",
      startedAt: "2026-08-08T00:00:00.000Z",
      targetAcceptedSeconds: 72 * 60 * 60,
      checkpointSeconds: 4 * 60 * 60,
    });
    campaign = observeFormalTestCampaign(campaign, {
      sampledAt: "2026-08-08T00:00:00.000Z",
      configuration: baseConfiguration,
      warningCount: 0,
      criticalErrors: [],
      transportError: false,
    });
    campaign = observeFormalTestCampaign(campaign, {
      sampledAt: "2026-08-08T01:30:00.000Z",
      configuration: {
        ...baseConfiguration,
        marketTypes: ["BINARY", "TERNARY", "MULTI"],
      },
      warningCount: 0,
      criticalErrors: [],
      transportError: false,
    });

    expect(campaign.segments[0]).toMatchObject({
      id: "segment-0001",
      durationSeconds: 5_400,
      boundaryReason: "CONFIGURATION_CHANGED",
      decision: "PENDING",
    });
    expect(campaign.currentSegment).toMatchObject({
      id: "segment-0002",
      startedAt: "2026-08-08T01:30:00.000Z",
      configuration: {
        marketTypes: ["BINARY", "TERNARY", "MULTI"],
      },
    });
  });

  it("keeps checkpoint and configuration-change boundaries chronological", () => {
    let campaign = createFormalTestCampaign({
      runId: "formal-boundaries",
      startedAt: "2026-08-08T00:00:00.000Z",
      targetAcceptedSeconds: 72 * 60 * 60,
      checkpointSeconds: 4 * 60 * 60,
    });
    campaign = observeFormalTestCampaign(campaign, {
      sampledAt: "2026-08-08T00:00:00.000Z",
      configuration: baseConfiguration,
      configurationUpdatedAt: "2026-08-07T23:00:00.000Z",
      warningCount: 0,
      criticalErrors: [],
      transportError: false,
    });
    campaign = observeFormalTestCampaign(campaign, {
      sampledAt: "2026-08-08T04:10:00.000Z",
      configuration: baseConfiguration,
      configurationUpdatedAt: "2026-08-07T23:00:00.000Z",
      warningCount: 0,
      criticalErrors: [],
      transportError: false,
    });
    campaign = observeFormalTestCampaign(campaign, {
      sampledAt: "2026-08-08T04:30:00.000Z",
      configuration: { ...baseConfiguration, maxMarketDurationDays: 60 },
      configurationUpdatedAt: "2026-08-08T04:15:00.000Z",
      warningCount: 0,
      criticalErrors: [],
      transportError: false,
    });

    expect(campaign.segments).toEqual([
      expect.objectContaining({
        id: "segment-0001",
        startedAt: "2026-08-08T00:00:00.000Z",
        finishedAt: "2026-08-08T04:00:00.000Z",
        boundaryReason: "CHECKPOINT",
      }),
      expect.objectContaining({
        id: "segment-0002",
        startedAt: "2026-08-08T04:00:00.000Z",
        finishedAt: "2026-08-08T04:15:00.000Z",
        boundaryReason: "CONFIGURATION_CHANGED",
        configuration: baseConfiguration,
      }),
    ]);
    expect(campaign.currentSegment).toMatchObject({
      id: "segment-0003",
      startedAt: "2026-08-08T04:15:00.000Z",
      configuration: { maxMarketDurationDays: 60 },
    });
  });

  it("counts only eligible segments explicitly included by the user", () => {
    let campaign = campaignWithClosedSegment({ criticalErrors: [] });

    campaign = decideFormalTestSegment(campaign, {
      segmentId: "segment-0001",
      decision: "INCLUDED",
      decidedAt: "2026-08-08T04:05:00.000Z",
    });

    expect(campaign.acceptedSeconds).toBe(14_400);
    expect(campaign.pendingSeconds).toBe(0);
    expect(campaign.segments[0]?.decision).toBe("INCLUDED");
  });

  it("never lets a user decision include a segment with a hard failure", () => {
    const campaign = campaignWithClosedSegment({
      criticalErrors: ["Paper ledger validation failed"],
    });

    expect(campaign.segments[0]).toMatchObject({
      eligibility: "HARD_FAILED",
      decision: "REJECTED",
    });
    expect(() =>
      decideFormalTestSegment(campaign, {
        segmentId: "segment-0001",
        decision: "INCLUDED",
        decidedAt: "2026-08-08T04:05:00.000Z",
      }),
    ).toThrow("Hard-failed formal TEST segments cannot be included");
    expect(renderFormalTestReport(campaign)).toContain(
      "Paper ledger validation failed",
    );
  });

  it("rejects a segment when fewer than 99.5 percent of samples are valid", () => {
    let campaign = createFormalTestCampaign({
      runId: "formal-sampling",
      startedAt: "2026-08-08T00:00:00.000Z",
      targetAcceptedSeconds: 72 * 60 * 60,
      checkpointSeconds: 4 * 60 * 60,
    });
    for (let index = 0; index < 199; index += 1) {
      campaign = observeFormalTestCampaign(campaign, {
        sampledAt: new Date(Date.parse(campaign.startedAt) + index * 1_000).toISOString(),
        configuration: baseConfiguration,
        warningCount: 0,
        criticalErrors: [],
        transportError: index === 198,
      });
    }
    campaign = observeFormalTestCampaign(campaign, {
      sampledAt: "2026-08-08T04:00:00.000Z",
      configuration: baseConfiguration,
      warningCount: 0,
      criticalErrors: [],
      transportError: true,
    });

    expect(campaign.segments[0]).toMatchObject({
      eligibility: "HARD_FAILED",
      decision: "REJECTED",
      validSampleRatePercent: 99.5,
    });
  });

  it("rejects wall-clock time when the monitor did not record enough samples", () => {
    let campaign = createFormalTestCampaign({
      runId: "formal-coverage",
      startedAt: "2026-08-08T00:00:00.000Z",
      targetAcceptedSeconds: 72 * 60 * 60,
      checkpointSeconds: 4 * 60 * 60,
      sampleIntervalSeconds: 60,
    });
    campaign = observeFormalTestCampaign(campaign, {
      sampledAt: "2026-08-08T00:00:00.000Z",
      configuration: baseConfiguration,
      warningCount: 0,
      criticalErrors: [],
      transportError: false,
    });
    campaign = observeFormalTestCampaign(campaign, {
      sampledAt: "2026-08-08T04:00:00.000Z",
      configuration: baseConfiguration,
      warningCount: 0,
      criticalErrors: [],
      transportError: false,
    });

    expect(campaign.segments[0]).toMatchObject({
      eligibility: "HARD_FAILED",
      decision: "REJECTED",
      sampleCoveragePercent: 0.42,
    });
    expect(renderFormalTestReport(campaign)).toContain("采样覆盖率 0.42% 低于 99.5%");
  });

  it("summarizes runtime, scan, stream, and TEST activity for each node", () => {
    let campaign = createFormalTestCampaign({
      runId: "formal-metrics",
      startedAt: "2026-08-08T00:00:00.000Z",
      targetAcceptedSeconds: 72 * 60 * 60,
      checkpointSeconds: 4 * 60 * 60,
    });
    campaign = observeFormalTestCampaign(campaign, {
      sampledAt: "2026-08-08T00:00:00.000Z",
      configuration: baseConfiguration,
      warningCount: 0,
      criticalErrors: [],
      transportError: false,
      metrics: {
        requestDurationMs: 120,
        rssBytes: 300 * 1024 * 1024,
        heapUsedBytes: 100 * 1024 * 1024,
        candidateCount: 12,
        scanDurationMs: 2_000,
        scanRetryCount: 1,
        scanRateLimitCount: 2,
        scanTransientErrorCount: 3,
        subscribedTokenCount: 24,
        dataCompleteTokenCount: 20,
        unexpectedDisconnectCount: 4,
        recoveryCount: 3,
        paperBuyFillCount: 5,
        paperSellFillCount: 2,
        placedBuyCount: 6,
        settledMarketCount: 1,
        validationCount: 10,
      },
    });
    campaign = observeFormalTestCampaign(campaign, {
      sampledAt: "2026-08-08T04:00:00.000Z",
      configuration: baseConfiguration,
      warningCount: 0,
      criticalErrors: [],
      transportError: false,
      metrics: {
        requestDurationMs: 90,
        rssBytes: 320 * 1024 * 1024,
        heapUsedBytes: 110 * 1024 * 1024,
        candidateCount: 15,
        scanDurationMs: 1_500,
        scanRetryCount: 0,
        scanRateLimitCount: 1,
        scanTransientErrorCount: 0,
        subscribedTokenCount: 30,
        dataCompleteTokenCount: 30,
        unexpectedDisconnectCount: 5,
        recoveryCount: 4,
        paperBuyFillCount: 8,
        paperSellFillCount: 4,
        placedBuyCount: 9,
        settledMarketCount: 2,
        validationCount: 11,
      },
    });

    expect(campaign.segments[0]?.statistics).toMatchObject({
      maxRssBytes: 300 * 1024 * 1024,
      maxScanRateLimitCount: 2,
      minStreamCompletenessPercent: expect.closeTo(83.33, 2),
      firstCounters: {
        unexpectedDisconnectCount: 4,
        paperBuyFillCount: 5,
      },
      lastCounters: {
        unexpectedDisconnectCount: 4,
        paperBuyFillCount: 5,
      },
    });
    const report = renderFormalTestReport(campaign);
    expect(report).toContain("有效样本 100.00%");
    expect(report).toContain("RSS 300.0 MiB");
    expect(report).toContain("限流峰值 2");
    expect(report).toContain("买成交 5→5");
  });

  it("renders accepted, pending, and target time for status questions", () => {
    const campaign = campaignWithClosedSegment({ criticalErrors: [] });

    expect(renderFormalTestReport(campaign)).toContain(
      "已计入：0.00 / 72.00 小时",
    );
    expect(renderFormalTestReport(campaign)).toContain(
      "待你决定：4.00 小时（1 段）",
    );
    expect(renderFormalTestReport(campaign)).toContain(
      "segment-0001 | 待决定 | 4.00 小时",
    );
  });
});

function campaignWithClosedSegment(input: { criticalErrors: string[] }) {
  let campaign = createFormalTestCampaign({
    runId: "formal-003",
    startedAt: "2026-08-08T00:00:00.000Z",
    targetAcceptedSeconds: 72 * 60 * 60,
    checkpointSeconds: 4 * 60 * 60,
  });
  campaign = observeFormalTestCampaign(campaign, {
    sampledAt: "2026-08-08T00:00:00.000Z",
    configuration: baseConfiguration,
    warningCount: 0,
    criticalErrors: input.criticalErrors,
    transportError: false,
  });
  return observeFormalTestCampaign(campaign, {
    sampledAt: "2026-08-08T04:00:00.000Z",
    configuration: baseConfiguration,
    warningCount: 0,
    criticalErrors: input.criticalErrors,
    transportError: false,
  });
}
