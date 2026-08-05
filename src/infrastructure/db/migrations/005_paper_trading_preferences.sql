CREATE TABLE IF NOT EXISTS paper_trading_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  binary_enabled INTEGER NOT NULL CHECK (binary_enabled IN (0, 1)),
  ternary_enabled INTEGER NOT NULL CHECK (ternary_enabled IN (0, 1)),
  max_buy_price_micros INTEGER NOT NULL CHECK (max_buy_price_micros > 0),
  max_market_duration_days INTEGER NOT NULL CHECK (max_market_duration_days > 0),
  candidates_selected_by_default INTEGER NOT NULL
    CHECK (candidates_selected_by_default IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_candidate_selection_overrides (
  token_id TEXT PRIMARY KEY,
  selected INTEGER NOT NULL CHECK (selected IN (0, 1)),
  updated_at TEXT NOT NULL
);
