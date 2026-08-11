import { createHash } from "node:crypto";

const MIN_VALID_SAMPLE_RATE_PERCENT = 99.5;
const MIN_SAMPLE_COVERAGE_PERCENT = 99.5;

export type FormalTestConfiguration = {
  marketTypes: Array<"BINARY" | "TERNARY" | "MULTI">;
  allCategories: boolean;
  selectedCategoryIds: string[];
  candidateSortDirection: "ASC" | "DESC";
  minMarketDurationDays: number;
  maxMarketDurationDays: number;
  minBuyPriceCents: number;
  maxBuyPriceCents: number;
  targetSellPriceIncreaseCents: number;
  targetSellPriceMultiplier: number;
  minBidAskRatioPercent: number;
  maxMarketProgressPercent: number;
  orderAmount: string;
  initialCapitalMicros: number;
};

export type FormalTestObservation = {
  sampledAt: string;
  configuration: FormalTestConfiguration;
  configurationUpdatedAt?: string;
  warningCount: number;
  criticalErrors: string[];
  transportError: boolean;
  metrics?: FormalTestSampleMetrics;
};

export type FormalTestSampleMetrics = {
  requestDurationMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  candidateCount: number;
  scanDurationMs: number;
  scanRetryCount: number;
  scanRateLimitCount: number;
  scanTransientErrorCount: number;
  subscribedTokenCount: number;
  dataCompleteTokenCount: number;
  unexpectedDisconnectCount: number;
  recoveryCount: number;
  paperBuyFillCount: number;
  paperSellFillCount: number;
  placedBuyCount: number;
  settledMarketCount: number;
  validationCount: number;
};

type FormalTestCounterSnapshot = Pick<
  FormalTestSampleMetrics,
  | "unexpectedDisconnectCount"
  | "recoveryCount"
  | "paperBuyFillCount"
  | "paperSellFillCount"
  | "placedBuyCount"
  | "settledMarketCount"
  | "validationCount"
>;

export type FormalTestSegmentStatistics = {
  maxRequestDurationMs: number;
  maxRssBytes: number;
  maxHeapUsedBytes: number;
  maxCandidateCount: number;
  maxScanDurationMs: number;
  maxScanRetryCount: number;
  maxScanRateLimitCount: number;
  maxScanTransientErrorCount: number;
  maxSubscribedTokenCount: number;
  minStreamCompletenessPercent: number | null;
  firstCounters: FormalTestCounterSnapshot | null;
  lastCounters: FormalTestCounterSnapshot | null;
};

export type FormalTestSegmentDecision =
  | "PENDING"
  | "INCLUDED"
  | "EXCLUDED"
  | "REJECTED";

export type FormalTestSegment = {
  id: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  boundaryReason:
    | "CHECKPOINT"
    | "CONFIGURATION_CHANGED"
    | "CAMPAIGN_FINISHED"
    | "HARD_FAILURE";
  configurationFingerprint: string;
  configuration: FormalTestConfiguration;
  eligibility: "ELIGIBLE" | "HARD_FAILED";
  decision: FormalTestSegmentDecision;
  decidedAt: string | null;
  sampleCount: number;
  warningSampleCount: number;
  transportErrorCount: number;
  validSampleRatePercent: number;
  sampleCoveragePercent: number;
  criticalErrors: string[];
  eligibilityFailures: string[];
  statistics: FormalTestSegmentStatistics;
};

type CurrentFormalTestSegment = Omit<
  FormalTestSegment,
  | "finishedAt"
  | "durationSeconds"
  | "boundaryReason"
  | "eligibility"
  | "decision"
  | "decidedAt"
  | "validSampleRatePercent"
  | "sampleCoveragePercent"
  | "eligibilityFailures"
>;

export type FormalTestCampaign = {
  version: 1;
  runId: string;
  status: "RUNNING" | "TARGET_REACHED" | "FAILED" | "STOPPED";
  startedAt: string;
  lastObservedAt: string;
  targetAcceptedSeconds: number;
  checkpointSeconds: number;
  sampleIntervalSeconds: number;
  nextCheckpointAt: string;
  acceptedSeconds: number;
  excludedSeconds: number;
  pendingSeconds: number;
  rejectedSeconds: number;
  segments: FormalTestSegment[];
  currentSegment: CurrentFormalTestSegment | null;
};

export function createFormalTestCampaign(input: {
  runId: string;
  startedAt: string;
  targetAcceptedSeconds: number;
  checkpointSeconds: number;
  sampleIntervalSeconds?: number;
}): FormalTestCampaign {
  const startedAtMs = timestamp(input.startedAt, "startedAt");
  if (input.runId.trim().length === 0) {
    throw new Error("Formal TEST runId must not be empty");
  }
  const sampleIntervalSeconds =
    input.sampleIntervalSeconds ?? input.checkpointSeconds;
  if (
    input.targetAcceptedSeconds <= 0 ||
    input.checkpointSeconds <= 0 ||
    sampleIntervalSeconds <= 0
  ) {
    throw new Error("Formal TEST durations must be positive");
  }
  return {
    version: 1,
    runId: input.runId,
    status: "RUNNING",
    startedAt: input.startedAt,
    lastObservedAt: input.startedAt,
    targetAcceptedSeconds: input.targetAcceptedSeconds,
    checkpointSeconds: input.checkpointSeconds,
    sampleIntervalSeconds,
    nextCheckpointAt: new Date(
      startedAtMs + input.checkpointSeconds * 1_000,
    ).toISOString(),
    acceptedSeconds: 0,
    excludedSeconds: 0,
    pendingSeconds: 0,
    rejectedSeconds: 0,
    segments: [],
    currentSegment: null,
  };
}

export function observeFormalTestCampaign(
  current: FormalTestCampaign,
  observation: FormalTestObservation,
): FormalTestCampaign {
  const campaign = structuredClone(current);
  const sampledAtMs = timestamp(observation.sampledAt, "sampledAt");
  if (sampledAtMs < timestamp(campaign.lastObservedAt, "lastObservedAt")) {
    throw new Error("Formal TEST observations must be chronological");
  }
  campaign.lastObservedAt = observation.sampledAt;
  const fingerprint = fingerprintConfiguration(observation.configuration);

  if (campaign.currentSegment === null) {
    campaign.currentSegment = openSegment(
      campaign,
      campaign.segments.length === 0 ? campaign.startedAt : observation.sampledAt,
      observation.configuration,
      fingerprint,
    );
  } else if (campaign.currentSegment.configurationFingerprint !== fingerprint) {
    const changeAt = configurationBoundaryAt(campaign, observation);
    advanceCheckpoints(campaign, changeAt, false);
    closeCurrentSegment(campaign, changeAt, "CONFIGURATION_CHANGED");
    campaign.currentSegment = openSegment(
      campaign,
      changeAt,
      observation.configuration,
      fingerprint,
    );
    if (
      timestamp(campaign.nextCheckpointAt, "checkpoint") ===
      timestamp(changeAt, "configuration change")
    ) {
      advanceCheckpointPointer(campaign);
    }
  }

  advanceCheckpoints(campaign, observation.sampledAt, true);

  const segment = campaign.currentSegment;
  if (segment === null) {
    throw new Error("Formal TEST segment was not opened");
  }
  if (observation.transportError) {
    segment.transportErrorCount += 1;
  } else {
    segment.sampleCount += 1;
    if (observation.warningCount > 0) {
      segment.warningSampleCount += 1;
    }
    if (observation.metrics !== undefined) {
      updateSegmentStatistics(segment.statistics, observation.metrics);
    }
  }
  segment.criticalErrors = unique([
    ...segment.criticalErrors,
    ...observation.criticalErrors,
  ]);

  return recalculate(campaign);
}

export function decideFormalTestSegment(
  current: FormalTestCampaign,
  input: {
    segmentId: string;
    decision: "INCLUDED" | "EXCLUDED";
    decidedAt: string;
  },
): FormalTestCampaign {
  timestamp(input.decidedAt, "decidedAt");
  const campaign = structuredClone(current);
  const segment = campaign.segments.find((item) => item.id === input.segmentId);
  if (segment === undefined) {
    throw new Error(`Unknown formal TEST segment: ${input.segmentId}`);
  }
  if (segment.eligibility === "HARD_FAILED" && input.decision === "INCLUDED") {
    throw new Error("Hard-failed formal TEST segments cannot be included");
  }
  segment.decision =
    segment.eligibility === "HARD_FAILED" ? "REJECTED" : input.decision;
  segment.decidedAt = input.decidedAt;
  return recalculate(campaign);
}

export function renderFormalTestReport(campaign: FormalTestCampaign): string {
  const pendingSegments = campaign.segments.filter(
    (segment) => segment.decision === "PENDING",
  );
  const currentSegment = campaign.currentSegment;
  const currentObservedSeconds =
    currentSegment === null
      ? 0
      : Math.max(
          0,
          (timestamp(campaign.lastObservedAt, "lastObservedAt") -
            timestamp(currentSegment.startedAt, "current segment startedAt")) /
            1_000,
        );
  const lines = [
    `# 正式 TEST 验证状态：${campaign.runId}`,
    "",
    `- 状态：${statusLabel(campaign.status)}`,
    `- 已计入：${hours(campaign.acceptedSeconds)} / ${hours(
      campaign.targetAcceptedSeconds,
    )} 小时`,
    `- 待你决定：${hours(campaign.pendingSeconds)} 小时（${pendingSegments.length} 段）`,
    `- 已排除：${hours(campaign.excludedSeconds)} 小时`,
    `- 硬失败拒绝：${hours(campaign.rejectedSeconds)} 小时`,
    `- 最近采样：${campaign.lastObservedAt}`,
    `- 当前片段：${
      currentSegment === null
        ? "无"
        : `${currentSegment.id}（已观察 ${hours(currentObservedSeconds)} 小时；下一定时节点 ${campaign.nextCheckpointAt}）`
    }`,
    "",
    "## 已完成分段",
    "",
  ];
  if (campaign.segments.length === 0) {
    lines.push("暂无已完成分段。");
  } else {
    for (const segment of campaign.segments) {
      lines.push(
        `- ${segment.id} | ${decisionLabel(segment.decision)} | ${hours(
          segment.durationSeconds,
        )} 小时 | ${boundaryLabel(segment.boundaryReason)} | 样本 ${
          segment.sampleCount
        } | 告警样本 ${segment.warningSampleCount}`,
      );
      lines.push(
        `  - 配置：${configurationSummary(segment.configuration)}`,
      );
      lines.push(
        `  - 有效样本 ${segment.validSampleRatePercent.toFixed(2)}% / 覆盖 ${segment.sampleCoveragePercent.toFixed(2)}% | 传输错误 ${segment.transportErrorCount} | RSS ${mib(
          segment.statistics.maxRssBytes,
        )} MiB | 候选峰值 ${segment.statistics.maxCandidateCount} | 扫描 ${milliseconds(
          segment.statistics.maxScanDurationMs,
        )} | 重试峰值 ${segment.statistics.maxScanRetryCount} | 限流峰值 ${segment.statistics.maxScanRateLimitCount} | 临时错误峰值 ${segment.statistics.maxScanTransientErrorCount} | 行情最低完整率 ${streamCompleteness(
          segment.statistics,
        )} | ${counterSummary(
          segment.statistics,
        )}`,
      );
      if (segment.eligibilityFailures.length > 0) {
        lines.push(`  - 硬失败：${segment.eligibilityFailures.join("；")}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function finishFormalTestCampaign(
  current: FormalTestCampaign,
  input: {
    finishedAt: string;
    reason: "CAMPAIGN_FINISHED" | "HARD_FAILURE";
  },
): FormalTestCampaign {
  const campaign = structuredClone(current);
  if (campaign.currentSegment !== null) {
    closeCurrentSegment(campaign, input.finishedAt, input.reason);
  }
  if (input.reason === "HARD_FAILURE") {
    campaign.status = "FAILED";
  } else if (campaign.acceptedSeconds >= campaign.targetAcceptedSeconds) {
    campaign.status = "TARGET_REACHED";
  } else {
    campaign.status = "STOPPED";
  }
  return recalculate(campaign);
}

function openSegment(
  campaign: FormalTestCampaign,
  startedAt: string,
  configuration: FormalTestConfiguration,
  configurationFingerprint: string,
): CurrentFormalTestSegment {
  return {
    id: `segment-${String(campaign.segments.length + 1).padStart(4, "0")}`,
    startedAt,
    configurationFingerprint,
    configuration: structuredClone(configuration),
    sampleCount: 0,
    warningSampleCount: 0,
    transportErrorCount: 0,
    criticalErrors: [],
    statistics: createSegmentStatistics(),
  };
}

function closeCurrentSegment(
  campaign: FormalTestCampaign,
  finishedAt: string,
  boundaryReason: FormalTestSegment["boundaryReason"],
): void {
  const current = campaign.currentSegment;
  if (current === null) return;
  const finishedAtMs = timestamp(finishedAt, "finishedAt");
  const startedAtMs = timestamp(current.startedAt, "segment startedAt");
  if (finishedAtMs < startedAtMs) {
    throw new Error("Formal TEST segment cannot finish before it starts");
  }
  const durationSeconds = (finishedAtMs - startedAtMs) / 1_000;
  const attemptedSampleCount = current.sampleCount + current.transportErrorCount;
  const rawValidSampleRatePercent =
    attemptedSampleCount === 0
      ? 0
      : (current.sampleCount / attemptedSampleCount) * 100;
  const validSampleRatePercent = Number(rawValidSampleRatePercent.toFixed(2));
  const expectedSampleCount = Math.max(
    1,
    Math.floor(durationSeconds / campaign.sampleIntervalSeconds),
  );
  const rawSampleCoveragePercent = Math.min(
    100,
    (attemptedSampleCount / expectedSampleCount) * 100,
  );
  const sampleCoveragePercent = Number(rawSampleCoveragePercent.toFixed(2));
  const eligibilityFailures = [
    ...current.criticalErrors,
    ...(rawValidSampleRatePercent < MIN_VALID_SAMPLE_RATE_PERCENT
      ? [
          `有效采样率 ${validSampleRatePercent.toFixed(2)}% 低于 ${MIN_VALID_SAMPLE_RATE_PERCENT}%`,
        ]
      : []),
    ...(rawSampleCoveragePercent < MIN_SAMPLE_COVERAGE_PERCENT
      ? [
          `采样覆盖率 ${sampleCoveragePercent.toFixed(2)}% 低于 ${MIN_SAMPLE_COVERAGE_PERCENT}%`,
        ]
      : []),
  ];
  const hardFailed = eligibilityFailures.length > 0;
  campaign.segments.push({
    ...current,
    finishedAt,
    durationSeconds,
    validSampleRatePercent,
    sampleCoveragePercent,
    eligibilityFailures,
    boundaryReason: hardFailed ? "HARD_FAILURE" : boundaryReason,
    eligibility: hardFailed ? "HARD_FAILED" : "ELIGIBLE",
    decision: hardFailed ? "REJECTED" : "PENDING",
    decidedAt: hardFailed ? finishedAt : null,
  });
  campaign.currentSegment = null;
}

function recalculate(campaign: FormalTestCampaign): FormalTestCampaign {
  campaign.acceptedSeconds = totalByDecision(campaign, "INCLUDED");
  campaign.excludedSeconds = totalByDecision(campaign, "EXCLUDED");
  campaign.pendingSeconds = totalByDecision(campaign, "PENDING");
  campaign.rejectedSeconds = totalByDecision(campaign, "REJECTED");
  if (
    campaign.status === "RUNNING" &&
    campaign.acceptedSeconds >= campaign.targetAcceptedSeconds
  ) {
    campaign.status = "TARGET_REACHED";
  }
  return campaign;
}

function totalByDecision(
  campaign: FormalTestCampaign,
  decision: FormalTestSegmentDecision,
): number {
  return campaign.segments
    .filter((segment) => segment.decision === decision)
    .reduce((total, segment) => total + segment.durationSeconds, 0);
}

function fingerprintConfiguration(
  configuration: FormalTestConfiguration,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalConfiguration(configuration)))
    .digest("hex");
}

function canonicalConfiguration(
  configuration: FormalTestConfiguration,
): FormalTestConfiguration {
  return {
    ...configuration,
    marketTypes: [...configuration.marketTypes].sort(),
    selectedCategoryIds: [...configuration.selectedCategoryIds].sort(),
  };
}

function configurationBoundaryAt(
  campaign: FormalTestCampaign,
  observation: FormalTestObservation,
): string {
  const current = campaign.currentSegment;
  if (current === null || observation.configurationUpdatedAt === undefined) {
    return observation.sampledAt;
  }
  const updatedAtMs = timestamp(
    observation.configurationUpdatedAt,
    "configurationUpdatedAt",
  );
  const segmentStartedAtMs = timestamp(current.startedAt, "segment startedAt");
  const sampledAtMs = timestamp(observation.sampledAt, "sampledAt");
  return updatedAtMs > segmentStartedAtMs && updatedAtMs <= sampledAtMs
    ? observation.configurationUpdatedAt
    : observation.sampledAt;
}

function advanceCheckpoints(
  campaign: FormalTestCampaign,
  untilAt: string,
  inclusive: boolean,
): void {
  const untilAtMs = timestamp(untilAt, "checkpoint boundary");
  while (true) {
    const checkpointAt = campaign.nextCheckpointAt;
    const checkpointAtMs = timestamp(checkpointAt, "checkpoint");
    if (
      checkpointAtMs > untilAtMs ||
      (!inclusive && checkpointAtMs === untilAtMs)
    ) {
      return;
    }
    const current = campaign.currentSegment;
    if (current === null) {
      throw new Error("Formal TEST checkpoint has no active segment");
    }
    const configuration = structuredClone(current.configuration);
    const fingerprint = current.configurationFingerprint;
    closeCurrentSegment(campaign, checkpointAt, "CHECKPOINT");
    campaign.currentSegment = openSegment(
      campaign,
      checkpointAt,
      configuration,
      fingerprint,
    );
    advanceCheckpointPointer(campaign);
  }
}

function advanceCheckpointPointer(campaign: FormalTestCampaign): void {
  campaign.nextCheckpointAt = new Date(
    timestamp(campaign.nextCheckpointAt, "checkpoint") +
      campaign.checkpointSeconds * 1_000,
  ).toISOString();
}

function createSegmentStatistics(): FormalTestSegmentStatistics {
  return {
    maxRequestDurationMs: 0,
    maxRssBytes: 0,
    maxHeapUsedBytes: 0,
    maxCandidateCount: 0,
    maxScanDurationMs: 0,
    maxScanRetryCount: 0,
    maxScanRateLimitCount: 0,
    maxScanTransientErrorCount: 0,
    maxSubscribedTokenCount: 0,
    minStreamCompletenessPercent: null,
    firstCounters: null,
    lastCounters: null,
  };
}

function updateSegmentStatistics(
  statistics: FormalTestSegmentStatistics,
  metrics: FormalTestSampleMetrics,
): void {
  statistics.maxRequestDurationMs = Math.max(
    statistics.maxRequestDurationMs,
    metrics.requestDurationMs,
  );
  statistics.maxRssBytes = Math.max(statistics.maxRssBytes, metrics.rssBytes);
  statistics.maxHeapUsedBytes = Math.max(
    statistics.maxHeapUsedBytes,
    metrics.heapUsedBytes,
  );
  statistics.maxCandidateCount = Math.max(
    statistics.maxCandidateCount,
    metrics.candidateCount,
  );
  statistics.maxScanDurationMs = Math.max(
    statistics.maxScanDurationMs,
    metrics.scanDurationMs,
  );
  statistics.maxScanRetryCount = Math.max(
    statistics.maxScanRetryCount,
    metrics.scanRetryCount,
  );
  statistics.maxScanRateLimitCount = Math.max(
    statistics.maxScanRateLimitCount,
    metrics.scanRateLimitCount,
  );
  statistics.maxScanTransientErrorCount = Math.max(
    statistics.maxScanTransientErrorCount,
    metrics.scanTransientErrorCount,
  );
  statistics.maxSubscribedTokenCount = Math.max(
    statistics.maxSubscribedTokenCount,
    metrics.subscribedTokenCount,
  );
  if (metrics.subscribedTokenCount > 0) {
    const completeness =
      (metrics.dataCompleteTokenCount / metrics.subscribedTokenCount) * 100;
    statistics.minStreamCompletenessPercent = Math.min(
      statistics.minStreamCompletenessPercent ?? 100,
      completeness,
    );
  }
  const counters = counterSnapshot(metrics);
  statistics.firstCounters ??= counters;
  statistics.lastCounters = counters;
}

function counterSnapshot(
  metrics: FormalTestSampleMetrics,
): FormalTestCounterSnapshot {
  return {
    unexpectedDisconnectCount: metrics.unexpectedDisconnectCount,
    recoveryCount: metrics.recoveryCount,
    paperBuyFillCount: metrics.paperBuyFillCount,
    paperSellFillCount: metrics.paperSellFillCount,
    placedBuyCount: metrics.placedBuyCount,
    settledMarketCount: metrics.settledMarketCount,
    validationCount: metrics.validationCount,
  };
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function hours(seconds: number): string {
  return (seconds / 3_600).toFixed(2);
}

function mib(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function milliseconds(value: number): string {
  return `${(value / 1_000).toFixed(2)}s`;
}

function counterSummary(statistics: FormalTestSegmentStatistics): string {
  const first = statistics.firstCounters;
  const last = statistics.lastCounters;
  if (first === null || last === null) {
    return "活动计数暂无样本";
  }
  return `买成交 ${first.paperBuyFillCount}→${last.paperBuyFillCount} | 卖成交 ${first.paperSellFillCount}→${last.paperSellFillCount} | WS 断线 ${first.unexpectedDisconnectCount}→${last.unexpectedDisconnectCount} / 恢复 ${first.recoveryCount}→${last.recoveryCount}`;
}

function configurationSummary(configuration: FormalTestConfiguration): string {
  const categories = configuration.allCategories
    ? "全部栏目"
    : `${configuration.selectedCategoryIds.length} 个栏目`;
  const minBuyPriceCents = configuration.minBuyPriceCents ?? 1;
  const targetSellPriceIncreaseCents =
    configuration.targetSellPriceIncreaseCents ?? 1;
  const targetSellPriceMultiplier =
    configuration.targetSellPriceMultiplier ?? 1.5;
  return `类型 ${configuration.marketTypes.join("/")}，${categories}，时长 ${configuration.minMarketDurationDays}–${configuration.maxMarketDurationDays} 天，买价 ${minBuyPriceCents}–${configuration.maxBuyPriceCents}¢，目标 max(买价+${targetSellPriceIncreaseCents}¢, 买价×${targetSellPriceMultiplier}) 且 ≤99¢，Bid/Ask ≥${configuration.minBidAskRatioPercent}%，进度 ≤${configuration.maxMarketProgressPercent}%，每 Event ${configuration.orderAmount}U，总资金 ${(configuration.initialCapitalMicros / 1_000_000).toFixed(2)}U，排序 ${configuration.candidateSortDirection}`;
}

function streamCompleteness(statistics: FormalTestSegmentStatistics): string {
  return statistics.minStreamCompletenessPercent === null
    ? "暂无"
    : `${statistics.minStreamCompletenessPercent.toFixed(2)}%`;
}

function statusLabel(status: FormalTestCampaign["status"]): string {
  return {
    RUNNING: "运行中",
    TARGET_REACHED: "累计时长已达标，等待最终审计",
    FAILED: "失败并已停止",
    STOPPED: "已停止",
  }[status];
}

function decisionLabel(decision: FormalTestSegmentDecision): string {
  return {
    PENDING: "待决定",
    INCLUDED: "已计入",
    EXCLUDED: "已排除",
    REJECTED: "硬失败拒绝",
  }[decision];
}

function boundaryLabel(reason: FormalTestSegment["boundaryReason"]): string {
  return {
    CHECKPOINT: "4 小时节点",
    CONFIGURATION_CHANGED: "配置变化",
    CAMPAIGN_FINISHED: "任务停止",
    HARD_FAILURE: "硬失败",
  }[reason];
}
