ALTER TABLE paper_trading_preferences
  ADD COLUMN all_categories_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (all_categories_enabled IN (0, 1));

ALTER TABLE paper_trading_preferences
  ADD COLUMN selected_categories_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE paper_trading_preferences
  ADD COLUMN candidate_sort_direction TEXT NOT NULL DEFAULT 'ASC'
    CHECK (candidate_sort_direction IN ('ASC', 'DESC'));

ALTER TABLE paper_trading_preferences
  ADD COLUMN order_budget_micros INTEGER NOT NULL DEFAULT 1000000
    CHECK (order_budget_micros > 0);

-- Market lifecycle progress now controls ASC/DESC ordering only. Remove the
-- previous hidden 20% eligibility cut-off from upgraded TEST databases.
UPDATE paper_trading_preferences SET max_market_progress_percent = 100;
