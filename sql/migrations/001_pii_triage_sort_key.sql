-- One-off migration for databases created before 2026-10-24.
-- Old table: ORDER BY (status, created_at), which makes `status` impossible to UPDATE
-- ("Cannot UPDATE key column `status`"). New table: ORDER BY (created_at, trace_id, span_id).
-- Not run by `make schema`. Run once with:
--   docker compose exec -T clickhouse clickhouse-client --user default --password dev --multiquery < sql/migrations/001_pii_triage_sort_key.sql
RENAME TABLE otel.pii_triage TO otel.pii_triage_old;

CREATE TABLE otel.pii_triage
(
    created_at       DateTime DEFAULT now(),
    trace_id         String,
    span_id          String,
    app_id           LowCardinality(String),
    user_id          String,
    risk             Float32,
    types            Array(String),
    reason           String,
    preview_masked   String,
    status           LowCardinality(String) DEFAULT 'open'
)
ENGINE = MergeTree
ORDER BY (created_at, trace_id, span_id);

INSERT INTO otel.pii_triage
SELECT created_at, trace_id, span_id, app_id, user_id, risk, types, reason, preview_masked, status
FROM otel.pii_triage_old;

DROP TABLE otel.pii_triage_old;
