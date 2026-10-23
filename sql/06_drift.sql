-- One row per drift check (per app, per run).
CREATE TABLE IF NOT EXISTS otel.drift
(
    created_at       DateTime DEFAULT now(),
    app_id           LowCardinality(String),   -- an app name, or 'ALL' for every app together
    baseline_from    DateTime,
    baseline_to      DateTime,
    current_from     DateTime,
    current_to       DateTime,
    baseline_count   UInt32,                   -- number of prompts in each window
    current_count    UInt32,
    psi              Float32,                  -- -1 when there was not enough data
    threshold        Float32,
    alert            UInt8,                    -- 1 when psi > threshold
    note             String
)
ENGINE = MergeTree
ORDER BY (app_id, created_at);
