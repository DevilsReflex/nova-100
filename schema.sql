-- Nova 100 — persistent all-time leaderboard (Cloudflare D1).
-- Apply to the live DB:   npx wrangler d1 execute nova-100-db --remote --file=schema.sql
-- Apply to a local dev DB: npx wrangler d1 execute nova-100-db --local  --file=schema.sql

CREATE TABLE IF NOT EXISTS scores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  score      INTEGER NOT NULL,
  kills      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL          -- epoch ms when the run ended
);

-- Ordered exactly how the board is read (highest score first, oldest tie-break).
CREATE INDEX IF NOT EXISTS idx_scores_score ON scores (score DESC, created_at ASC);

-- House pilots so the board isn't empty on launch. Fixed ids + INSERT OR IGNORE
-- make this idempotent; real players' runs start at id 6 and overtake them.
INSERT OR IGNORE INTO scores (id, name, score, kills, created_at) VALUES
  (1, 'NOVA-PRIME', 900, 9, 0),
  (2, 'VEGA',       720, 7, 0),
  (3, 'RIGEL',      540, 5, 0),
  (4, 'ALTAIR',     360, 3, 0),
  (5, 'LYRA',       180, 1, 0);
