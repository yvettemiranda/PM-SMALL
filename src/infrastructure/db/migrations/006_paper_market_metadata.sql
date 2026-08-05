CREATE TABLE IF NOT EXISTS paper_market_metadata (
  token_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_slug TEXT,
  event_title TEXT NOT NULL,
  market_id TEXT NOT NULL,
  market_question TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('YES', 'NO')),
  opened_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
