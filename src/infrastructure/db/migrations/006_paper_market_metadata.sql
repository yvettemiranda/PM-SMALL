CREATE TABLE IF NOT EXISTS paper_market_metadata (
  token_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_slug TEXT,
  event_title TEXT,
  market_id TEXT NOT NULL,
  market_question TEXT,
  direction TEXT CHECK (direction IS NULL OR direction IN ('YES', 'NO')),
  opened_at TEXT,
  ends_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO paper_market_metadata(
  token_id, event_id, event_slug, event_title, market_id,
  market_question, direction, opened_at, ends_at, updated_at
)
SELECT
  po.token_id, po.event_id, NULL, NULL, po.market_id,
  NULL, NULL, po.market_opened_at, po.market_ends_at, po.updated_at
FROM paper_orders po
WHERE po.rowid = (
  SELECT po2.rowid
  FROM paper_orders po2
  WHERE po2.token_id = po.token_id
  ORDER BY po2.updated_at DESC, po2.rowid DESC
  LIMIT 1
);
