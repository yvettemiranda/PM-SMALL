ALTER TABLE paper_trading_preferences
  ADD COLUMN max_market_progress_percent INTEGER NOT NULL DEFAULT 100
    CHECK (max_market_progress_percent BETWEEN 1 AND 100);
