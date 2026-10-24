-- Every alert Alertmanager sent to our local receiver (app/jobs/alert_receiver.py).
-- received_at is the moment the alert arrived: step 9 measures "time from bug to alert" with it.
CREATE TABLE IF NOT EXISTS otel.alert_events
(
    received_at   DateTime64(3) DEFAULT now64(3),
    status        LowCardinality(String),        -- firing | resolved
    alertname     String,
    severity      LowCardinality(String),
    app_id        String,
    summary       String,
    starts_at     DateTime64(3),                 -- when Prometheus first saw the problem
    labels        Map(String, String)
)
ENGINE = MergeTree
ORDER BY received_at;
