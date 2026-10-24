# Step 5: check recent LLM responses for PII leaks and fill the triage queue.
#
#   python -m app.jobs.pii_job           run once
#   python -m app.jobs.pii_job loop      run every minute (leaks should be found within minutes)
#
# Each run has two passes:
#   Pass 1 (regex, free, instant): every response is checked for an SSN or a card number. Those are
#          saved to the triage queue AT ONCE. Nothing slow or paid happens before this.
#   Pass 2 (guard LLM): the other responses may go to the guard LLM, which catches what the regex
#          cannot (an address, a spelled-out email). The guard is optional: it is skipped for a share of
#          responses (PII_GUARD_SAMPLE), skipped when the daily token budget is used up, and switched
#          off for the rest of the run after its first failure. A leak that the regex can see is
#          therefore never delayed or lost because of the LLM.
# Like eval_job.py, this script does not call Traceloop.init (its own LLM calls must not become spans).
#
# Settings (environment variables): PII_GUARD_SAMPLE (0 to 1, default 1), PII_MAX_SPANS (default 50),
# PII_LOOP_SECONDS (default 60).
import os
import random
import sys
import time

import clickhouse_connect
from app.lib import usage
from app.lib.pii import (
    PII_JUDGE_MODEL,
    REVIEW_RISK,
    ask_guard_llm,
    find_pii_with_regex,
    is_hard_hit,
    mask_digits,
    message_text,
    triage_status,
)

WINDOW_MINUTES = 15
MAX_SPANS_PER_RUN = int(os.environ.get("PII_MAX_SPANS", "50"))
LOOP_SECONDS = int(os.environ.get("PII_LOOP_SECONDS", "60"))
GUARD_SAMPLE = float(os.environ.get("PII_GUARD_SAMPLE", "1"))

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


def save(checks, triage):
    """Write the collected rows to ClickHouse."""
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
            column_names=["trace_id", "span_id", "app_id", "user_id", "risk", "types", "reason", "preview_masked", "status"],
        )


def record(checks, triage, span, hits, llm_score, risk, types, reason):
    """Decide the triage status of one response and add its rows to the lists."""
    trace_id, span_id, app_id, user_id, answer = span
    status = triage_status(hits, llm_score)
    if status == "review":
        # an email or phone matched the regex but the guard did not confirm it (or was not used)
        types = sorted({kind for kind, _ in hits})
        risk = REVIEW_RISK
        if llm_score < 0:
            reason = f"regex matched {', '.join(types)} (guard not used): needs a human look"
        else:
            reason = f"regex matched {', '.join(types)} but the guard scored {llm_score:.2f}: needs a human look"
    print(f"- {app_id}/{user_id}: risk={risk:.2f} types={types} {status.upper() if status else 'ok'}")
    checks.append([trace_id, span_id, app_id, user_id, sorted({k for k, _ in hits}), llm_score, risk, reason, PII_JUDGE_MODEL])
    if status:
        triage.append([trace_id, span_id, app_id, user_id, risk, types, reason, mask_digits(answer[:300]), status])


def run_once():
    rows = find_unchecked_spans()
    print(f"found {len(rows)} unchecked spans in the last {WINDOW_MINUTES} min")
    usage.current["job"] = "pii_job"

    # ---- Pass 1: regex on every response. Hard hits are saved right away.
    checks, triage = [], []
    rest = []  # responses without a hard hit: they may go to the guard LLM in pass 2
    for trace_id, span_id, app_id, user_id, output_json in rows:
        answer = message_text(output_json, "assistant")
        hits = find_pii_with_regex(answer)
        span = (trace_id, span_id, app_id, user_id, answer)
        if is_hard_hit(hits):
            types = sorted({kind for kind, _ in hits})
            record(checks, triage, span, hits, -1.0, 1.0, types, "regex matched: " + ", ".join(types))  # -1 = guard not needed
        else:
            rest.append((span, hits))
    save(checks, triage)
    flagged_now = len(triage)

    # ---- Pass 2: the guard LLM for the rest (optional, never blocks the regex results above)
    checks, triage = [], []
    guard_ok = True
    for span, hits in rest:
        use_guard = guard_ok and random.random() < GUARD_SAMPLE and usage.tokens_left(PII_JUDGE_MODEL) > 0
        if use_guard:
            usage.current["span_id"] = span[1]
            try:
                llm_score, types, reason = ask_guard_llm(span[4])
                record(checks, triage, span, hits, llm_score, llm_score, types, reason)
                continue
            except RuntimeError:
                guard_ok = False  # circuit breaker: do not wait for more retries on every remaining span
                print("guard LLM failed: skipping it for the rest of this run (the regex results are already saved)")
        record(checks, triage, span, hits, -1.0, 0.0, [], "guard not used (sampled out, budget used up, or unavailable)")
    save(checks, triage)
    usage.flush()
    print(f"checked {len(rows)} spans, {flagged_now + len(triage)} sent to triage ({flagged_now} by regex before any LLM call)")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "loop":
        while True:
            run_once()
            time.sleep(LOOP_SECONDS)
    else:
        run_once()
