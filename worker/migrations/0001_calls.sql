-- The add-in Workers' call log: one row per proxied Apollo call (worker/src/index.js) and per
-- image upload or failed image fetch (worker-images/src/index.js). Never an Apollo key, a body
-- or a query string. Both Workers prune rows after 90 days.
CREATE TABLE calls (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  worker TEXT NOT NULL,
  method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status INTEGER,
  ms INTEGER,
  detail TEXT
);
CREATE INDEX calls_ts ON calls (ts);
