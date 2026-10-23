-- The collector writes raw spans into otel.otel_traces.
-- We copy each new span into our own table "spans" with the columns we care about.
-- Safe to run again: nothing is dropped. Needs otel.otel_traces to exist, which the collector
-- creates when it first starts (so run `make up`, wait a few seconds, then `make schema`).

CREATE TABLE IF NOT EXISTS otel.spans
(
    start_time            DateTime64(9),
    trace_id              String,
    span_id               String,
    parent_span_id        String,
    name                  String,
    app_id                LowCardinality(String),
    user_id               String,
    gen_ai_system         LowCardinality(String),
    api_base              String,
    gen_ai_request_model  LowCardinality(String),
    input_tokens          UInt32,
    output_tokens         UInt32,
    latency_ms            Float64,
    status                LowCardinality(String),
    prompt_hash           UInt64,
    attributes            Map(String, String),   -- the "bag" with everything else (prompts, completions...)

    INDEX idx_user user_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_app  app_id  TYPE bloom_filter GRANULARITY 4
)
ENGINE = MergeTree
ORDER BY (app_id, start_time);

-- Runs on every insert into otel_traces and fills "spans".
-- Different SDK versions use different attribute names, so we try the new name, then the old one.
CREATE MATERIALIZED VIEW IF NOT EXISTS otel.spans_mv TO otel.spans AS
SELECT
    Timestamp                                    AS start_time,
    TraceId                                      AS trace_id,
    SpanId                                       AS span_id,
    ParentSpanId                                 AS parent_span_id,
    SpanName                                     AS name,
    ServiceName                                  AS app_id,
    SpanAttributes['traceloop.association.properties.user_id'] AS user_id,
    if(SpanAttributes['gen_ai.provider.name'] != '',
       SpanAttributes['gen_ai.provider.name'],
       SpanAttributes['gen_ai.system'])          AS gen_ai_system,
    SpanAttributes['gen_ai.openai.api_base']     AS api_base,
    SpanAttributes['gen_ai.request.model']       AS gen_ai_request_model,
    toUInt32OrZero(if(SpanAttributes['gen_ai.usage.input_tokens'] != '',
       SpanAttributes['gen_ai.usage.input_tokens'],
       SpanAttributes['gen_ai.usage.prompt_tokens']))     AS input_tokens,
    toUInt32OrZero(if(SpanAttributes['gen_ai.usage.output_tokens'] != '',
       SpanAttributes['gen_ai.usage.output_tokens'],
       SpanAttributes['gen_ai.usage.completion_tokens'])) AS output_tokens,
    Duration / 1000000                           AS latency_ms,
    StatusCode                                   AS status,
    cityHash64(if(SpanAttributes['gen_ai.input.messages'] != '',
       SpanAttributes['gen_ai.input.messages'],
       SpanAttributes['gen_ai.prompt.0.content']))        AS prompt_hash,
    SpanAttributes                               AS attributes
FROM otel.otel_traces;
