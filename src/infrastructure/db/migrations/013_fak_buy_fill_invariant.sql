-- FAK buys are cash-sized. A fully spent order's executed share quantity is
-- therefore its complete order size even when multiple ask levels were used.
UPDATE paper_orders
SET original_size_micros = filled_size_micros,
    updated_at = CURRENT_TIMESTAMP
WHERE side = 'BUY'
  AND execution_kind = 'FAK'
  AND status = 'FILLED'
  AND filled_size_micros > 0
  AND filled_size_micros < original_size_micros;

-- Never resume automatically after repairing an accounting invariant.
UPDATE strategy_state
SET status = 'PAUSED', updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

INSERT INTO audit_log(event_type, entity_type, entity_id, payload_json, created_at)
VALUES (
  'TEST_FAK_BUY_FILL_INVARIANT_MIGRATION_COMPLETED',
  'strategy',
  '1',
  '{"liveEnabled":false,"normalizedLegacyFilledFakBuys":true}',
  CURRENT_TIMESTAMP
);
