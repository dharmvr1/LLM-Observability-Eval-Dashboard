# Step 4: score recent LLM calls with DeepEval and write the scores back to ClickHouse.
#
#   python -m app.jobs.eval_job           run once
#   python -m app.jobs.eval_job loop      run every 15 minutes (the "scheduled job")
#
# Per run:
#   1. read spans from the last 15 minutes that have not been scored yet
#   2. for each one, run DeepEval faithfulness, answer relevancy and toxicity
#   3. insert one row per (span, metric) into otel.evals
#
# NOTE: this script does NOT call Traceloop.init(). The judge's own LLM calls must not
# become spans, otherwise the eval job would end up scoring itself.
import json
import os
import secrets
import sys
import time

# Must be set before importing deepeval.
os.environ["DEEPEVAL_TELEMETRY_OPT_OUT"] = "YES"

import clickhouse_connect
from app.lib import usage
from deepeval.metrics import AnswerRelevancyMetric, FaithfulnessMetric, ToxicityMetric
from deepeval.models import DeepEvalBaseLLM
from deepeval.test_case import LLMTestCase
from openai import OpenAI

WINDOW_MINUTES = 15
MAX_SPANS_PER_RUN = 20  # every span costs several judge calls, so keep a cap
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "openai/gpt-oss-20b")
# 0 = always pick the most likely answer, so the same input gives (almost) the same score.
# The Groq default is 1, which made scores jump between runs.
JUDGE_TEMPERATURE = float(os.environ.get("JUDGE_TEMPERATURE", "0"))

# If the bot says one of these, it is declining to answer. That is correct behaviour when the
# context does not contain the answer, so faithfulness (which checks claims) does not apply.
REFUSAL_PHRASES = [
    "i don't have",
    "i do not have",
    "i'm sorry, but i",
    "i cannot",
    "i can't",
    "not able to find",
    "no information",
    "doesn't say",
    "does not say",
]

db = clickhouse_connect.get_client(
    host="localhost", port=8123, username="default", password="dev"
)
# max_retries=0: the client's built-in retries wait silently; GroqJudge.generate retries
# itself and prints every retry, so slow runs are visible.
# The judge can be any OpenAI-compatible endpoint. Default: Groq. To use the local freellmapi
# gateway instead, set JUDGE_BASE_URL=http://localhost:3001/v1, JUDGE_API_KEY=$FREELLMAPI_KEY and
# a pinned JUDGE_MODEL (not "auto": it switches models between calls, which makes scores noisy).
JUDGE_BASE_URL = os.environ.get("JUDGE_BASE_URL", "https://api.groq.com/openai/v1")
JUDGE_API_KEY = os.environ.get("JUDGE_API_KEY") or os.environ["GROQ_API_KEY"]
groq = OpenAI(base_url=JUDGE_BASE_URL, api_key=JUDGE_API_KEY, max_retries=0, timeout=60)


# DeepEval calls OpenAI by default. This is the one class we need so that it calls
# Groq instead. It only has to answer "given a prompt, return text" (or a filled schema).
class GroqJudge(DeepEvalBaseLLM):
    def load_model(self):
        return groq

    def generate(self, prompt, schema=None):
        kwargs = {}
        if schema is not None:
            kwargs["response_format"] = {"type": "json_object"}  # ask for JSON only
        for attempt in range(5):
            try:
                r = groq.chat.completions.create(
                    model=JUDGE_MODEL,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=JUDGE_TEMPERATURE,
                    **kwargs,
                )
                usage.record(JUDGE_MODEL, r.usage)
                text = r.choices[0].message.content
                return schema.model_validate_json(text) if schema is not None else text
            except Exception as e:
                # rate limit or bad JSON: wait and try again
                print(f"   judge retry {attempt + 1}: {type(e).__name__}")
                time.sleep(10 * (attempt + 1))  # rate limits reset per minute, so wait long
        raise RuntimeError("judge failed 5 times")

    async def a_generate(self, prompt, schema=None):
        return self.generate(prompt, schema)

    def get_model_name(self):
        return JUDGE_MODEL


judge = GroqJudge()


def message_text(messages_json, role):
    """Join the text of all messages with this role. Format: [{"role":..,"parts":[{"content":..}]}]"""
    texts = []
    for message in json.loads(messages_json):
        if message["role"] == role:
            for part in message["parts"]:
                texts.append(part.get("content", ""))
    return "\n".join(texts)


def find_unscored_spans():
    sql = f"""
        SELECT trace_id, span_id, app_id, user_id,
               attributes['gen_ai.input.messages'], attributes['gen_ai.output.messages']
        FROM otel.spans
        WHERE start_time > now() - INTERVAL {WINDOW_MINUTES} MINUTE
          AND status != 'Error'
          AND attributes['gen_ai.output.messages'] != ''
          AND span_id NOT IN (SELECT scored_span_id FROM otel.evals)
        ORDER BY start_time
        LIMIT {MAX_SPANS_PER_RUN}
    """
    return db.query(sql).result_rows


def is_refusal(answer):
    text = answer.lower().replace("\u2019", "'")  # curly apostrophe -> plain
    return any(phrase in text for phrase in REFUSAL_PHRASES)


def score_span(question, answer, context):
    """Return (results, failed): results is a list of (metric_name, score, passed, reason),
    failed is how many metrics could not be scored."""
    case = LLMTestCase(
        input=question,
        actual_output=answer,
        retrieval_context=[context] if context else None,
    )

    metrics = [
        ("answer_relevancy", AnswerRelevancyMetric(model=judge, threshold=0.5, include_reason=True)),
        ("toxicity", ToxicityMetric(model=judge, threshold=0.5, include_reason=True)),
    ]

    results = []
    refused = is_refusal(answer)
    if refused:
        # Record that it happened so we can count refusals later; do not run faithfulness.
        results.append(("refusal", 1.0, 1, "answer declines to answer; faithfulness skipped"))
    elif context:
        # Faithfulness compares the answer to the context, so it needs a context.
        # penalize_ambiguous_claims: without it, claims the context neither supports nor
        # contradicts still pass, so an answer that invents extra facts would score 1.0.
        metrics.append(
            (
                "faithfulness",
                FaithfulnessMetric(
                    model=judge, threshold=0.8, include_reason=True, penalize_ambiguous_claims=True
                ),
            )
        )

    failed = 0
    for name, metric in metrics:
        try:
            metric.measure(case)
            results.append(
                (
                    name,
                    float(metric.score),
                    int(metric.is_successful()),
                    metric.reason or "",
                )
            )
        except Exception as e:
            failed += 1
            print(f"   {name} failed: {type(e).__name__}: {str(e)[:100]}")
    return results, failed


def run_once():
    spans = find_unscored_spans()
    print(f"found {len(spans)} unscored spans in the last {WINDOW_MINUTES} min")

    rows = []
    usage.current["job"] = "eval_job"
    for trace_id, span_id, app_id, user_id, input_json, output_json in spans:
        # Stop before the daily token budget is gone. Unscored spans simply wait for the next run.
        if usage.tokens_left(JUDGE_MODEL) <= 0:
            print(f"daily token budget ({usage.DAILY_TOKEN_BUDGET}) reached for {JUDGE_MODEL}, stopping")
            break
        usage.current["span_id"] = span_id
        question = message_text(input_json, "user")
        context = message_text(input_json, "system")
        answer = message_text(output_json, "assistant")
        print(f"- {user_id}: {question[:60]!r}")

        results, failed = score_span(question, answer, context)
        usage.flush()  # save the tokens this span used, even if it failed
        if failed:
            # Save nothing for this span: it stays "unscored" and is retried on the next run.
            print(f"   {failed} metric(s) failed, will retry this span next run")
            continue

        for name, score, passed, reason in results:
            print(f"   {name:16} score={score:.2f} passed={passed}")
            eval_span_id = secrets.token_hex(8)
            rows.append(
                [trace_id, span_id, eval_span_id, app_id, user_id, name, score, passed, reason, JUDGE_MODEL]
            )

    if rows:
        db.insert(
            "otel.evals",
            rows,
            column_names=[
                "trace_id",
                "scored_span_id",
                "eval_span_id",
                "app_id",
                "user_id",
                "metric",
                "score",
                "passed",
                "reason",
                "judge_model",
            ],
        )
    print(f"wrote {len(rows)} eval rows")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "loop":
        while True:
            run_once()
            time.sleep(WINDOW_MINUTES * 60)
    else:
        run_once()
