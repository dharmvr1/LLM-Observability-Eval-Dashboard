-- Every response that was checked for PII (flagged or not). Used for rates and alerts later.
CREATE TABLE IF NOT EXISTS otel.pii_checks
(
    created_at       DateTime DEFAULT now(),
    trace_id         String,
    scored_span_id   String,
    app_id           LowCardinality(String),
    user_id          String,
    regex_types      Array(String),            -- what the regex found, e.g. ['ssn']
    llm_score        Float32,                  -- guard LLM score 0..1, or -1 when it was skipped
    risk             Float32,                  -- final score 0..1 (1.0 if the regex matched)
    reason           String,
    judge_model      String
)
ENGINE = MergeTree
ORDER BY (app_id, created_at);

-- The triage queue: only responses with risk >= threshold. A human works through these.
-- The preview has every digit masked, so the queue itself does not store the leaked number.
CREATE TABLE IF NOT EXISTS otel.pii_triage
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
    status           LowCardinality(String) DEFAULT 'open'    -- open (high) | review (low, regex-only) | confirmed | false_positive
)
ENGINE = MergeTree
ORDER BY (status, created_at);
