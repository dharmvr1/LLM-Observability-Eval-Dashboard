# Step 6: has the kind of prompt people send changed?
#
#   python -m app.jobs.drift_job
#
# For each app (and for all apps together):
#   1. take the prompts of the CURRENT window (default last 7 days) and of the BASELINE window
#      (the 28 days before that)
#   2. turn every prompt into an embedding (a vector that captures its meaning)
#   3. give every prompt ONE number: its cosine similarity to the baseline's centroid (average)
#   4. cut the baseline numbers into 5 equal-size bins (quintiles) and count how many current
#      prompts fall in each bin
#   5. PSI = sum over bins of (current% - baseline%) * ln(current% / baseline%)
# PSI below 0.1: stable.  0.1 to 0.2: some change.  Above 0.2: significant drift (we alert).
#
# Like the other jobs, this does not call Traceloop.init. It needs no LLM, only a local embedding model.
import datetime
import json
import os

os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

import clickhouse_connect
import numpy as np
from sentence_transformers import SentenceTransformer

CURRENT_DAYS = int(os.environ.get("DRIFT_CURRENT_DAYS", "7"))
BASELINE_DAYS = int(os.environ.get("DRIFT_BASELINE_DAYS", "28"))
MIN_PROMPTS = 30          # PSI on fewer prompts than this is mostly noise
PSI_THRESHOLD = 0.2
BINS = 5   # NOT 10: with ~80 current prompts, 10 bins gave a PSI above 0.2 in 44% of no-drift random splits
EMPTY_BIN = 0.0001        # a bin with no prompts would make ln() blow up, so use a tiny share instead

db = clickhouse_connect.get_client(host="localhost", port=8123, username="default", password="dev")
model = SentenceTransformer("all-MiniLM-L6-v2")  # small, runs on CPU, 384 numbers per prompt


def last_user_text(messages_json):
    """The text of the last user message. Format: [{"role":..,"parts":[{"content":..}]}]"""
    text = ""
    for message in json.loads(messages_json):
        if message["role"] == "user":
            text = "\n".join(part.get("content", "") for part in message["parts"])
    return text


def psi(baseline_scores, current_scores):
    """Population Stability Index of two sets of numbers, using the baseline's quantiles as bins."""
    edges = np.quantile(baseline_scores, np.linspace(0, 1, BINS + 1)[1:-1])  # BINS - 1 inner cut points
    baseline_share = np.bincount(np.digitize(baseline_scores, edges), minlength=BINS) / len(baseline_scores)
    current_share = np.bincount(np.digitize(current_scores, edges), minlength=BINS) / len(current_scores)
    baseline_share = np.maximum(baseline_share, EMPTY_BIN)
    current_share = np.maximum(current_share, EMPTY_BIN)
    return float(np.sum((current_share - baseline_share) * np.log(current_share / baseline_share)))


def check_group(app_id, rows, boundary, now):
    """rows: [(start_time, text)]. boundary: the time that splits baseline from current."""
    baseline_texts = [text for when, text in rows if when < boundary]
    current_texts = [text for when, text in rows if when >= boundary]
    note = ""
    value = -1.0

    if len(baseline_texts) < MIN_PROMPTS or len(current_texts) < MIN_PROMPTS:
        note = f"insufficient data (need {MIN_PROMPTS} prompts in each window)"
    else:
        # normalize_embeddings=True makes every vector length 1, so a dot product is the cosine similarity.
        baseline_vectors = model.encode(baseline_texts, normalize_embeddings=True, batch_size=64)
        current_vectors = model.encode(current_texts, normalize_embeddings=True, batch_size=64)
        centroid = baseline_vectors.mean(axis=0)
        centroid = centroid / np.linalg.norm(centroid)
        baseline_scores = baseline_vectors @ centroid
        current_scores = current_vectors @ centroid
        value = psi(baseline_scores, current_scores)

        # Show the least typical current prompts, so a person can see WHAT changed.
        worst = np.argsort(current_scores)[:3]
        note = "least typical current prompts: " + " | ".join(current_texts[i][:50] for i in worst)

    alert = int(value > PSI_THRESHOLD)
    verdict = "ALERT" if alert else ("no data" if value < 0 else "ok")
    print(f"{app_id:20} baseline={len(baseline_texts):4} current={len(current_texts):4} "
          f"psi={value:6.3f}  {verdict}")
    if alert:
        print(f"{'':20} {note}")
    baseline_start = boundary - datetime.timedelta(days=BASELINE_DAYS)
    return [app_id, baseline_start, boundary, boundary, now,
            len(baseline_texts), len(current_texts), value, PSI_THRESHOLD, alert, note]


def run_once():
    boundary, now = db.query(f"SELECT now() - INTERVAL {CURRENT_DAYS} DAY, now()").result_rows[0]
    rows = db.query(f"""
        SELECT app_id, start_time, attributes['gen_ai.input.messages']
        FROM otel.spans
        WHERE start_time >= now() - INTERVAL {CURRENT_DAYS + BASELINE_DAYS} DAY
          AND attributes['gen_ai.input.messages'] != ''
          AND start_time < now() - INTERVAL 1 MINUTE
    """).result_rows

    by_app = {}
    for app_id, when, messages_json in rows:
        text = last_user_text(messages_json)
        if text:
            by_app.setdefault(app_id, []).append((when, text))
    by_app["ALL"] = [item for items in list(by_app.values()) for item in items]

    print(f"windows: baseline = {BASELINE_DAYS} days before the last {CURRENT_DAYS} days, threshold = {PSI_THRESHOLD}")
    results = [check_group(app_id, items, boundary, now) for app_id, items in sorted(by_app.items())]
    db.insert("otel.drift", results, column_names=[
        "app_id", "baseline_from", "baseline_to", "current_from", "current_to",
        "baseline_count", "current_count", "psi", "threshold", "alert", "note"])


if __name__ == "__main__":
    run_once()
