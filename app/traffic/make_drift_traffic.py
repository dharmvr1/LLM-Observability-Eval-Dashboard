# Creates FAKE history for testing drift detection, without calling any LLM.
# It sends spans with timestamps in the past: a "baseline" (days 8 to 35 ago) and a "current"
# week (the last 7 days), for three demo apps:
#   drift-demo-stable   current week looks like the baseline        -> PSI should be low
#   drift-demo-partial  30% of the current week is off-topic        -> PSI in between
#   drift-demo-shifted  the current week is completely off-topic    -> PSI should be high
#
#   python -m app.traffic.make_drift_traffic          create the spans
#   python -m app.traffic.make_drift_traffic clean    delete everything this script created
import json
import random
import secrets
import sys
import time
import urllib.request

import clickhouse_connect

random.seed(7)  # same fake data on every run

ITEMS = ["headphones", "a laptop", "my ebook", "a jacket", "the phone case", "a gift card", "running shoes", "a blender"]
PLACES = ["Canada", "Germany", "Australia", "Brazil", "Japan", "the UK", "Mexico", "India"]
DAYS = ["Monday", "Saturday", "Sunday", "Friday", "a public holiday", "Wednesday"]
SUPPORT = [
    "Can I get a refund for {item}?", "How do I return {item}?", "What is your refund policy for {item}?",
    "How long does shipping to {place} take?", "Do you ship to {place}?", "How much is express shipping to {place}?",
    "Is support open on {day}?", "What time does the help desk close on {day}?", "Can I call support on {day}?",
    "How do I reset my password?", "I cannot log in to my account, what should I do?", "Where is my order for {item}?",
    "How do I track the parcel with {item}?", "Can I change the delivery address for {item}?",
]
COINS = ["bitcoin", "ethereum", "dogecoin", "solana"]
DRUGS = ["ibuprofen", "warfarin", "melatonin", "metformin"]
TASKS = ["reverse a linked list", "parse a CSV file", "merge two sorted arrays", "call a REST API with retries"]
LEGAL = ["raise my rent without notice", "enter my flat while I am away", "keep my deposit", "evict me in winter"]
OFF_TOPIC = [
    "Write a python function to {task}.", "Should I buy {coin} now or wait for a dip?",
    "What dosage of {drug} is safe for an adult?", "Can my landlord {legal}?",
    "Explain how {coin} mining works and what it costs.", "Show me a rust example that can {task}.",
    "Is it safe to take {drug} with alcohol?", "What are my rights if my landlord tries to {legal}?",
]


def support_prompt():
    return random.choice(SUPPORT).format(item=random.choice(ITEMS), place=random.choice(PLACES), day=random.choice(DAYS))


def off_topic_prompt():
    return random.choice(OFF_TOPIC).format(coin=random.choice(COINS), drug=random.choice(DRUGS),
                                           task=random.choice(TASKS), legal=random.choice(LEGAL))


def make_span(app, prompt, when_ns):
    messages = [{"role": "user", "parts": [{"content": prompt, "type": "text"}]}]
    answer = [{"role": "assistant", "parts": [{"content": "Thanks for your question.", "type": "text"}], "finish_reason": "stop"}]
    return app, {
        "traceId": secrets.token_hex(16), "spanId": secrets.token_hex(8), "name": "openai.chat", "kind": 3,
        "startTimeUnixNano": str(when_ns), "endTimeUnixNano": str(when_ns + 400_000_000),
        "attributes": [
            {"key": "gen_ai.input.messages", "value": {"stringValue": json.dumps(messages)}},
            {"key": "gen_ai.output.messages", "value": {"stringValue": json.dumps(answer)}},
            {"key": "gen_ai.request.model", "value": {"stringValue": "synthetic"}},
        ],
        "status": {"code": 1},
    }


def send(spans):
    by_app = {}
    for app, span in spans:
        by_app.setdefault(app, []).append(span)
    resource_spans = [
        {"resource": {"attributes": [{"key": "service.name", "value": {"stringValue": app}}]},
         "scopeSpans": [{"scope": {"name": "drift-demo"}, "spans": group}]}
        for app, group in by_app.items()
    ]
    req = urllib.request.Request("http://localhost:4318/v1/traces", json.dumps({"resourceSpans": resource_spans}).encode(),
                                 {"Content-Type": "application/json"})
    urllib.request.urlopen(req).read()


def random_time_ns(days_ago_min, days_ago_max):
    seconds_ago = random.uniform(days_ago_min * 86400, days_ago_max * 86400)
    return time.time_ns() - int(seconds_ago * 1e9)


if len(sys.argv) > 1 and sys.argv[1] == "clean":
    db = clickhouse_connect.get_client(host="localhost", port=8123, username="default", password="dev")
    for sql in ["ALTER TABLE otel.spans DELETE WHERE app_id LIKE 'drift-demo-%'",
                "ALTER TABLE otel.otel_traces DELETE WHERE ServiceName LIKE 'drift-demo-%'",
                "ALTER TABLE otel.drift DELETE WHERE app_id LIKE 'drift-demo-%'"]:
        db.command(sql + " SETTINGS mutations_sync = 1")
    print("deleted the drift-demo data")
    sys.exit()

BASELINE_COUNT, CURRENT_COUNT = 200, 80
OFF_TOPIC_SHARE = {"drift-demo-stable": 0.0, "drift-demo-partial": 0.3, "drift-demo-shifted": 1.0}

spans = []
for app, share in OFF_TOPIC_SHARE.items():
    for _ in range(BASELINE_COUNT):
        spans.append(make_span(app, support_prompt(), random_time_ns(8, 35)))
    for _ in range(CURRENT_COUNT):
        prompt = off_topic_prompt() if random.random() < share else support_prompt()
        spans.append(make_span(app, prompt, random_time_ns(1 / 24, 6.9)))  # at least an hour old

for i in range(0, len(spans), 100):
    send(spans[i:i + 100])
print(f"sent {len(spans)} spans for {len(OFF_TOPIC_SHARE)} apps")
