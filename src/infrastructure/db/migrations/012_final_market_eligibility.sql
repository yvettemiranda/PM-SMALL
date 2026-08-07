ALTER TABLE paper_trading_preferences
  ADD COLUMN min_bid_ask_ratio_percent INTEGER NOT NULL DEFAULT 50
    CHECK (min_bid_ask_ratio_percent BETWEEN 1 AND 100);

-- The final product rule makes lifecycle progress an eligibility limit again.
-- v0.5.0 forced every stored value to 100, so upgrade that compatibility value
-- to the newly confirmed default without touching any other valid custom value.
UPDATE paper_trading_preferences
SET max_market_progress_percent = 20
WHERE max_market_progress_percent = 100;

ALTER TABLE paper_market_metadata
  ADD COLUMN category_ids_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE paper_market_metadata
  ADD COLUMN category_labels_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE test_order_book_consumption (
  token_id TEXT NOT NULL,
  book_version TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('ASK', 'BID')),
  price_micros INTEGER NOT NULL CHECK (price_micros > 0),
  size_micros INTEGER NOT NULL CHECK (size_micros > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (token_id, book_version, side, price_micros)
);

-- A hard eligibility change must never resume an upgraded RUNNING strategy
-- without an explicit user action after deployment.
UPDATE strategy_state
SET status = 'PAUSED', updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

INSERT INTO audit_log(event_type, entity_type, entity_id, payload_json, created_at)
VALUES (
  'TEST_FINAL_ELIGIBILITY_MIGRATION_COMPLETED',
  'strategy',
  '1',
  '{"liveEnabled":false,"defaultMaxProgressPercent":20,"defaultBidAskRatioPercent":50}',
  CURRENT_TIMESTAMP
);
