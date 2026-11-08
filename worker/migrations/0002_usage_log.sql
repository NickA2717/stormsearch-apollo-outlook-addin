-- The usage log (2026-11-08): additive, nullable columns on the existing call log, so the version
-- running before the deploy keeps inserting its seven-column rows until the new code replaces it.
-- Rows written before this migration have no call_id. Metadata only: every value comes from a fixed
-- list or a strict pattern (worker/src/usage-log.js sanitizeRow). From this version on, `endpoint`
-- is a path shape (record ids as {id}, unknown segments as ?), `ms` is the whole call, and
-- `detail` is no longer written. What each column means: docs/RUNBOOK_USAGE_LOG.md.
ALTER TABLE calls ADD COLUMN call_id TEXT;
ALTER TABLE calls ADD COLUMN outcome TEXT;
ALTER TABLE calls ADD COLUMN version TEXT;
ALTER TABLE calls ADD COLUMN caller TEXT;
ALTER TABLE calls ADD COLUMN has_key INTEGER;
ALTER TABLE calls ADD COLUMN upstream_ms INTEGER;
ALTER TABLE calls ADD COLUMN upstream_status INTEGER;
ALTER TABLE calls ADD COLUMN failure_category TEXT;
ALTER TABLE calls ADD COLUMN reply_reason TEXT;
ALTER TABLE calls ADD COLUMN key_check TEXT;
ALTER TABLE calls ADD COLUMN content_type TEXT;
ALTER TABLE calls ADD COLUMN upload_bytes INTEGER;
ALTER TABLE calls ADD COLUMN deduped INTEGER;
-- The start and finish writes upsert on call_id; old rows (NULL) never conflict.
CREATE UNIQUE INDEX calls_call_id ON calls (call_id);
CREATE INDEX calls_worker_endpoint_ts ON calls (worker, endpoint, ts);
