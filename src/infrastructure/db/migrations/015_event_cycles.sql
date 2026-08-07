CREATE TABLE paper_trading_preferences_v15 (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  binary_enabled INTEGER NOT NULL CHECK (binary_enabled IN (0, 1)),
  ternary_enabled INTEGER NOT NULL CHECK (ternary_enabled IN (0, 1)),
  multi_enabled INTEGER NOT NULL DEFAULT 0 CHECK (multi_enabled IN (0, 1)),
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

INSERT INTO paper_trading_preferences_v15(
  id, binary_enabled, ternary_enabled, multi_enabled,
  max_buy_price_micros, min_market_duration_days,
  max_market_duration_days, max_market_progress_percent,
  candidates_selected_by_default, all_categories_enabled,
  selected_categories_json, candidate_sort_direction,
  order_budget_micros, min_bid_ask_ratio_percent, updated_at
)
SELECT
  id, binary_enabled, ternary_enabled, 0,
  max_buy_price_micros, min_market_duration_days,
  max_market_duration_days, max_market_progress_percent,
  candidates_selected_by_default, all_categories_enabled,
  selected_categories_json, candidate_sort_direction,
  order_budget_micros, min_bid_ask_ratio_percent, updated_at
FROM paper_trading_preferences;

DROP TABLE paper_trading_preferences;
ALTER TABLE paper_trading_preferences_v15 RENAME TO paper_trading_preferences;

CREATE TABLE paper_market_metadata_v15 (
  token_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_slug TEXT,
  event_title TEXT,
  market_id TEXT NOT NULL,
  market_question TEXT,
  direction TEXT CHECK (direction IS NULL OR direction IN ('YES', 'NO')),
  opened_at TEXT,
  ends_at TEXT,
  result_count INTEGER
    CHECK (
      result_count IS NULL
      OR (
        typeof(result_count) = 'integer'
        AND result_count BETWEEN 2 AND 9007199254740991
      )
    ),
  duration_days REAL CHECK (duration_days IS NULL OR duration_days > 0),
  category TEXT,
  fees_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (fees_enabled IN (0, 1)),
  fee_rate_micros INTEGER NOT NULL DEFAULT 0
    CHECK (fee_rate_micros >= 0),
  fee_exponent INTEGER NOT NULL DEFAULT 1
    CHECK (fee_exponent >= 0),
  min_order_size_micros INTEGER NOT NULL DEFAULT 0
    CHECK (min_order_size_micros >= 0),
  tick_size_micros INTEGER NOT NULL DEFAULT 0
    CHECK (tick_size_micros >= 0),
  category_ids_json TEXT NOT NULL DEFAULT '[]',
  category_labels_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

INSERT INTO paper_market_metadata_v15(
  token_id, event_id, event_slug, event_title, market_id,
  market_question, direction, opened_at, ends_at, result_count,
  duration_days, category, fees_enabled, fee_rate_micros,
  fee_exponent, min_order_size_micros, tick_size_micros,
  category_ids_json, category_labels_json, updated_at
)
SELECT
  token_id, event_id, event_slug, event_title, market_id,
  market_question, direction, opened_at, ends_at, result_count,
  duration_days, category, fees_enabled, fee_rate_micros,
  fee_exponent, min_order_size_micros, tick_size_micros,
  category_ids_json, category_labels_json, updated_at
FROM paper_market_metadata;

DROP TABLE paper_market_metadata;
ALTER TABLE paper_market_metadata_v15 RENAME TO paper_market_metadata;

CREATE INDEX IF NOT EXISTS idx_paper_market_metadata_event
  ON paper_market_metadata(event_id, token_id);

CREATE INDEX IF NOT EXISTS idx_paper_orders_event_active
  ON paper_orders(event_id, side, status, token_id);

CREATE TABLE paper_event_locks (
  event_id TEXT PRIMARY KEY,
  active_token_id TEXT,
  market_id TEXT,
  condition_id TEXT,
  cycle_budget_micros INTEGER NOT NULL CHECK (cycle_budget_micros >= 0),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'LEGACY_CONFLICT')),
  locked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (
      state = 'ACTIVE'
      AND active_token_id IS NOT NULL
      AND length(trim(active_token_id)) > 0
      AND market_id IS NOT NULL
      AND length(trim(market_id)) > 0
      AND condition_id IS NOT NULL
      AND length(trim(condition_id)) > 0
      AND cycle_budget_micros > 0
    )
    OR
    (
      state = 'LEGACY_CONFLICT'
      AND active_token_id IS NULL
      AND market_id IS NULL
      AND condition_id IS NULL
      AND cycle_budget_micros = 0
    )
  )
);

CREATE INDEX idx_paper_event_locks_active_token
  ON paper_event_locks(active_token_id);

-- The Event-cycle boundary invalidates every still-open BUY intent. Release
-- all BUY reservations, keep reducing-risk targets and preserve fill history.
UPDATE strategy_state
SET status = 'PAUSED',
    available_cash_micros = available_cash_micros + reserved_cash_micros,
    reserved_cash_micros = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

UPDATE paper_orders
SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
WHERE side = 'BUY' AND status IN ('OPEN', 'PARTIALLY_FILLED');

WITH positive_event_positions AS (
  SELECT
    pm.event_id,
    COUNT(*) AS token_count,
    MIN(pp.token_id) AS single_token_id,
    MIN(pm.market_id) AS single_market_id,
    MIN(pp.condition_id) AS single_condition_id,
    MAX(MAX(pp.cycle_spend_micros, pp.cost_micros), 1) AS legacy_budget_micros
  FROM paper_positions pp
  JOIN paper_market_metadata pm ON pm.token_id = pp.token_id
  WHERE pp.quantity_micros > 0
  GROUP BY pm.event_id
)
INSERT INTO paper_event_locks(
  event_id, active_token_id, market_id, condition_id,
  cycle_budget_micros, state, locked_at, updated_at
)
SELECT
  event_id,
  CASE WHEN token_count = 1 THEN single_token_id ELSE NULL END,
  CASE WHEN token_count = 1 THEN single_market_id ELSE NULL END,
  CASE WHEN token_count = 1 THEN single_condition_id ELSE NULL END,
  CASE WHEN token_count = 1 THEN legacy_budget_micros ELSE 0 END,
  CASE WHEN token_count = 1 THEN 'ACTIVE' ELSE 'LEGACY_CONFLICT' END,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM positive_event_positions;

INSERT INTO audit_log(event_type, entity_type, entity_id, payload_json, created_at)
VALUES (
  'TEST_EVENT_CYCLE_MIGRATION_COMPLETED',
  'strategy',
  '1',
  '{"liveEnabled":false,"multiDefaultEnabled":false,"activeBuysCancelled":true}',
  CURRENT_TIMESTAMP
);
