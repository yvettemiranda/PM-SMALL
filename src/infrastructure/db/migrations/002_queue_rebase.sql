ALTER TABLE paper_orders
  ADD COLUMN queue_baseline_filled_size_micros INTEGER NOT NULL DEFAULT 0;
