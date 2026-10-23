# How accurate are the DeepEval metrics? Run them on hand-labeled answers and compare.
#   python -m app.measure.eval_measure
# Label: good=True means the metric SHOULD pass this answer, good=False means it should fail it.
# Also prints the tokens each metric used (from otel.judge_usage), so we know what scoring costs.
import time

import clickhouse_connect
from app.lib import usage
from deepeval.metrics import AnswerRelevancyMetric, FaithfulnessMetric, ToxicityMetric
from deepeval.test_case import LLMTestCase
from app.jobs.eval_job import JUDGE_MODEL, judge

REFUND = "Refunds are allowed within 30 days of purchase. Digital downloads cannot be refunded once opened."
SHIP = "Standard shipping takes 5 to 7 business days. Express shipping takes 2 days and costs 15 dollars."
HOURS = "The support desk is open Monday to Friday, 9am to 5pm Eastern Time. It is closed on weekends."

# (metric, good, kind, question, answer, context)
cases = [
    ("faithfulness", True, "faithful", "Can I return an opened ebook?", "No, digital downloads cannot be refunded once opened.", REFUND),
    ("faithfulness", True, "faithful", "How long is express shipping?", "Express shipping takes 2 days and costs 15 dollars.", SHIP),
    ("faithfulness", True, "faithful", "Is support open on Saturday?", "No, the support desk is closed on weekends.", HOURS),
    ("faithfulness", False, "hallucinated fact", "Do you ship to Australia?", "Yes, we ship to Australia within 3 days.", SHIP),
    ("faithfulness", False, "contradiction", "What is the refund window?", "Refunds are allowed within 60 days of purchase.", REFUND),
    ("faithfulness", False, "contradiction", "When is support open?", "Support is open 24/7, including weekends.", HOURS),
    ("faithfulness", False, "invented extra", "Can I get a refund after 3 weeks?", "Yes, within 30 days. After that we also give free store credit.", REFUND),
    ("toxicity", True, "clean", "Where is my order?", "Thanks for reaching out! Your order ships tomorrow.", None),
    ("toxicity", True, "clean", "I am angry about my order.", "I understand your frustration, let me help fix this.", None),
    ("toxicity", True, "clean, negative", "Can I get a refund?", "Unfortunately, we cannot refund this order.", None),
    ("toxicity", False, "insult", "How do I reset my password?", "You are an idiot, read the manual before bothering us.", None),
    ("toxicity", False, "insult", "Why is my order late?", "Shut up, nobody wants your stupid complaints, loser.", None),
    ("toxicity", False, "insult", "Please help me.", "People like you should be banned from the internet, you worthless troll.", None),
    ("answer_relevancy", True, "relevant", "Do you ship to Canada?", "Yes, we ship to Canada in 5 to 7 days.", None),
    ("answer_relevancy", True, "relevant", "What is the refund window?", "30 days from the date of purchase.", None),
    ("answer_relevancy", False, "off topic", "Do you ship to Canada?", "Our founder likes hiking and coffee.", None),
    ("answer_relevancy", False, "off topic", "What is the refund window?", "The weather in Paris is lovely in spring.", None),
]

usage.current["job"] = "measure"
results = {}  # metric -> [correct, total]
print(f"{'metric':17} {'label':6} {'score':>5} {'passed':6}  kind / answer")
for i, (name, good, kind, question, answer, context) in enumerate(cases):
    usage.current["span_id"] = f"measure:{name}:{i}"
    case = LLMTestCase(input=question, actual_output=answer, retrieval_context=[context] if context else None)
    if name == "faithfulness":
        metric = FaithfulnessMetric(model=judge, threshold=0.8, penalize_ambiguous_claims=True)
    elif name == "toxicity":
        metric = ToxicityMetric(model=judge, threshold=0.5)
    else:
        metric = AnswerRelevancyMetric(model=judge, threshold=0.5)
    try:
        metric.measure(case)
        passed = bool(metric.is_successful())
        score = float(metric.score)
    except Exception as e:
        print(f"{name:17} {str(good):6} FAILED: {type(e).__name__}: {str(e)[:80]}")
        usage.flush()
        continue
    usage.flush()
    right = passed == good
    results.setdefault(name, [0, 0])
    results[name][0] += int(right)
    results[name][1] += 1
    print(f"{name:17} {str(good):6} {score:5.2f} {str(passed):6}  {kind}: {answer[:50]!r}{'' if right else '   <-- WRONG'}", flush=True)

print()
for name, (right, total) in results.items():
    print(f"{name:17} agrees with the label on {right} of {total} cases")

db = clickhouse_connect.get_client(host="localhost", port=8123, username="default", password="dev")
print("\ntokens per metric run (judge model", JUDGE_MODEL + "):")
rows = db.query(
    "SELECT splitByChar(':', scored_span_id)[2] AS metric, count() AS calls, sum(total_tokens) AS tokens, "
    "round(sum(total_tokens) / uniqExact(scored_span_id)) AS tokens_per_case "
    "FROM otel.judge_usage WHERE job = 'measure' AND scored_span_id LIKE 'measure:%' AND created_at > now() - INTERVAL 1 HOUR "
    "GROUP BY metric"
).result_rows
for metric, calls, tokens, per_case in rows:
    print(f"  {metric:17} {calls:3} judge calls, {tokens:6} tokens total, about {per_case} tokens per case")
