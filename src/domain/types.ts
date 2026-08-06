export type TradeDirection = "YES" | "NO";
export type PaperOrderSide = "BUY" | "SELL";
export type OrderExecutionKind = "LEGACY_MAKER" | "FAK" | "TARGET";
export type PaperOrderStatus =
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED";

export type EligibleEvent = {
  eventId: string;
  eventSlug: string | null;
  title: string;
  category: string;
  resultCount: 2 | 3;
  isNegativeRisk: boolean;
};

export type MarketToken = {
  eventId: string;
  eventSlug: string | null;
  eventTitle: string;
  category: string;
  resultCount: 2 | 3;
  isNegativeRisk: boolean;
  marketId: string;
  conditionId: string;
  marketQuestion: string;
  direction: TradeDirection;
  tokenId: string;
  openedAt: string;
  endsAt: string;
  durationDays: number;
  progressPercent: number;
  gameStartsAt: string | null;
  feesEnabled: boolean;
  feeRateMicros: number;
  feeExponent: number;
};

export type BookLevel = {
  priceMicros: number;
  sizeMicros: number;
};

export type TokenOrderBook = {
  tokenId: string;
  conditionId: string;
  bids: BookLevel[];
  asks: BookLevel[];
  minOrderSizeMicros: number;
  tickSizeMicros: number;
  isNegativeRisk: boolean;
};

export type TradeCandidate = MarketToken & {
  candidateId: string;
  bestBidMicros: number | null;
  bestAskMicros: number | null;
  executableBuyPriceMicros: number;
  /** @deprecated Kept only for database upgrade compatibility. */
  makerBuyPriceMicros: number;
  fixedSellPriceMicros: number;
  orderSizeMicros: number;
  /** @deprecated FAK orders never wait behind a maker queue. */
  queueAheadSizeMicros: number;
  minOrderSizeMicros: number;
  tickSizeMicros: number;
};

export type PaperOrder = {
  id: string;
  tokenId: string;
  conditionId: string;
  eventId: string;
  marketId: string;
  gameStartsAt: string | null;
  marketOpenedAt: string | null;
  marketEndsAt: string | null;
  side: PaperOrderSide;
  priceMicros: number;
  targetSellPriceMicros: number | null;
  linkedBuyOrderId: string | null;
  originalSizeMicros: number;
  filledSizeMicros: number;
  queueAheadSizeMicros: number;
  queueBaselineFilledSizeMicros: number;
  observedTradeSizeMicros: number;
  status: PaperOrderStatus;
  executionKind: OrderExecutionKind;
  cashLimitMicros: number;
  feeMicros: number;
  createdAt: string;
  updatedAt: string;
};

export type MarketBookSnapshot = {
  type: "book";
  tokenId: string;
  bids: BookLevel[];
  asks: BookLevel[];
  timestampMs: number | null;
};

export type MarketPriceChange = {
  type: "price_change";
  tokenId: string;
  side: PaperOrderSide;
  priceMicros: number;
  sizeMicros: number;
  timestampMs: number | null;
};

export type MarketTrade = {
  type: "trade";
  sourceTradeId: string;
  tokenId: string;
  takerSide: PaperOrderSide;
  priceMicros: number;
  sizeMicros: number;
  timestampMs: number | null;
};

export type MarketStreamEvent =
  | MarketBookSnapshot
  | MarketPriceChange
  | MarketTrade;
