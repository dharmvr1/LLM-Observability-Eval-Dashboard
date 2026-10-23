-- One row per judge LLM call: how many tokens it used and which span it was for.
-- Lets us answer "how many tokens does one scored span cost?" and enforce a daily budget.
CREATE TABLE IF NOT EXISTS otel.judge_usage
(
    created_at         DateTime DEFAULT now(),
    job                LowCardinality(String),   -- eval_job | pii_job | measure
    model              LowCardinality(String),
    scored_span_id     String,                   -- '' when the call is not tied to a span
    prompt_tokens      UInt32,
    completion_tokens  UInt32,
    total_tokens       UInt32
)
ENGINE = MergeTree
ORDER BY (model, created_at);
