ALTER TABLE paper_orders
  ADD COLUMN game_starts_at TEXT;

ALTER TABLE paper_orders
  ADD COLUMN market_opened_at TEXT;

ALTER TABLE paper_orders
  ADD COLUMN market_ends_at TEXT;
