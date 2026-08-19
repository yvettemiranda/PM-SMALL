import type {
  BookLevel,
  PaperOrderSide,
  TokenOrderBook,
  TradeCandidate,
} from "./types.js";
import type { MarketEligibilitySettings } from "./market-eligibility.js";
import type { TargetSellPriceSettings } from "./price.js";
import type { StopLossSettings } from "./stop-loss.js";

export type ExecutionMode = "TEST" | "LIVE";
export type ImmediateBuyOutcome = "FILLED" | "PARTIAL" | "NO_FILL" | "BLOCKED";

export type ConsumedBookLevel = {
  priceMicros: number;
  sizeMicros: number;
};

export type ExecutionOrderReference = {
  id: string;
  tokenId: string;
  side: PaperOrderSide;
};

export type ImmediateBuyIntent = {
  candidate: TradeCandidate;
  book: TokenOrderBook;
  maxPriceMicros: number;
  orderBudgetMicros: number;
  feeRateMicros: number;
  feeExponent: number;
  targetSellPriceSettings?: TargetSellPriceSettings;
  stopLossSettings?: StopLossSettings;
  eligibility: MarketEligibilitySettings;
};

export type ImmediateBuyExecution = {
  outcome: ImmediateBuyOutcome;
  order: ExecutionOrderReference | null;
  createdSellOrders: ExecutionOrderReference[];
  spentMicros: number;
  feeMicros: number;
  consumedAsks: ConsumedBookLevel[];
};

export type TargetSellIntent = {
  tokenId: string;
  bookVersion: string;
  bids: readonly BookLevel[];
  minOrderSizeMicros: number;
  feeRateMicros: number;
  feeExponent: number;
};

export type TargetSellExecution = {
  filledSizeMicros: number;
  grossProceedsMicros: number;
  netProceedsMicros: number;
  feeMicros: number;
  filledOrderCount: number;
  consumedBids: ConsumedBookLevel[];
};

export type StopLossState = "WATCHING" | "ARMED" | "EXITING" | "STOPPED";

export type StopLossIntent = TargetSellIntent & {
  observedAt: Date;
};

export type StopLossExecution = TargetSellExecution & {
  state: StopLossState | null;
  triggered: boolean;
  cancelledTargetCount: number;
};

export interface TradingExecutionAdapter {
  readonly mode: ExecutionMode;
  readonly enabled: boolean;
  executeBuy(intent: ImmediateBuyIntent): ImmediateBuyExecution;
  executeStopLoss(intent: StopLossIntent): StopLossExecution;
  executeTargetSells(intent: TargetSellIntent): TargetSellExecution;
}
