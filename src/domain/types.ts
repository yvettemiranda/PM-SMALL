export type TradeDirection = "YES" | "NO";
export type PaperOrderSide = "BUY" | "SELL";
export type PaperOrderStatus =
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED";

export type EligibleEvent = {
  eventId: string;
  title: string;
  category: string;
  resultCount: 2 | 3;
  isNegativeRisk: boolean;
  openedAt: string;
  endsAt: string;
  durationDays: number;
  progressPercent: number;
};

export type MarketToken = {
  eventId: string;
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
  bestBidMicros: number;
  bestAskMicros: number | null;
  makerBuyPriceMicros: number;
  fixedSellPriceMicros: number;
  orderSizeMicros: number;
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
