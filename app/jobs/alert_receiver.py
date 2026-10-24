# Step 8: a tiny web server that Alertmanager sends every alert to (a "webhook receiver").
#
#   python -m app.jobs.alert_receiver        listens on http://127.0.0.1:9199
#
# It writes each alert into otel.alert_events with the exact moment it arrived. That gives us
#   - an alert history for the dashboard, and
#   - the "time from bug to alert" number for step 9, without depending on Slack.
# Alertmanager's JSON looks like {"status": "firing", "alerts": [{"labels": {...}, "annotations": {...}, "startsAt": "..."}]}.
import datetime
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

import clickhouse_connect

db = clickhouse_connect.get_client(host="localhost", port=8123, username="default", password="dev")


def parse_time(text):
    """'2026-10-24T10:15:30.123Z' -> a datetime that knows it is UTC.

    Keep the timezone on it: clickhouse-connect treats a datetime WITHOUT timezone as local time and
    converts it, which shifted every start time by this machine's offset (5 hours 30 minutes)."""
    return datetime.datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(datetime.timezone.utc)


# The standard library wants a class here: it calls do_POST for every POST request.
class Receiver(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            rows = []
            for alert in body.get("alerts", []):
                labels = alert.get("labels", {})
                rows.append([
                    alert.get("status", body.get("status", "")),
                    labels.get("alertname", ""),
                    labels.get("severity", ""),
                    labels.get("app_id", ""),
                    alert.get("annotations", {}).get("summary", ""),
                    parse_time(alert["startsAt"]),
                    labels,
                ])
            if rows:
                db.insert("otel.alert_events", rows,
                          column_names=["status", "alertname", "severity", "app_id", "summary", "starts_at", "labels"])
            for row in rows:
                print(f"{datetime.datetime.now():%H:%M:%S} {row[0]:9} {row[2]:9} {row[1]}  {row[4]}", flush=True)
            self.send_response(200)
        except Exception as e:  # tell Alertmanager it failed, so it retries
            print(f"could not store alert: {type(e).__name__}: {str(e)[:150]}", flush=True)
            self.send_response(500)
        self.end_headers()

    def log_message(self, *args):
        pass  # do not print one line per request


if __name__ == "__main__":
    print("alert receiver listening on http://127.0.0.1:9199", flush=True)
    HTTPServer(("127.0.0.1", 9199), Receiver).serve_forever()
