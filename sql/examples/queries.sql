-- Run any of these with:
--   curl -s -u default:dev http://localhost:8123/ --data-binary "<query> FORMAT PrettyCompact"

-- 1. Calls, average latency and tokens per gen_ai_request_model
SELECT gen_ai_request_model, count() AS calls, round(avg(latency_ms)) AS avg_ms, sum(input_tokens) AS in_tok, sum(output_tokens) AS out_tok
FROM otel.spans
GROUP BY gen_ai_request_model
ORDER BY calls DESC;

-- 2. Error rate per app_id in the last hour
SELECT app_id, count() AS calls, countIf(status = 'Error') AS errors
FROM otel.spans
WHERE start_time > now() - INTERVAL 1 HOUR
GROUP BY app_id;

-- 3. p95 latency per minute (this is the kind of query the dashboard will run)
SELECT toStartOfMinute(start_time) AS minute, quantile(0.95)(latency_ms) AS p95_ms
FROM otel.spans
GROUP BY minute
ORDER BY minute;
