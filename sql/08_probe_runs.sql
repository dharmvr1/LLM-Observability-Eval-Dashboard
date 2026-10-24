-- One row per regression-probe trial (app/measure/regression_probe.py).
-- Every "after_leak" column is the number of seconds since the first leaking response was sent
-- (-1 = that step was never seen).
CREATE TABLE IF NOT EXISTS otel.probe_runs
(
    started_at              DateTime64(3),     -- when the bug was "deployed"
    sample_pct              UInt8,             -- the collector's SUCCESS_SAMPLE_PCT during the trial
    request_rate            Float32,           -- fake requests per second
    leak_rate               Float32,           -- share of answers that contain an SSN after the bug
    seconds_to_first_leak   Float32,           -- deploy -> first leaking answer
    stored_after_leak       Float32,           -- span visible in otel.spans
    triage_after_leak       Float32,           -- row in otel.pii_triage
    metric_after_leak       Float32,           -- Prometheus shows the open item
    firing_after_leak       Float32,           -- Prometheus alert is firing
    received_after_leak     Float32,           -- Alertmanager delivered it to the local receiver
    slack_after_leak        Float32,           -- Alertmanager's Slack counter went up
    deploy_to_slack         Float32,           -- bug deployed -> Slack (the README's MTTR), -1 if never
    deploy_to_received      Float32,           -- bug deployed -> receiver
    passed                  UInt8,             -- 1 if the alert arrived within 300 seconds of the deploy
    note                    String
)
ENGINE = MergeTree
ORDER BY started_at;
