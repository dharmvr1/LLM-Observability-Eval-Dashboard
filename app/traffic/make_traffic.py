# A tiny chatbot that answers from a given context. It exists only to create traffic
# for the eval job to score. Some questions are NOT answerable from the context, which
# tempts the model to invent facts (the faithfulness eval should catch that).
#
# This version calls Claude Haiku 4.5 on AWS Bedrock (using the Bedrock API key in .env).
# Bedrock's current Claude models are only reachable through the native `converse` API, not
# the OpenAI-compatible endpoint, so we cannot lean on the openai auto-instrumentor here.
# The Bedrock auto-instrumentor records only the model name (no tokens, no prompt/answer text),
# which the eval/PII/drift jobs need, so we block it and build one rich span per call ourselves.
import json
import os
import time

import boto3
from traceloop.sdk import Traceloop
from traceloop.sdk.instruments import Instruments

os.environ["TRACELOOP_METRICS_ENABLED"] = "false"
os.environ["AWS_EC2_METADATA_DISABLED"] = "true"  # we use a bearer token; skip the EC2 metadata probe (it errors + makes a noisy span)
os.environ["AWS_BEARER_TOKEN_BEDROCK"] = os.environ["BEADROCK_API_KEY"]  # boto3 reads the Bedrock API key from here

# Block Bedrock's own instrumentor (thin spans, no tokens/text) and boto3's HTTP instrumentors,
# so each call produces exactly one span: the rich one we fill in below.
Traceloop.init(
    app_name="support-bot",
    api_endpoint="http://localhost:4318",
    disable_batch=True,
    block_instruments={Instruments.BEDROCK, Instruments.REQUESTS, Instruments.URLLIB3},
)

from opentelemetry import trace  # noqa: E402  (import after Traceloop.init sets up the tracer provider)

tracer = trace.get_tracer("make_traffic")

REGION = "us-east-1"
MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0"  # cross-region inference profile (bare id is not invokable)
bedrock = boto3.client("bedrock-runtime", region_name=REGION)

REFUND = "Refunds are allowed within 30 days of purchase. Digital downloads cannot be refunded once opened."
SHIPPING = "Standard shipping takes 5 to 7 business days. Express shipping takes 2 days and costs 15 dollars."
HOURS = "The support desk is open Monday to Friday, 9am to 5pm Eastern Time. It is closed on weekends."

# (user_id, context, question)
items = [
    ("u_1", REFUND, "Can I get a refund after 3 weeks?"),
    ("u_1", REFUND, "Can I return an opened ebook?"),
    ("u_2", SHIPPING, "How long does express shipping take and what does it cost?"),
    ("u_2", SHIPPING, "Do you ship to Australia and how much is it?"),   # not in context
    ("u_3", HOURS, "Is support open on Saturday?"),
    ("u_3", HOURS, "What is the phone number for support?"),            # not in context
    ("u_3", HOURS, "What is the capital of France?"),                   # irrelevant question
]


def to_messages_json(pairs):
    """Turn a list of (role, content) tuples into the JSON string the jobs expect in
    gen_ai.input.messages / gen_ai.output.messages.

    The eval/PII/drift jobs parse it with this shape (see app/jobs/eval_job.py message_text):
        [{"role": "<role>", "parts": [{"content": "<text>"}]}, ...]
    """
    return json.dumps([{"role": role, "parts": [{"content": content}]} for role, content in pairs])


for user_id, context, question in items:
    Traceloop.set_association_properties({"user_id": user_id})  # tags the span below with this user
    with tracer.start_as_current_span("chat " + MODEL) as span:
        resp = bedrock.converse(
            modelId=MODEL,
            system=[{"text": context}],
            messages=[{"role": "user", "content": [{"text": question}]}],
            inferenceConfig={"maxTokens": 300, "temperature": 0.7},
        )
        answer = resp["output"]["message"]["content"][0]["text"]
        usage = resp["usage"]

        # The attributes the collector copies into the `spans` table (see sql/01_spans.sql).
        span.set_attribute("gen_ai.system", "aws.bedrock")
        span.set_attribute("gen_ai.request.model", MODEL)
        span.set_attribute("gen_ai.usage.input_tokens", usage["inputTokens"])
        span.set_attribute("gen_ai.usage.output_tokens", usage["outputTokens"])
        span.set_attribute("gen_ai.input.messages", to_messages_json([("system", context), ("user", question)]))
        span.set_attribute("gen_ai.output.messages", to_messages_json([("assistant", answer)]))

    print(user_id, "|", question, "->", answer[:80].replace("\n", " "))
    time.sleep(1)
