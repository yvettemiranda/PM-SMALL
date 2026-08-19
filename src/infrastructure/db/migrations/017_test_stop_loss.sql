CREATE TABLE paper_trading_preferences_v17 (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  binary_enabled INTEGER NOT NULL CHECK (binary_enabled IN (0, 1)),
  ternary_enabled INTEGER NOT NULL CHECK (ternary_enabled IN (0, 1)),
  multi_enabled INTEGER NOT NULL DEFAULT 0 CHECK (multi_enabled IN (0, 1)),
  min_buy_price_micros INTEGER NOT NULL DEFAULT 1000
    CHECK (
      min_buy_price_micros BETWEEN 1000 AND 990000
      AND min_buy_price_micros % 1000 = 0
    ),
  max_buy_price_micros INTEGER NOT NULL DEFAULT 990000
    CHECK (
      max_buy_price_micros BETWEEN 1000 AND 990000
      AND max_buy_price_micros % 1000 = 0
    ),
  target_sell_price_increase_micros INTEGER NOT NULL DEFAULT 10000
    CHECK (target_sell_price_increase_micros BETWEEN 0 AND 990000),
  target_sell_price_multiplier_micros INTEGER NOT NULL DEFAULT 1500000
    CHECK (target_sell_price_multiplier_micros >= 0),
  stop_loss_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (stop_loss_enabled IN (0, 1)),
  stop_loss_multiplier_micros INTEGER NOT NULL DEFAULT 400000
    CHECK (stop_loss_multiplier_micros > 0 AND stop_loss_multiplier_micros < 1000000),
  min_market_duration_days INTEGER NOT NULL DEFAULT 1
    CHECK (min_market_duration_days BETWEEN 1 AND 365),
  max_market_duration_days INTEGER NOT NULL
    CHECK (max_market_duration_days BETWEEN 1 AND 365),
  max_market_progress_percent INTEGER NOT NULL
    CHECK (max_market_progress_percent BETWEEN 1 AND 100),
  candidates_selected_by_default INTEGER NOT NULL
    CHECK (candidates_selected_by_default IN (0, 1)),
  all_categories_enabled INTEGER NOT NULL
    CHECK (all_categories_enabled IN (0, 1)),
  selected_categories_json TEXT NOT NULL DEFAULT '[]',
  candidate_sort_direction TEXT NOT NULL DEFAULT 'ASC'
    CHECK (candidate_sort_direction IN ('ASC', 'DESC')),
  order_budget_micros INTEGER NOT NULL DEFAULT 1000000
    CHECK (order_budget_micros > 0),
  min_bid_ask_ratio_percent INTEGER NOT NULL DEFAULT 50
    CHECK (min_bid_ask_ratio_percent BETWEEN 1 AND 100),
  updated_at TEXT NOT NULL,
  CHECK (min_buy_price_micros <= max_buy_price_micros),
  CHECK (min_market_duration_days <= max_market_duration_days)
);

INSERT INTO paper_trading_preferences_v17(
  id, binary_enabled, ternary_enabled, multi_enabled,
  min_buy_price_micros, max_buy_price_micros,
  target_sell_price_increase_micros,
  target_sell_price_multiplier_micros,
  stop_loss_enabled, stop_loss_multiplier_micros,
  min_market_duration_days, max_market_duration_days,
  max_market_progress_percent, candidates_selected_by_default,
  all_categories_enabled, selected_categories_json,
  candidate_sort_direction, order_budget_micros,
  min_bid_ask_ratio_percent, updated_at
)
SELECT
  id, binary_enabled, ternary_enabled, multi_enabled,
  min_buy_price_micros, max_buy_price_micros,
  target_sell_price_increase_micros,
  target_sell_price_multiplier_micros,
  0, 400000,
  min_market_duration_days, max_market_duration_days,
  max_market_progress_percent, candidates_selected_by_default,
  all_categories_enabled, selected_categories_json,
  candidate_sort_direction, order_budget_micros,
  min_bid_ask_ratio_percent, CURRENT_TIMESTAMP
FROM paper_trading_preferences;

DROP TABLE paper_trading_preferences;
ALTER TABLE paper_trading_preferences_v17 RENAME TO paper_trading_preferences;

CREATE TABLE paper_stop_losses (
  token_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  multiplier_micros INTEGER NOT NULL
    CHECK (multiplier_micros > 0 AND multiplier_micros < 1000000),
  entry_price_micros INTEGER NOT NULL CHECK (entry_price_micros > 0),
  threshold_price_micros INTEGER NOT NULL CHECK (threshold_price_micros > 0),
  state TEXT NOT NULL
    CHECK (state IN ('WATCHING', 'ARMED', 'EXITING', 'STOPPED')),
  below_since TEXT,
  last_below_at TEXT,
  last_below_book_version TEXT,
  below_observation_count INTEGER NOT NULL DEFAULT 0
    CHECK (below_observation_count >= 0),
  triggered_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (state = 'WATCHING' AND below_since IS NULL AND last_below_at IS NULL
      AND last_below_book_version IS NULL AND below_observation_count = 0
      AND triggered_at IS NULL AND completed_at IS NULL)
    OR
    (state = 'ARMED' AND below_since IS NOT NULL AND last_below_at IS NOT NULL
      AND last_below_book_version IS NOT NULL AND below_observation_count >= 1
      AND triggered_at IS NULL AND completed_at IS NULL)
    OR
    (state = 'EXITING' AND triggered_at IS NOT NULL AND completed_at IS NULL)
    OR
    (state = 'STOPPED' AND triggered_at IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX idx_paper_stop_losses_event_state
  ON paper_stop_losses(event_id, state);

-- Existing positions belong to the previous TEST phase and intentionally do
-- not receive stop state. Fail closed before the user backs up and resets.
UPDATE strategy_state
SET status = 'PAUSED',
    available_cash_micros = available_cash_micros + reserved_cash_micros,
    reserved_cash_micros = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

UPDATE paper_orders
SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
WHERE side = 'BUY' AND status IN ('OPEN', 'PARTIALLY_FILLED');

INSERT INTO audit_log(event_type, entity_type, entity_id, payload_json, created_at)
VALUES (
  'TEST_STOP_LOSS_MIGRATION_COMPLETED',
  'strategy',
  '1',
  '{"liveEnabled":false,"existingPositionsExcluded":true,"activeBuysCancelled":true}',
  CURRENT_TIMESTAMP
);
