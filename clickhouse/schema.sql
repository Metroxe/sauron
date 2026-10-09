-- Sauron on ClickHouse. The real-time backbone: every tool snapshot, finding,
-- verdict and gate event is a row. Drift detection and the cross-server hunt
-- are plain SQL over these tables.

CREATE DATABASE IF NOT EXISTS sauron;

-- One row per tool, per detonation snapshot (before / after the N calls).
CREATE TABLE IF NOT EXISTS sauron.tool_snapshots
(
  server_id      String,
  server_name    String,
  ts             DateTime64(3),
  phase          LowCardinality(String),   -- 'before' | 'after'
  call_count     UInt32,
  tool_name      String,
  tool_desc      String,
  tool_desc_hash String
)
ENGINE = MergeTree
ORDER BY (server_id, tool_name, ts);

-- Every catalogued server + its auth posture (for the "% with no auth" stat
-- at registry scale — tests Guild's 91.5% figure live).
CREATE TABLE IF NOT EXISTS sauron.server_registry
(
  server_id    String,
  name         String,
  url          String,
  source       LowCardinality(String),
  auth_posture LowCardinality(String),     -- none | apikey | oauth | unknown
  ts           DateTime64(3)
)
ENGINE = ReplacingMergeTree(ts)
ORDER BY server_id;

-- Findings raised by the detonation + Semgrep.
CREATE TABLE IF NOT EXISTS sauron.findings
(
  server_id String,
  ts        DateTime64(3),
  kind      LowCardinality(String),        -- drift | semgrep | no_auth | instruction_text
  severity  LowCardinality(String),
  detail    String,
  evidence  String
)
ENGINE = MergeTree
ORDER BY (server_id, ts);

-- Final verdicts (mirrored into Senso for verified context).
CREATE TABLE IF NOT EXISTS sauron.verdicts
(
  server_id String,
  ts        DateTime64(3),
  verdict   LowCardinality(String),
  score     Float64,
  summary   String,
  sources   String
)
ENGINE = MergeTree
ORDER BY (server_id, ts);

-- The live event feed / audit log.
CREATE TABLE IF NOT EXISTS sauron.events
(
  ts        DateTime64(3),
  server_id String,
  type      LowCardinality(String),
  detail    String
)
ENGINE = MergeTree
ORDER BY ts;

-- ── Demo queries ───────────────────────────────────────────────────────────

-- DRIFT: every (server, tool) whose description hash changed after the calls,
-- or a tool that only appeared in the 'after' snapshot. This is the catch.
-- SELECT
--   b.server_id, b.tool_name,
--   b.tool_desc_hash AS before_hash, a.tool_desc_hash AS after_hash
-- FROM
--   (SELECT server_id, tool_name, argMax(tool_desc_hash, ts) h FROM sauron.tool_snapshots WHERE phase='after'  GROUP BY server_id, tool_name) a
-- LEFT JOIN
--   (SELECT server_id, tool_name, argMax(tool_desc_hash, ts) h FROM sauron.tool_snapshots WHERE phase='before' GROUP BY server_id, tool_name) b
--   USING (server_id, tool_name)
-- WHERE a.h != b.h OR b.h = '';

-- SCALE + NO-AUTH: the Guild 91.5% figure, live.
-- SELECT count() AS servers,
--        round(100 * countIf(auth_posture='none') / count(), 1) AS pct_no_auth
-- FROM sauron.server_registry FINAL;
