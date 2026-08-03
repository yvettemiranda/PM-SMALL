PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS strategy_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode = 'PAPER'),
  status TEXT NOT NULL CHECK (status IN ('STOPPED', 'RUNNING', 'PAUSED')),
  initial_capital_micros INTEGER NOT NULL,
  available_cash_micros INTEGER NOT NULL,
  reserved_cash_micros INTEGER NOT NULL DEFAULT 0,
  realized_pnl_micros INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_orders (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  price_micros INTEGER NOT NULL,
  target_sell_price_micros INTEGER,
  linked_buy_order_id TEXT REFERENCES paper_orders(id),
  original_size_micros INTEGER NOT NULL,
  filled_size_micros INTEGER NOT NULL DEFAULT 0,
  queue_ahead_size_micros INTEGER NOT NULL DEFAULT 0,
  observed_trade_size_micros INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_orders_token_status
  ON paper_orders(token_id, status);

CREATE TABLE IF NOT EXISTS paper_fills (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES paper_orders(id),
  source_trade_id TEXT NOT NULL,
  price_micros INTEGER NOT NULL,
  size_micros INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(order_id, source_trade_id)
);

CREATE TABLE IF NOT EXISTS paper_positions (
  token_id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL,
  quantity_micros INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  realized_pnl_micros INTEGER NOT NULL DEFAULT 0,
  first_sell_at TEXT,
  cycle_closed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_market_trades (
  order_id TEXT NOT NULL REFERENCES paper_orders(id),
  trade_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY(order_id, trade_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
