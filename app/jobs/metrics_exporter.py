# Step 8: turn our ClickHouse tables into Prometheus metrics.
#
#   python -m app.jobs.metrics_exporter        serves http://127.0.0.1:9108/metrics
#
# Prometheus reads that page every 15 seconds. Every 10 seconds this script re-runs five small
# queries and puts the answers into "gauges" (a number that can go up and down).
# If ClickHouse is down, the old numbers stay and `exporter_last_success_timestamp_seconds` stops
# moving, which an alert rule watches.
import os
import time

import clickhouse_connect
from prometheus_client import Counter, Gauge, start_http_server

PORT = 9108
REFRESH_SECONDS = 10
DAILY_TOKEN_BUDGET = int(os.environ.get("JUDGE_DAILY_TOKEN_BUDGET", "150000"))

db = clickhouse_connect.get_client(host="localhost", port=8123, username="default", password="dev")

llm_calls = Gauge("llm_calls_15m", "LLM calls in the last 15 minutes", ["app_id"])
llm_errors = Gauge("llm_errors_15m", "Failed LLM calls in the last 15 minutes", ["app_id"])
llm_latency = Gauge("llm_latency_ms", "Latency of LLM calls in the last 15 minutes", ["app_id", "quantile"])

eval_scored = Gauge("eval_scored_1h", "Scores written in the last hour", ["metric"])
eval_mean = Gauge("eval_score_mean_1h", "Mean score (0 to 1, higher is better) in the last hour", ["metric"])
eval_failed = Gauge("eval_failed_1h", "Scores that did not pass in the last hour", ["metric"])

pii_items = Gauge("pii_triage_items", "Items in the PII triage queue, per app and status", ["app_id", "status"])
pii_oldest_open = Gauge("pii_open_oldest_age_seconds", "Age of the oldest unresolved high-priority PII item")

drift_psi = Gauge("drift_psi", "Latest PSI of the prompts of an app", ["app_id"])
drift_flag = Gauge("drift_alert", "1 when the latest PSI is above the threshold", ["app_id"])

judge_tokens = Gauge("judge_tokens_24h", "Tokens used by the judge LLM calls in the last 24 hours", ["model"])
judge_budget = Gauge("judge_token_budget", "Daily token budget of the jobs")
judge_budget.set(DAILY_TOKEN_BUDGET)

last_success = Gauge("exporter_last_success_timestamp_seconds", "When the last full refresh worked")
errors = Counter("exporter_refresh_errors_total", "Refreshes that failed")


def refresh():
    # The fake drift-demo apps are test data, so they are not reported as LLM traffic.
    calls = db.query("""
        SELECT app_id, count(), countIf(status = 'Error'),
               quantile(0.5)(latency_ms), quantile(0.95)(latency_ms), quantile(0.99)(latency_ms)
        FROM otel.spans
        WHERE start_time > now() - INTERVAL 15 MINUTE AND gen_ai_request_model != '' AND app_id NOT LIKE 'drift-demo-%'
        GROUP BY app_id""").result_rows
    evals = db.query("""
        SELECT metric, count(), avg(score), countIf(passed = 0)
        FROM otel.evals WHERE created_at > now() - INTERVAL 1 HOUR AND metric != 'refusal' GROUP BY metric""").result_rows
    pii = db.query("""
        SELECT app_id, status, count(), max(dateDiff('second', created_at, now())) FROM otel.pii_triage GROUP BY app_id, status""").result_rows
    drift = db.query("""
        SELECT app_id, argMax(psi, created_at), argMax(alert, created_at)
        FROM otel.drift GROUP BY app_id HAVING argMax(psi, created_at) >= 0""").result_rows
    tokens = db.query("""
        SELECT model, sum(total_tokens) FROM otel.judge_usage WHERE created_at > now() - INTERVAL 24 HOUR GROUP BY model""").result_rows

    # clear() first, so an app or metric that disappeared from the window does not keep an old value
    for gauge in (llm_calls, llm_errors, llm_latency, eval_scored, eval_mean, eval_failed, pii_items, drift_psi, drift_flag, judge_tokens):
        gauge.clear()

    for app_id, n, failed, p50, p95, p99 in calls:
        llm_calls.labels(app_id).set(n)
        llm_errors.labels(app_id).set(failed)
        for quantile, value in (("0.5", p50), ("0.95", p95), ("0.99", p99)):
            llm_latency.labels(app_id, quantile).set(value)
    for metric, n, mean, failed in evals:
        eval_scored.labels(metric).set(n)
        eval_mean.labels(metric).set(mean)
        eval_failed.labels(metric).set(failed)
    # One series per (app, status) that has items. When an app's last open item is resolved its series
    # disappears, which is exactly what makes the alert for that app resolve.
    oldest_open = 0
    for app_id, status, n, age in pii:
        pii_items.labels(app_id, status).set(n)
        if status == "open":
            oldest_open = max(oldest_open, age)
    pii_oldest_open.set(oldest_open)
    for app_id, psi, flag in drift:
        drift_psi.labels(app_id).set(psi)
        drift_flag.labels(app_id).set(flag)
    for model, total in tokens:
        judge_tokens.labels(model).set(total)
    last_success.set(time.time())


if __name__ == "__main__":
    start_http_server(PORT, addr="127.0.0.1")  # loopback only: nobody else on the network can read it
    print(f"serving metrics on http://127.0.0.1:{PORT}/metrics, refreshing every {REFRESH_SECONDS}s", flush=True)
    while True:
        try:
            refresh()
        except Exception as e:
            errors.inc()
            print(f"refresh failed: {type(e).__name__}: {str(e)[:150]}", flush=True)
        time.sleep(REFRESH_SECONDS)
