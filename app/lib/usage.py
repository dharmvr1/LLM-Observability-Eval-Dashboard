# Counts the tokens our judge LLM calls use, and stops a job before it burns the daily quota.
# Used by eval_job.py and pii.py. Plain module-level state, no classes.
import os

import clickhouse_connect

# Groq's free tier allows 200,000 tokens/day per model. Stay under it with some room.
DAILY_TOKEN_BUDGET = int(os.environ.get("JUDGE_DAILY_TOKEN_BUDGET", "150000"))

db = clickhouse_connect.get_client(host="localhost", port=8123, username="default", password="dev")

rows = []  # usage rows waiting to be saved
current = {"job": "", "span_id": ""}  # set by the job before it scores a span


def record(model, usage):
    """Call after every LLM call with response.usage."""
    if usage is None:
        return
    rows.append([current["job"], model, current["span_id"],
                 usage.prompt_tokens, usage.completion_tokens, usage.total_tokens])


def flush():
    if rows:
        db.insert("otel.judge_usage", rows,
                  column_names=["job", "model", "scored_span_id", "prompt_tokens", "completion_tokens", "total_tokens"])
        rows.clear()


def tokens_left(model):
    """Budget minus what this model used in the last 24 hours (saved rows plus unsaved ones)."""
    used = db.query(
        "SELECT sum(total_tokens) FROM otel.judge_usage WHERE model = {m:String} AND created_at > now() - INTERVAL 24 HOUR",
        parameters={"m": model},
    ).result_rows[0][0]
    used += sum(r[5] for r in rows if r[1] == model)
    return DAILY_TOKEN_BUDGET - used
