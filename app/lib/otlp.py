# Send fake LLM-call spans to the OpenTelemetry collector over OTLP/HTTP, without any LLM.
# Used by the regression probe (app/measure/regression_probe.py).
import json
import secrets
import time
import urllib.request

COLLECTOR_URL = "http://127.0.0.1:4318/v1/traces"


def make_span(prompt, answer, user_id, model="stub-bot"):
    """One finished LLM call that started now. Returns (span, trace_id)."""
    now_ns = time.time_ns()
    messages = [{"role": "user", "parts": [{"content": prompt, "type": "text"}]}]
    reply = [{"role": "assistant", "parts": [{"content": answer, "type": "text"}], "finish_reason": "stop"}]
    trace_id = secrets.token_hex(16)
    span = {
        "traceId": trace_id, "spanId": secrets.token_hex(8), "name": "openai.chat", "kind": 3,
        "startTimeUnixNano": str(now_ns), "endTimeUnixNano": str(now_ns + 400_000_000),
        "attributes": [
            {"key": "gen_ai.input.messages", "value": {"stringValue": json.dumps(messages)}},
            {"key": "gen_ai.output.messages", "value": {"stringValue": json.dumps(reply)}},
            {"key": "gen_ai.request.model", "value": {"stringValue": model}},
            {"key": "traceloop.association.properties.user_id", "value": {"stringValue": user_id}},
        ],
        "status": {"code": 1},
    }
    return span, trace_id


def send(app, spans):
    """POST the spans to the collector as coming from the service `app`."""
    body = {"resourceSpans": [{
        "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": app}}]},
        "scopeSpans": [{"scope": {"name": "probe"}, "spans": spans}],
    }]}
    request = urllib.request.Request(COLLECTOR_URL, json.dumps(body).encode(), {"Content-Type": "application/json"})
    urllib.request.urlopen(request, timeout=10).read()
