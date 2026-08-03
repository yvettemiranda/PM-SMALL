CREATE TABLE IF NOT EXISTS paper_settlements (
  condition_id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SETTLED')),
  resolution_status TEXT,
  winning_token_id TEXT,
  winning_outcome TEXT,
  outcome TEXT CHECK (outcome IN ('WIN', 'LOSS', 'MIXED', 'NO_POSITION')),
  redemption_status TEXT NOT NULL CHECK (
    redemption_status IN ('PENDING', 'SIMULATED', 'NOT_APPLICABLE')
  ),
  position_cost_micros INTEGER NOT NULL DEFAULT 0,
  payout_micros INTEGER NOT NULL DEFAULT 0,
  realized_pnl_micros INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  settled_at TEXT,
  redeemed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_settlements_status
  ON paper_settlements(status, updated_at);
