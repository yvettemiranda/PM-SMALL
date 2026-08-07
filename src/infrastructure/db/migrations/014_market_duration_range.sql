CREATE TABLE paper_trading_preferences_v14 (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  binary_enabled INTEGER NOT NULL CHECK (binary_enabled IN (0, 1)),
  ternary_enabled INTEGER NOT NULL CHECK (ternary_enabled IN (0, 1)),
  max_buy_price_micros INTEGER NOT NULL
    CHECK (
      max_buy_price_micros BETWEEN 10000 AND 30000
      AND max_buy_price_micros % 10000 = 0
    ),
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
  CHECK (min_market_duration_days <= max_market_duration_days)
);

INSERT INTO paper_trading_preferences_v14(
  id, binary_enabled, ternary_enabled, max_buy_price_micros,
  min_market_duration_days, max_market_duration_days,
  max_market_progress_percent, candidates_selected_by_default,
  all_categories_enabled, selected_categories_json,
  candidate_sort_direction, order_budget_micros,
  min_bid_ask_ratio_percent, updated_at
)
SELECT
  id, binary_enabled, ternary_enabled, max_buy_price_micros,
  1, max_market_duration_days,
  max_market_progress_percent, candidates_selected_by_default,
  all_categories_enabled, selected_categories_json,
  candidate_sort_direction, order_budget_micros,
  min_bid_ask_ratio_percent, updated_at
FROM paper_trading_preferences;

DROP TABLE paper_trading_preferences;
ALTER TABLE paper_trading_preferences_v14 RENAME TO paper_trading_preferences;

-- A new lower-bound eligibility rule must never resume an upgraded strategy
-- without an explicit user action after deployment.
UPDATE strategy_state
SET status = 'PAUSED', updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

INSERT INTO audit_log(event_type, entity_type, entity_id, payload_json, created_at)
VALUES (
  'TEST_MARKET_DURATION_RANGE_MIGRATION_COMPLETED',
  'strategy',
  '1',
  '{"liveEnabled":false,"defaultMinDurationDays":1}',
  CURRENT_TIMESTAMP
);
