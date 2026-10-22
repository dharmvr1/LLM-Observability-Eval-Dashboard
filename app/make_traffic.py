# A tiny chatbot that answers from a given context. It exists only to create traffic
# for the eval job to score. Some questions are NOT answerable from the context, which
# tempts the model to invent facts (the faithfulness eval should catch that).
import os
import time

from openai import OpenAI
from traceloop.sdk import Traceloop

os.environ["TRACELOOP_METRICS_ENABLED"] = "false"
Traceloop.init(app_name="support-bot", api_endpoint="http://localhost:4318", disable_batch=True)

client = OpenAI(base_url="https://api.groq.com/openai/v1", api_key=os.environ["GROQ_API_KEY"])
MODEL = "openai/gpt-oss-20b"

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

for user_id, context, question in items:
    Traceloop.set_association_properties({"user_id": user_id})
    messages = [
        {"role": "system", "content": "Answer the question using this context:\n" + context},
        {"role": "user", "content": question},
    ]
    r = client.chat.completions.create(model=MODEL, messages=messages)
    print(user_id, "|", question, "->", r.choices[0].message.content[:80].replace("\n", " "))
    time.sleep(1)
