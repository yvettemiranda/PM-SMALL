-- v0.4 maker exits are retained as v0.5 target exits by migration 009. Their
-- legacy metadata predates the CLOB minimum-order field, so use the smallest
-- positive compatibility value until a fresh TEST buy records live metadata.
-- This applies only to already-open migrated exits and prevents them from
-- becoming permanently unsellable because zero was interpreted as unknown.
UPDATE paper_market_metadata
SET min_order_size_micros = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE min_order_size_micros = 0
  AND token_id IN (
    SELECT token_id
    FROM paper_orders
    WHERE side = 'SELL'
      AND execution_kind = 'TARGET'
      AND status IN ('OPEN', 'PARTIALLY_FILLED')
  );

INSERT INTO audit_log(event_type, entity_type, entity_id, payload_json, created_at)
SELECT
  'TEST_LEGACY_EXIT_METADATA_BACKFILLED',
  'strategy',
  '1',
  '{"liveEnabled":false,"minimumOrderCompatibilityMicros":1}',
  CURRENT_TIMESTAMP
WHERE changes() > 0;
