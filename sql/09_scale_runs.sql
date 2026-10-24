-- One row per run of the scale test (app/measure/scale_test.py).
CREATE TABLE IF NOT EXISTS otel.scale_runs
(
    started_at          DateTime64(3),
    sample_pct          Int16,            -- the collector's SUCCESS_SAMPLE_PCT during the run (-1 = unknown)
    target_rate         Float32,          -- spans per second asked for
    steady_seconds      Float32,
    achieved_rate       Float32,          -- spans per second the collector accepted during the steady stage
    request_p50_ms      Float32,          -- how long the collector took to answer one batch
    request_p99_ms      Float32,
    accepted            UInt64,           -- spans the collector said yes to (HTTP 200)
    failed_requests     UInt32,
    refused_by_collector UInt64,          -- otelcol_receiver_refused_spans
    stored              UInt64,           -- rows in otel.otel_traces for this run
    in_spans_table      UInt64,           -- rows in otel.spans (the materialized view copy)
    drain_seconds       Float32,          -- after the last send, how long until everything was stored (-1 = not everything)
    backlog_median      Float32,          -- accepted minus stored, steady stage
    backlog_slope       Float32,          -- how fast that backlog grew, spans per second per second
    queue_max           Float32,          -- the collector's ClickHouse exporter queue, largest value seen
    collector_cpu_cores Float32,          -- average CPU cores used by the collector process
    clickhouse_cpu_max_pct Float32,       -- docker stats, 100 = one core
    passed              UInt8,
    note                String
)
ENGINE = MergeTree
ORDER BY started_at;
