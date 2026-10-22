-- One row per (LLM span, metric). This is our "eval span": it points at the span
-- it scored through trace_id + scored_span_id.
CREATE TABLE IF NOT EXISTS otel.evals
(
    created_at       DateTime DEFAULT now(),
    trace_id         String,
    scored_span_id   String,                  -- the LLM call that was scored
    eval_span_id     String,                  -- id of this eval itself
    app_id           LowCardinality(String),
    user_id          String,
    metric           LowCardinality(String),  -- faithfulness | answer_relevancy | toxicity
    score            Float32,                 -- 0..1 as DeepEval reports it
    passed           UInt8,                   -- 1 if DeepEval says the threshold was met
    reason           String,
    judge_model      String
)
ENGINE = MergeTree
ORDER BY (metric, created_at);
