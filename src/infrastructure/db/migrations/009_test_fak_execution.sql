ALTER TABLE paper_orders
  ADD COLUMN execution_kind TEXT NOT NULL DEFAULT 'LEGACY_MAKER'
    CHECK (execution_kind IN ('LEGACY_MAKER', 'FAK', 'TARGET'));

ALTER TABLE paper_orders
  ADD COLUMN cash_limit_micros INTEGER NOT NULL DEFAULT 0
    CHECK (cash_limit_micros >= 0);

ALTER TABLE paper_orders
  ADD COLUMN fee_micros INTEGER NOT NULL DEFAULT 0
    CHECK (fee_micros >= 0);

ALTER TABLE paper_fills
  ADD COLUMN net_size_micros INTEGER NOT NULL DEFAULT 0
    CHECK (net_size_micros >= 0);

ALTER TABLE paper_fills
  ADD COLUMN fee_micros INTEGER NOT NULL DEFAULT 0
    CHECK (fee_micros >= 0);

UPDATE paper_fills SET net_size_micros = size_micros
WHERE net_size_micros = 0;

ALTER TABLE paper_positions
  ADD COLUMN cycle_spend_micros INTEGER NOT NULL DEFAULT 0
    CHECK (cycle_spend_micros >= 0);

ALTER TABLE paper_positions
  ADD COLUMN gross_buy_size_micros INTEGER NOT NULL DEFAULT 0
    CHECK (gross_buy_size_micros >= 0);

ALTER TABLE paper_positions
  ADD COLUMN gross_buy_notional_micros INTEGER NOT NULL DEFAULT 0
    CHECK (gross_buy_notional_micros >= 0);

UPDATE paper_positions
SET cycle_spend_micros = cost_micros,
    gross_buy_size_micros = quantity_micros,
    gross_buy_notional_micros = cost_micros;

ALTER TABLE paper_market_metadata ADD COLUMN category TEXT;
ALTER TABLE paper_market_metadata
  ADD COLUMN fees_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (fees_enabled IN (0, 1));
ALTER TABLE paper_market_metadata
  ADD COLUMN fee_rate_micros INTEGER NOT NULL DEFAULT 0
    CHECK (fee_rate_micros >= 0);
ALTER TABLE paper_market_metadata
  ADD COLUMN fee_exponent INTEGER NOT NULL DEFAULT 1
    CHECK (fee_exponent >= 0);
ALTER TABLE paper_market_metadata
  ADD COLUMN min_order_size_micros INTEGER NOT NULL DEFAULT 0
    CHECK (min_order_size_micros >= 0);
ALTER TABLE paper_market_metadata
  ADD COLUMN tick_size_micros INTEGER NOT NULL DEFAULT 0
    CHECK (tick_size_micros >= 0);

-- A maker order cannot be carried across the execution-model boundary. Return
-- every legacy buy reservation, retain the order as cancelled history, and
-- convert existing exits into target orders that never sell below their saved
-- price. Pause the strategy so deployment cannot begin FAK trading implicitly.
UPDATE strategy_state
SET status = 'PAUSED',
    available_cash_micros = available_cash_micros + reserved_cash_micros,
    reserved_cash_micros = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

UPDATE paper_orders
SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
WHERE side = 'BUY' AND status IN ('OPEN', 'PARTIALLY_FILLED');

UPDATE paper_orders
SET execution_kind = 'TARGET', updated_at = CURRENT_TIMESTAMP
WHERE side = 'SELL' AND status IN ('OPEN', 'PARTIALLY_FILLED');

INSERT INTO audit_log(event_type, entity_type, entity_id, payload_json, created_at)
VALUES (
  'TEST_FAK_MIGRATION_COMPLETED',
  'strategy',
  '1',
  '{"liveEnabled":false,"legacyBuysCancelled":true}',
  CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_paper_orders_execution_active
  ON paper_orders(execution_kind, token_id, status);
