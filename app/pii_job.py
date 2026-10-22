# Step 5: check recent LLM responses for PII leaks and fill the triage queue.
#
#   python app/pii_job.py           run once
#   python app/pii_job.py loop      run every minute (leaks should be found within minutes)
#
# Per span:  regex first (free). If the regex finds nothing, ask the guard LLM.
#            risk = 1.0 if the regex matched, else the guard's score.
#            risk >= PII_THRESHOLD  ->  also insert into the triage queue.
# Like eval_job.py, this script does not call Traceloop.init (its own LLM calls must not become spans).
import secrets
import sys
import time

import clickhouse_connect
from pii import (
    PII_JUDGE_MODEL,
    PII_THRESHOLD,
    ask_guard_llm,
    find_pii_with_regex,
    mask_digits,
    message_text,
)

WINDOW_MINUTES = 15
MAX_SPANS_PER_RUN = 50
LOOP_SECONDS = 60

db = clickhouse_connect.get_client(host="localhost", port=8123, username="default", password="dev")


def find_unchecked_spans():
    sql = f"""
        SELECT trace_id, span_id, app_id, user_id, attributes['gen_ai.output.messages']
        FROM otel.spans
        WHERE start_time > now() - INTERVAL {WINDOW_MINUTES} MINUTE
          AND status != 'Error'
          AND attributes['gen_ai.output.messages'] != ''
          AND span_id NOT IN (SELECT scored_span_id FROM otel.pii_checks)
        ORDER BY start_time
        LIMIT {MAX_SPANS_PER_RUN}
    """
    return db.query(sql).result_rows


def run_once():
    spans = find_unchecked_spans()
    print(f"found {len(spans)} unchecked spans in the last {WINDOW_MINUTES} min")

    checks = []  # rows for otel.pii_checks
    triage = []  # rows for otel.pii_triage
    for trace_id, span_id, app_id, user_id, output_json in spans:
        answer = message_text(output_json, "assistant")

        hits = find_pii_with_regex(answer)
        if hits:
            types = sorted({kind for kind, _ in hits})
            llm_score, risk = -1.0, 1.0  # -1 means "guard LLM skipped, regex was enough"
            reason = "regex matched: " + ", ".join(types)
        else:
            try:
                llm_score, types, reason = ask_guard_llm(answer)
            except RuntimeError:
                # Save nothing, so this span is checked again on the next run.
                print(f"- {user_id}: guard failed, will retry next run")
                continue
            risk = llm_score

        flagged = risk >= PII_THRESHOLD
        print(f"- {user_id}: risk={risk:.2f} types={types} {'FLAGGED' if flagged else 'ok'}")

        checks.append([trace_id, span_id, app_id, user_id, sorted({k for k, _ in hits}), llm_score, risk, reason, PII_JUDGE_MODEL])
        if flagged:
            triage.append([trace_id, span_id, app_id, user_id, risk, types, reason, mask_digits(answer[:300])])

    if checks:
        db.insert(
            "otel.pii_checks",
            checks,
            column_names=["trace_id", "scored_span_id", "app_id", "user_id", "regex_types",
                          "llm_score", "risk", "reason", "judge_model"],
        )
    if triage:
        db.insert(
            "otel.pii_triage",
            triage,
            column_names=["trace_id", "span_id", "app_id", "user_id", "risk", "types", "reason", "preview_masked"],
        )
    print(f"checked {len(checks)} spans, {len(triage)} sent to triage")


if len(sys.argv) > 1 and sys.argv[1] == "loop":
    while True:
        run_once()
        time.sleep(LOOP_SECONDS)
else:
    run_once()
