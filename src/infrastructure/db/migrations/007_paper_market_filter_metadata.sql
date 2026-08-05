ALTER TABLE paper_market_metadata
  ADD COLUMN result_count INTEGER CHECK (result_count IS NULL OR result_count IN (2, 3));

ALTER TABLE paper_market_metadata
  ADD COLUMN duration_days REAL CHECK (duration_days IS NULL OR duration_days > 0);

UPDATE paper_market_metadata
SET duration_days = julianday(ends_at) - julianday(opened_at)
WHERE duration_days IS NULL
  AND opened_at IS NOT NULL
  AND ends_at IS NOT NULL
  AND julianday(ends_at) > julianday(opened_at);
